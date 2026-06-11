/**
 * The generic `delegate` tool. Resolves the `to` parameter against the
 * shared delegate-target registry, gates execution behind the
 * counting semaphore, and caps the answer before it crosses back into
 * the caller's context.
 *
 * Built as a plain `ToolDefinition` factory so tests can exercise it
 * without a pi host: inject targets via the registry, call `execute`
 * directly.
 */

import type {
	ExtensionContext,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import {
	availableDelegateTargets,
	type DelegateTarget,
	getDelegateTarget,
} from "@vegardx/pi-extensions-shared/delegate-registry.js";
import {
	capDelegatedAnswer,
	readDelegateMaxChars,
	readDelegateMaxConcurrent,
} from "./config.js";
import { type Semaphore, SemaphoreAbortedError } from "./semaphore.js";

export const delegateParams = Type.Object({
	to: Type.String({
		description:
			'Name of the specialist target (e.g. "researcher"). An unknown ' +
			"name returns the list of available targets.",
	}),
	message: Type.String({
		description: "The question or task to delegate.",
	}),
	params: Type.Optional(
		Type.Any({
			description:
				"Target-specific structured parameters; see the target's docs. " +
				"Most targets only need `message`.",
		}),
	),
	async: Type.Optional(
		Type.Boolean({
			description:
				"Return a job id immediately instead of blocking; the answer is " +
				"delivered to the conversation as a follow-up message when ready.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Hard timeout in ms for the delegated work.",
		}),
	),
});

export type DelegateParams = Static<typeof delegateParams>;

export interface DelegateToolDeps {
	/** Concurrency gate shared with the async job dispatcher. */
	semaphore: Semaphore;
	/** Enqueue an async job; returns the job id synchronously. */
	submitJob(req: {
		target: DelegateTarget;
		message: string;
		params?: unknown;
		timeoutMs?: number;
		limit: number;
		capChars: number;
		ctx: ExtensionContext;
	}): { id: string };
}

interface DelegateDetails {
	to: string;
	jobId?: string;
	error?: string;
	available?: string[];
	result?: unknown;
}

function listAvailable(ctx: ExtensionContext): string {
	const targets = availableDelegateTargets(ctx);
	if (targets.length === 0) {
		return "No delegate targets are registered in this session.";
	}
	const rows = targets.map((t) => `  "${t.name}" — ${t.description}`);
	return `Available targets:\n${rows.join("\n")}`;
}

function sanitizeTimeout(raw: number | undefined): number | undefined {
	if (raw != null && Number.isFinite(raw) && raw > 0) return raw;
	return undefined;
}

export function buildDelegateTool(
	deps: DelegateToolDeps,
): ToolDefinition<typeof delegateParams, DelegateDetails> {
	return {
		name: "delegate",
		label: "Delegate",
		// Show the target + message instead of a bare "Delegate", so a row
		// of concurrent delegate calls is self-describing in the transcript.
		renderCall: (args, theme) => {
			const to =
				typeof args?.to === "string" && args.to.trim() ? args.to.trim() : "?";
			const q =
				typeof args?.message === "string"
					? args.message.replace(/\s+/g, " ").trim()
					: "";
			const prefix = `Delegate → ${to}`;
			return {
				render(width: number): string[] {
					const styledPrefix = theme.fg("toolTitle", theme.bold(prefix));
					if (!q) return [truncateToWidth(styledPrefix, width, "…")];
					const avail = Math.max(8, width - prefix.length - 2);
					const qShort = q.length > avail ? `${q.slice(0, avail - 1)}…` : q;
					return [
						truncateToWidth(
							styledPrefix + theme.fg("muted", `: ${qShort}`),
							width,
							"…",
						),
					];
				},
				invalidate(): void {},
			};
		},
		description:
			"Delegate a question or task to a named specialist sub-agent and " +
			"get back a concise, distilled answer. The sub-agent's raw work " +
			"never enters your context — you only receive the answer. Blocking " +
			"by default; pass async:true to get a job id immediately and the " +
			"answer as a follow-up message when ready. Fire several delegate " +
			"calls in one turn to run them concurrently. An unknown `to` " +
			"returns the list of available targets.",
		promptSnippet:
			"Delegate a task to a specialist target; returns a distilled answer",
		promptGuidelines: [
			"Use delegate to push heavy work (web search, codebase " +
				"exploration, reviews) into a sub-agent so its raw output never " +
				"bloats your context — you receive only the distilled answer.",
			"delegate blocks until the answer returns unless async:true. Emit " +
				"multiple delegate calls in a single turn to run them in parallel.",
		],
		parameters: delegateParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const to = params.to.trim();
			const target = getDelegateTarget(to);
			if (!target) {
				return {
					content: [
						{
							type: "text",
							text: `[delegate] unknown target "${to}". ${listAvailable(ctx)}`,
						},
					],
					details: {
						to,
						error: "unknown-target",
						available: availableDelegateTargets(ctx).map((t) => t.name),
					},
				};
			}
			if (!(target.isAvailable?.(ctx) ?? true)) {
				return {
					content: [
						{
							type: "text",
							text: `[delegate] target "${to}" is not available right now. ${listAvailable(ctx)}`,
						},
					],
					details: {
						to,
						error: "target-unavailable",
						available: availableDelegateTargets(ctx).map((t) => t.name),
					},
				};
			}

			const timeoutMs = sanitizeTimeout(params.timeoutMs);
			const capChars = readDelegateMaxChars(ctx.cwd);
			const limit = readDelegateMaxConcurrent(ctx.cwd);

			if (params.async) {
				const { id } = deps.submitJob({
					target,
					message: params.message,
					params: params.params,
					timeoutMs,
					limit,
					capChars,
					ctx,
				});
				return {
					content: [
						{
							type: "text",
							text:
								`[delegate] queued job ${id} → ${to}. The answer will be ` +
								"delivered as a follow-up message when ready.",
						},
					],
					details: { to, jobId: id },
				};
			}

			let release: (() => void) | null = null;
			try {
				release = await deps.semaphore.acquire({ limit, signal });
			} catch (err) {
				if (err instanceof SemaphoreAbortedError) {
					return {
						content: [
							{
								type: "text",
								text: capDelegatedAnswer(
									`[delegate ${to} error] ${err.message}`,
									capChars,
								),
							},
						],
						details: { to, error: "aborted-while-queued" },
					};
				}
				throw err;
			}
			try {
				const result = await target.execute({
					message: params.message,
					params: params.params,
					ctx,
					signal,
					timeoutMs,
				});
				const text = capDelegatedAnswer(result.text, capChars);
				return {
					content: [{ type: "text", text }],
					details:
						result.details !== undefined
							? { to, result: result.details }
							: { to },
				};
			} catch (err) {
				// Targets are expected to return failures as text, but the host
				// still guards: a throw becomes a structured error result.
				const detail = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: capDelegatedAnswer(
								`[delegate ${to} error] ${detail}`,
								capChars,
							),
						},
					],
					details: { to, error: detail },
				};
			} finally {
				release();
			}
		},
	};
}
