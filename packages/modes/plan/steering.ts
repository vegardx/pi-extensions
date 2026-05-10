/**
 * Steering-message preamble for auto mode.
 *
 * When the user types a message during /implement (auto mode), pi delivers
 * it as the most recent and most specific instruction in context. The
 * agent reliably pivots to that message even when it's tangential to the
 * active phase — recency and specificity beat the system prompt's
 * "work the plan" framing.
 *
 * This module produces a preamble that wraps the user's message with the
 * current phase/task context and four routing options, so the agent has
 * to *decide* whether the message refines the plan or interrupts it,
 * instead of silently steamrolling whatever it was doing.
 *
 * The wrapper is only applied in auto mode while a plan with an active
 * (or needs-attention) phase exists. Slash commands, skill invocations,
 * extension-injected messages, and empty input pass through unchanged.
 */

import type { Phase, Plan } from "./schema.js";
import { WORKTREE_STATUSES } from "./schema.js";

export type SteeringSource = "interactive" | "rpc" | "extension";
export type SteeringMode = "plan" | "ask" | "auto" | "hack";

export interface SteeringInput {
	text: string;
	source: SteeringSource;
	mode: SteeringMode | null;
	plan: Plan | null;
}

function inflightPhase(plan: Plan): Phase | null {
	return plan.phases.find((p) => WORKTREE_STATUSES.includes(p.status)) ?? null;
}

function renderTaskList(phase: Phase): string {
	if (phase.tasks.length === 0) return "  (no tasks yet)";
	return phase.tasks
		.map((t) => `  ${t.done ? "✓" : "○"} ${t.id} — ${t.title}`)
		.join("\n");
}

/**
 * Build the wrapped message text. Returns null when the message should
 * pass through unchanged (default behaviour for everything outside auto
 * mode with an in-flight phase).
 */
export function buildSteeringPreamble(input: SteeringInput): string | null {
	if (input.mode !== "auto") return null;
	if (input.source === "extension") return null;
	const text = input.text;
	if (text.trim().length === 0) return null;
	// Slash commands, skills, and templates are routed by pi before the
	// agent sees them — wrapping would corrupt that routing.
	if (text.trimStart().startsWith("/")) return null;
	if (!input.plan) return null;
	const phase = inflightPhase(input.plan);
	if (!phase) return null;

	const preamble = [
		"[modes: steering message — before acting, classify it:",
		"  1. refines an active task → plan_task(update, ...) and continue",
		"  2. is a new task in the active phase → plan_task(add, ...) and continue",
		"  3. is a new phase → plan_phase(add, ...) and continue current phase",
		"  4. is an immediate course correction to the work in flight → act on it now",
		"State the chosen option in one line, then proceed.",
		`Active phase: ${phase.id} — ${phase.title} (${phase.status})`,
		"Tasks:",
		renderTaskList(phase),
		"]",
		"",
		text,
	].join("\n");

	return preamble;
}
