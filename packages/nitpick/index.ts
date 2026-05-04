import { resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isEditToolResult,
	isWriteToolResult,
} from "@mariozechner/pi-coding-agent";
import { ReviewerClient } from "./reviewer-client.js";
import {
	countChangedLines,
	hashContent,
	MAX_FILE_BYTES,
	MIN_CHANGED_LINES,
	reviewHasFindings,
	shouldReview,
} from "./tracker.js";

const EXT_ID = "nitpick";
const CUSTOM_TYPE = "nitpick-review";
const STATE_ENTRY = "nitpick-state";
const DEFAULT_MODEL = "claude-haiku-4-5";

interface NitpickState {
	enabled: boolean;
	model: string;
}

export default function (pi: ExtensionAPI) {
	// ---- Session-scoped state ----------------------------------------------
	let enabled = true;
	let model = DEFAULT_MODEL;

	/**
	 * True while the turn that nitpick itself triggered (via a follow-up
	 * message) is still in flight. While set, we drop all new review requests
	 * and suppress the next `agent_end` surface pass — this prevents a
	 * suggestion → edit → new review → new suggestion loop.
	 */
	let awaitingFollowUpTurn = false;

	/**
	 * The reviewer's most recent "complete current list" reply, updated each
	 * time a review() resolves with a non-empty body. This is what we bundle
	 * and inject back into the main agent at agent_end.
	 */
	let latestFindings = "";

	/**
	 * Per-file content-hash dedupe. Reset at each turn boundary (same time as
	 * the reviewer's conversation is reset) so identical content across turns
	 * is still reviewed fresh.
	 */
	const editHashes = new Map<string, string>();

	/** Most recent start/review error, for `/nitpick status` and `/nitpick show`. */
	let lastError: string | null = null;

	let reviewer: ReviewerClient | null = null;

	// ---- Persistence --------------------------------------------------------
	function persist(): void {
		pi.appendEntry(STATE_ENTRY, { enabled, model } satisfies NitpickState);
	}

	function hydrate(ctx: ExtensionContext): void {
		let latest: NitpickState | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				latest = entry.data as NitpickState;
			}
		}
		if (!latest) return;
		enabled = Boolean(latest.enabled);
		model = latest.model || DEFAULT_MODEL;
	}

	// ---- UI helpers ---------------------------------------------------------
	function refreshStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!enabled) {
			ctx.ui.setStatus(EXT_ID, undefined);
			return;
		}
		const active = reviewer?.activeReviews() ?? 0;
		if (active === 0) {
			ctx.ui.setStatus(EXT_ID, `nitpick: on (${model})`);
		} else {
			ctx.ui.setStatus(EXT_ID, `nitpick: reviewing ${active} file(s)`);
		}
	}

	function shortPath(absPath: string, cwd: string): string {
		if (absPath.startsWith(`${cwd}/`)) return absPath.slice(cwd.length + 1);
		return absPath;
	}

	function notifyError(ctx: ExtensionContext, message: string): void {
		lastError = message;
		if (!ctx.hasUI) return;
		const firstLine = message.split("\n")[0] ?? message;
		ctx.ui.notify(
			`nitpick: ${firstLine} (/nitpick status for details)`,
			"warning",
		);
	}

	// ---- Review scheduling --------------------------------------------------
	interface QueueArgs {
		absPath: string;
		diff?: string;
		content?: string;
		contentHash: string;
		ctx: ExtensionContext;
	}

	function queueReview(args: QueueArgs): void {
		if (!enabled) return;
		// Don't queue reviews for edits made during a nitpick-triggered follow-up
		// turn — the agent is applying our suggestions and we would loop on our
		// own output.
		if (awaitingFollowUpTurn) return;
		if (!shouldReview(args.absPath)) return;

		// Cheap early-outs: nothing interesting changed.
		if (args.diff && countChangedLines(args.diff) < MIN_CHANGED_LINES) return;
		if (args.content !== undefined && args.content.length > MAX_FILE_BYTES)
			return;

		// Same bytes as the last thing we sent to the reviewer for this file.
		// The reviewer would just re-emit whatever it already said, so skip.
		if (editHashes.get(args.absPath) === args.contentHash) return;
		editHashes.set(args.absPath, args.contentHash);

		if (!reviewer) reviewer = new ReviewerClient(model, args.ctx.cwd);
		const client = reviewer;

		refreshStatus(args.ctx);

		// Fire-and-forget. We await `reviewer.drain()` at agent_end, so the
		// promise chain inside ReviewerClient is our only synchronization.
		void client
			.review({
				path: args.absPath,
				diff: args.diff,
				content: args.content,
			})
			.then((result) => {
				if (result.error) {
					notifyError(
						args.ctx,
						`review failed for ${shortPath(args.absPath, args.ctx.cwd)} — ${result.error}`,
					);
				} else if (result.text) {
					// Every reply is the reviewer's full current list. The last one
					// wins; retractions happen naturally because the reviewer itself
					// drops bullets that later diffs invalidate.
					latestFindings = result.text;
					lastError = null;
				}
				refreshStatus(args.ctx);
			});
	}

	// ---- Surfacing ----------------------------------------------------------
	function formatBundle(findings: string): string {
		return [
			"The nitpick reviewer flagged the following simplifications on files you " +
				"edited this turn. Nitpick is suspended for the remainder of this turn, " +
				"so any edits you make now will NOT trigger another review — apply the " +
				"fixes decisively.",
			"",
			"For each bullet below:",
			"- If the suggestion is correct and preserves behavior, apply it directly " +
				"with edit/write. Do not ask for confirmation.",
			"- If the suggestion is wrong (misreads the code, changes behavior, is " +
				"outside the changed lines, or duplicates another bullet), skip it and " +
				"state in one sentence why.",
			"",
			"When you are done, report briefly which suggestions you applied and " +
				"which you skipped.",
			"",
			findings.trim(),
		].join("\n");
	}

	async function surfaceAndReset(ctx: ExtensionContext): Promise<void> {
		if (reviewer) await reviewer.drain();
		refreshStatus(ctx);

		if (reviewHasFindings(latestFindings)) {
			// Flip the suppression flag *before* triggering the follow-up turn so
			// any `tool_result` events from that turn are ignored.
			awaitingFollowUpTurn = true;
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: formatBundle(latestFindings),
					// Don't render the bundle in the TUI — the main agent's reply
					// will summarize what it applied and skipped.
					display: false,
					details: { findings: latestFindings },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}

		latestFindings = "";
		editHashes.clear();
		if (reviewer) await reviewer.reset();
		refreshStatus(ctx);
	}

	// ---- Lifecycle events ---------------------------------------------------
	pi.on("session_start", (_event, ctx) => {
		hydrate(ctx);
		refreshStatus(ctx);
		if (enabled && ctx.hasUI) {
			ctx.ui.notify(`nitpick active (${model})`, "info");
		}
	});

	pi.on("session_shutdown", () => {
		awaitingFollowUpTurn = false;
		latestFindings = "";
		editHashes.clear();
		void reviewer?.stop();
		reviewer = null;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!enabled || event.isError) return;

		if (isEditToolResult(event)) {
			const input = event.input as { path?: string };
			const diff = event.details?.diff;
			if (!input.path || !diff) return;
			const absPath = resolve(ctx.cwd, input.path);
			queueReview({
				absPath,
				diff,
				contentHash: hashContent(diff),
				ctx,
			});
			return;
		}

		if (isWriteToolResult(event)) {
			const input = event.input as { path?: string; content?: string };
			if (!input.path || input.content === undefined) return;
			const absPath = resolve(ctx.cwd, input.path);
			queueReview({
				absPath,
				content: input.content,
				contentHash: hashContent(input.content),
				ctx,
			});
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Consume the suppression flag on every agent_end so it only skips one
		// turn — the one nitpick itself kicked off.
		const wasSuppressed = awaitingFollowUpTurn;
		awaitingFollowUpTurn = false;
		if (!enabled) return;
		if (wasSuppressed) {
			refreshStatus(ctx);
			return;
		}
		await surfaceAndReset(ctx);
	});

	// ---- Commands -----------------------------------------------------------
	pi.registerCommand(EXT_ID, {
		description: "Control the nitpick simplification reviewer",
		getArgumentCompletions: (prefix: string) => {
			const opts = ["on", "off", "status", "show", "clear", "model"];
			const filtered = opts
				.filter((o) => o.startsWith(prefix))
				.map((o) => ({ value: o, label: o }));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const raw = args?.trim() ?? "";
			const [sub, ...rest] = raw.split(/\s+/);
			switch (sub) {
				case "":
				case "status": {
					const parts = [
						`enabled: ${enabled}`,
						`model: ${model}`,
						`client: ${reviewer?.isStarted() ? "warm" : "cold"}`,
						`active: ${reviewer?.activeReviews() ?? 0}`,
						`findings: ${latestFindings ? "yes" : "no"}`,
					];
					if (lastError) parts.push(`lastError: ${lastError.split("\n")[0]}`);
					ctx.ui.notify(`nitpick — ${parts.join(", ")}`, "info");
					return;
				}
				case "on": {
					enabled = true;
					persist();
					refreshStatus(ctx);
					ctx.ui.notify(`nitpick enabled (${model})`, "info");
					return;
				}
				case "off": {
					enabled = false;
					awaitingFollowUpTurn = false;
					latestFindings = "";
					editHashes.clear();
					void reviewer?.stop();
					reviewer = null;
					persist();
					refreshStatus(ctx);
					ctx.ui.notify("nitpick disabled", "info");
					return;
				}
				case "clear": {
					latestFindings = "";
					editHashes.clear();
					lastError = null;
					// Reset conversation but keep the process warm if we have one.
					void reviewer?.reset();
					refreshStatus(ctx);
					ctx.ui.notify("nitpick state cleared", "info");
					return;
				}
				case "model": {
					const next = rest.join(" ").trim();
					if (!next) {
						ctx.ui.notify(`nitpick model: ${model}`, "info");
						return;
					}
					model = next;
					persist();
					// Existing client was spawned with the old model; tear it down
					// so the next review lazily starts one with the new model.
					if (reviewer) {
						await reviewer.stop();
						reviewer = null;
					}
					refreshStatus(ctx);
					ctx.ui.notify(`nitpick model → ${model}`, "info");
					return;
				}
				case "show": {
					if (lastError) {
						ctx.ui.notify(`nitpick error — ${lastError}`, "warning");
						return;
					}
					if (!latestFindings) {
						ctx.ui.notify("nitpick: no findings yet this turn", "info");
						return;
					}
					ctx.ui.notify(`nitpick findings:\n${latestFindings}`, "info");
					return;
				}
				default: {
					ctx.ui.notify(`nitpick: unknown subcommand "${sub}"`, "warning");
				}
			}
		},
	});

	// ---- CLI flag -----------------------------------------------------------
	pi.registerFlag("nitpick", {
		description:
			"Control the nitpick simplification reviewer (default: on). Pass --nitpick=false to disable.",
		type: "boolean",
		default: true,
	});

	// Check the flag during session_start, once the runner is up.
	pi.on("session_start", (_event, ctx) => {
		const flag = pi.getFlag("nitpick");
		if (flag === false) {
			enabled = false;
			void reviewer?.stop();
			reviewer = null;
			persist();
			refreshStatus(ctx);
		} else if (flag === true) {
			enabled = true;
			persist();
			refreshStatus(ctx);
		}
	});
}
