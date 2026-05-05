import { RpcClient } from "@mariozechner/pi-coding-agent";

/**
 * Shared "spawn a one-shot read-only subagent, send it a task, collect
 * its reply, tear it down" primitive.
 *
 * Used by `/review`'s seven-specialist fan-out and `/verify`'s
 * per-step fan-out. Both want the same lifecycle:
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
	 * `/review` for `ReviewerRole`, by `/verify` for plan-step numbers.
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
	 * `waitForIdle` timeout in milliseconds. When unset, the
	 * underlying `RpcClient` falls back to its 60s default.
	 *
	 * Callers that batch a lot of work into one subagent (e.g.
	 * `/verify`'s single-subagent fan-in over a long plan) should
	 * scale this with payload size: 60s is plenty for a 1-step
	 * verify, but a 13-step plan with a large embedded diff
	 * routinely needs 4–5 minutes against a fast-tier model.
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
		args: [
			"--no-session",
			"--tools",
			tools,
			"--append-system-prompt",
			input.systemPromptPath,
		],
	});

	const aborted = new Promise<never>((_resolve, reject) => {
		if (!input.signal) return;
		if (input.signal.aborted) {
			reject(new Error("aborted"));
			return;
		}
		input.signal.addEventListener("abort", () => reject(new Error("aborted")), {
			once: true,
		});
	});

	try {
		await Promise.race([client.start(), aborted]);
	} catch (err) {
		await tryStop(client);
		return {
			tag: input.tag,
			rawText: "",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	try {
		await Promise.race([client.prompt(input.task), aborted]);
		await awaitIdleOrAbort(client, input.timeoutMs, aborted);
		const raw = (await client.getLastAssistantText()) ?? "";
		return { tag: input.tag, rawText: raw };
	} catch (err) {
		return {
			tag: input.tag,
			rawText: "",
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		await tryStop(client);
	}
}

/**
 * Run many subagents in parallel, capping concurrency at `maxParallel`.
 * Returns outcomes in the same order as inputs. If `maxParallel` is
 * undefined or `>= inputs.length`, all subagents run simultaneously.
 *
 * Used by `/verify` to bound the fan-out cost on long plans (default
 * cap 15 in `/verify`'s settings). `/review` runs all seven reviewers
 * in parallel via this helper too — the cap just isn't reached for
 * `/review`'s fixed 7-reviewer set.
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
			results[i] = await runSubagent(inputs[i]!);
		}
	}
	await Promise.all(Array.from({ length: cap }, () => worker()));
	return results;
}

async function tryStop(client: RpcClient): Promise<void> {
	try {
		await client.stop();
	} catch {
		/* best-effort shutdown */
	}
}

// ---- Idle-await helper ------------------------------------------------
//
// Extracted so callers can unit-test that `runSubagent` actually
// forwards their `timeoutMs` into `RpcClient.waitForIdle`. A typo or
// refactor accident that dropped the argument here would silently
// re-introduce the post-PR-#27 60s timeout regression on `/verify`.
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
