import { RpcClient } from "@mariozechner/pi-coding-agent";

/**
 * Shared "spawn a one-shot read-only subagent, send it a task, collect
 * its reply, tear it down" primitive.
 *
 * Used by `/review`'s eight-specialist fan-out. Both `/review` and
 * future callers want the same lifecycle:
 *
 *   - Start an RPC pi instance with `--mode rpc --no-session`.
 *   - Restrict its tool set to read-only (the subagent observes;
 *     mutating callers stay in the host agent).
 *   - Append a system prompt (typically a markdown file shipped with
 *     the calling extension) so the subagent knows what shape of
 *     output to produce.
 *   - Prompt with the task payload.
 *   - Wait for completion, capture the assistant's last text reply.
 *   - Stop the client.
 *
 * Output parsing is the caller's job — different consumers want
 * different JSON shapes. This module returns the raw text plus any
 * lifecycle error and lets callers decide how to interpret it.
 */

export interface SubagentTask<Tag = string> {
	/**
	 * Caller-defined identifier carried through to the result. Used by
	 * `/review` for `ReviewerRole`.
	 */
	tag: Tag;
	/** Pre-assembled markdown payload sent to the subagent. */
	task: string;
	/** Path to the markdown system prompt file. Caller resolves. */
	systemPromptPath: string;
	/**
	 * Tool set the subagent may use. Defaults to read-only.
	 * Mutating tools are deliberately excluded — subagents observe
	 * and report; callers in the host agent apply changes.
	 */
	tools?: readonly string[];
	provider: string;
	model: string;
	cwd: string;
	/** Abort signal wired to the active agent turn, if any. */
	signal?: AbortSignal;
	/**
	 * End-to-end deadline in milliseconds. The deadline covers startup,
	 * prompt delivery, idle wait, answer capture, and best-effort shutdown.
	 * When unset, the underlying `RpcClient.waitForIdle` fallback is still
	 * used for the idle phase, but startup/prompt/shutdown get local caps.
	 */
	timeoutMs?: number;
}

export interface SubagentOutcome<Tag = string> {
	tag: Tag;
	/** The subagent's last assistant text. Empty string when nothing was produced. */
	rawText: string;
	/**
	 * Populated when the subagent failed to start, crashed, the prompt
	 * threw, or the abort signal fired. When present, `rawText` should
	 * be treated as untrustworthy.
	 */
	error?: string;
}

const DEFAULT_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
const DEFAULT_STEP_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 2_000;

export interface SubagentClient {
	start(): Promise<void>;
	prompt(task: string): Promise<void>;
	waitForIdle(timeoutMs?: number): Promise<void>;
	getLastAssistantText(): Promise<string | null | undefined>;
	stop(): Promise<void>;
}

/**
 * Spawn one subagent, send the task, collect the reply, tear down.
 * Catches all errors and returns them in `outcome.error` so callers
 * can keep parallel fan-outs going even when one subagent fails.
 */
export async function runSubagent<Tag>(
	input: SubagentTask<Tag>,
): Promise<SubagentOutcome<Tag>> {
	const cliPath = process.argv[1];
	if (!cliPath) {
		return {
			tag: input.tag,
			rawText: "",
			error: "could not locate pi cli entry point",
		};
	}

	const tools = (input.tools ?? DEFAULT_TOOLS).join(",");
	const client = new RpcClient({
		cliPath,
		cwd: input.cwd,
		provider: input.provider,
		model: input.model,
		// Mark this child as a subagent so every extension wrapped by our
		// `defineExtension` opts out (see resolveEnabled): modes never boots,
		// so no plan-minting, tool-whitelist override, or recursive spawning.
		// External provider extensions (backing `backgroundModels.*`) and
		// `--extension` paths stay loaded. Re-enable a specific extension in a
		// subagent via `PI_EXT_<NAME>=on` if ever needed.
		env: { PI_SUBAGENT: "1" },
		args: [
			"--no-session",
			"--tools",
			tools,
			"--append-system-prompt",
			input.systemPromptPath,
		],
	});

	return runSubagentWithClient(input, client);
}

export async function runSubagentWithClient<Tag>(
	input: SubagentTask<Tag>,
	client: SubagentClient,
): Promise<SubagentOutcome<Tag>> {
	const deadline = createDeadline(input.signal, input.timeoutMs);

	try {
		await runBounded("start", deadline, () => client.start());
	} catch (err) {
		await tryStop(client);
		deadline.dispose();
		return failure(input.tag, err);
	}

	try {
		await runBounded("prompt", deadline, () => client.prompt(input.task));
		await awaitIdleOrAbort(client, remainingMs(deadline), deadline.aborted);
		const raw =
			(await runBounded("getLastAssistantText", deadline, () =>
				client.getLastAssistantText(),
			)) ?? "";
		return { tag: input.tag, rawText: raw };
	} catch (err) {
		return failure(input.tag, err);
	} finally {
		await tryStop(client);
		deadline.dispose();
	}
}

