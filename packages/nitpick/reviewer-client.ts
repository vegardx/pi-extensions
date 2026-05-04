import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@mariozechner/pi-coding-agent";

/**
 * Absolute path to the bundled reviewer system prompt. Resolved relative to
 * this module so it keeps working regardless of install location.
 */
const PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"simplify.md",
);

export interface ReviewerInput {
	/** Absolute path of the file that was changed. */
	path: string;
	/** Unified diff of the change (preferred). */
	diff?: string;
	/** Full file content (fallback when no diff is available, e.g. write tool). */
	content?: string;
}

export interface ReviewerResult {
	/**
	 * The reviewer's full current list of findings across every diff it has
	 * seen so far this turn. Empty string if the reviewer has not yet replied
	 * at all; the sentinel "No simplifications suggested." if it has replied
	 * but there is nothing to flag.
	 */
	text: string;
	/** Populated when the review could not be completed. */
	error?: string;
}

/**
 * Persistent subagent reviewer. Spawns one long-running `pi --mode rpc`
 * subprocess per session and feeds every file change into a single
 * conversation. The reviewer's system prompt instructs it to keep a running
 * list of findings and re-emit the complete current list on every reply —
 * which means later diffs can retract earlier suggestions (e.g. a helper
 * becoming multi-use invalidates an earlier "inline this" finding).
 *
 * Calls to `review()` are serialized internally via a promise tail. The
 * RPC subagent cannot process two turns of its own conversation
 * concurrently, so pipelining wouldn't buy us anything. The reviews do,
 * however, run *concurrently with the main agent*, which is the primary
 * latency win: by the time `agent_end` fires most reviews are already done.
 */
export class ReviewerClient {
	private client: RpcClient | null = null;
	private startPromise: Promise<void> | null = null;
	/** FIFO serialization chain for review()/reset() calls. */
	private tail: Promise<unknown> = Promise.resolve();
	private active = 0;
	private lastStartError: string | null = null;

	constructor(
		private readonly model: string,
		private readonly cwd: string,
	) {}

	activeReviews(): number {
		return this.active;
	}

	isStarted(): boolean {
		return this.client !== null;
	}

	/**
	 * Submit one diff to the reviewer. Resolves with the reviewer's *current
	 * complete list* (or an error). Safe to call concurrently — calls are
	 * serialized internally so each one sees the subagent's full prior
	 * context.
	 */
	async review(input: ReviewerInput): Promise<ReviewerResult> {
		this.active++;
		const next = this.tail
			.catch(() => undefined)
			.then(() => this.doReview(input))
			.finally(() => {
				this.active--;
			});
		this.tail = next.catch(() => undefined);
		return next;
	}

	/** Wait until every queued review() and reset() has completed. */
	async drain(): Promise<void> {
		await this.tail.catch(() => undefined);
	}

	/**
	 * Drop the subagent's conversation but keep the process warm. Call at the
	 * end of each main-agent turn so we do not carry findings (or token bloat)
	 * from one turn into the next.
	 */
	async reset(): Promise<void> {
		const next = this.tail.catch(() => undefined).then(() => this.doReset());
		this.tail = next.catch(() => undefined);
		return next;
	}

	/**
	 * Best-effort abort of the current in-flight review. Keeps the subagent
	 * process running so subsequent reviews don't pay another cold start.
	 */
	async abort(): Promise<void> {
		if (!this.client) return;
		try {
			await this.client.abort();
		} catch {
			/* ignore */
		}
	}

	/** Tear down the subagent process. Idempotent. */
	async stop(): Promise<void> {
		await this.drain();
		const c = this.client;
		this.client = null;
		this.startPromise = null;
		this.lastStartError = null;
		if (c) {
			try {
				await c.stop();
			} catch {
				/* ignore */
			}
		}
	}

	private async ensureStarted(): Promise<RpcClient> {
		if (this.client) return this.client;
		if (!this.startPromise) {
			this.startPromise = this.doStart();
		}
		await this.startPromise;
		if (!this.client) {
			// doStart stores the reason in lastStartError; surface it.
			throw new Error(
				this.lastStartError ?? "nitpick reviewer failed to start",
			);
		}
		return this.client;
	}

	private async doStart(): Promise<void> {
		const cliPath = process.argv[1];
		if (!cliPath) {
			this.lastStartError = "could not locate pi cli entry point";
			return;
		}
		const client = new RpcClient({
			cliPath,
			cwd: this.cwd,
			model: this.model,
			args: [
				"--no-session",
				"--tools",
				"read,grep,find,ls",
				"--append-system-prompt",
				PROMPT_PATH,
			],
		});
		try {
			await client.start();
			this.client = client;
			this.lastStartError = null;
		} catch (err) {
			this.lastStartError = err instanceof Error ? err.message : String(err);
			// Leave a hint on stderr for debuggers running with --verbose.
			try {
				const stderr = client.getStderr?.();
				if (stderr) this.lastStartError += `\n${stderr.trim()}`;
			} catch {
				/* ignore */
			}
			this.client = null;
		}
	}

	private async doReview(input: ReviewerInput): Promise<ReviewerResult> {
		let client: RpcClient;
		try {
			client = await this.ensureStarted();
		} catch (err) {
			// On a hard start failure, poison the startPromise cache so the next
			// review() gets a clean retry instead of seeing the same error.
			this.startPromise = null;
			return {
				text: "",
				error: err instanceof Error ? err.message : String(err),
			};
		}

		try {
			await client.prompt(buildTask(input));
			await client.waitForIdle();
			const text = await client.getLastAssistantText();
			return { text: (text ?? "").trim() };
		} catch (err) {
			// The subagent likely died. Tear down so the next review starts clean.
			const message = err instanceof Error ? err.message : String(err);
			await this.stop();
			return { text: "", error: message };
		}
	}

	private async doReset(): Promise<void> {
		if (!this.client) return;
		try {
			await this.client.newSession();
		} catch {
			// If reset itself fails, tear down the client; next review will spawn
			// a fresh process. Cheaper than chasing an inconsistent subagent state.
			await this.stop();
		}
	}
}

function buildTask(input: ReviewerInput): string {
	const lines: string[] = [`File: ${input.path}`, ""];
	if (input.diff && input.diff.trim().length > 0) {
		lines.push("Unified diff of the change:");
		lines.push("```diff");
		lines.push(input.diff.trimEnd());
		lines.push("```");
	} else if (input.content !== undefined) {
		lines.push("No diff available. Full new content of the file:");
		lines.push("```");
		lines.push(input.content);
		lines.push("```");
	} else {
		lines.push("(no diff or content provided — nothing to review)");
	}
	lines.push("");
	lines.push(
		"Update your running list of findings in light of this change, then " +
			"output the complete current list per your system prompt (or the " +
			'"No simplifications suggested." sentinel if nothing currently applies).',
	);
	return lines.join("\n");
}