function failure<Tag>(tag: Tag, err: unknown): SubagentOutcome<Tag> {
	return {
		tag,
		rawText: "",
		error: err instanceof Error ? err.message : String(err),
	};
}

interface Deadline {
	readonly aborted: Promise<never>;
	readonly signal?: AbortSignal;
	readonly expiresAt?: number;
	dispose(): void;
}

function createDeadline(
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): Deadline {
	const ctrl = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectAbort!: (err: Error) => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	aborted.catch(() => {});

	const abort = (reason: string) => {
		if (ctrl.signal.aborted) return;
		ctrl.abort();
		rejectAbort(new Error(reason));
	};

	const onAbort = () => abort("aborted");
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	const stepMs = timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
	const expiresAt = Date.now() + stepMs;
	timer = setTimeout(
		() => abort(`subagent timed out after ${stepMs}ms`),
		stepMs,
	);
	timer.unref?.();

	return {
		aborted,
		signal: ctrl.signal,
		expiresAt,
		dispose: () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

function remainingMs(deadline: Deadline): number | undefined {
	if (!deadline.expiresAt) return undefined;
	return Math.max(1, deadline.expiresAt - Date.now());
}

async function runBounded<T>(
	step: string,
	deadline: Deadline,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await Promise.race([fn(), deadline.aborted]);
	} catch (err) {
		if (err instanceof Error && err.message) throw err;
		throw new Error(`${step} failed: ${String(err)}`);
	}
}

/**
 * Run many subagents in parallel, capping concurrency at `maxParallel`.
 * Returns outcomes in the same order as inputs. If `maxParallel` is
 * undefined or `>= inputs.length`, all subagents run simultaneously.
 *
 * Used by callers that want to bound fan-out cost on large input sets.
 * `/review` runs all eight reviewers in parallel via this helper —
 * the cap is available for future consumers with variable-length inputs.
 */
export async function runSubagentsParallel<Tag>(
	inputs: readonly SubagentTask<Tag>[],
	opts: { maxParallel?: number } = {},
): Promise<SubagentOutcome<Tag>[]> {
	if (inputs.length === 0) return [];
	const cap =
		opts.maxParallel && opts.maxParallel > 0
			? Math.min(opts.maxParallel, inputs.length)
			: inputs.length;
	if (cap >= inputs.length) {
		return Promise.all(inputs.map(runSubagent));
	}

	const results = new Array<SubagentOutcome<Tag>>(inputs.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (true) {
			const i = next++;
			if (i >= inputs.length) return;
			const input = inputs[i];
			if (input === undefined) return;
			results[i] = await runSubagent(input);
		}
	}
	await Promise.all(Array.from({ length: cap }, () => worker()));
	return results;
}

async function tryStop(client: SubagentClient): Promise<void> {
	const stopDeadline = createDeadline(undefined, STOP_TIMEOUT_MS);
	try {
		await runBounded("stop", stopDeadline, () => client.stop());
	} catch {
		/* best-effort shutdown */
	} finally {
		stopDeadline.dispose();
	}
}

// ---- Idle-await helper ------------------------------------------------
//
// Extracted so callers can unit-test that `runSubagent` actually
// forwards their `timeoutMs` into `RpcClient.waitForIdle`. A typo or
// refactor accident that dropped the argument here would silently
// re-introduce the post-PR-#27 60s timeout regression on long-running
// review subagents.
//
// Loose on the input shape — takes a minimal `{ waitForIdle }`
// surface so tests can pass a spy without constructing a real
// `RpcClient`. Public `runSubagent` callers continue to pass the
// real client; the type narrows at the call site via structural
// typing.

/** Minimum surface `awaitIdleOrAbort` needs from its client argument. */
export interface IdleWaitable {
	waitForIdle(timeoutMs?: number): Promise<void>;
}

/**
 * Race `client.waitForIdle(timeoutMs)` against the abort promise.
 * Forwards `timeoutMs` verbatim — when `undefined`, `RpcClient`'s
 * own default (60s today) applies.
 */
export function awaitIdleOrAbort(
	client: IdleWaitable,
	timeoutMs: number | undefined,
	aborted: Promise<never>,
): Promise<void> {
	return Promise.race([client.waitForIdle(timeoutMs), aborted]);
}
