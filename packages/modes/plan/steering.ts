/**
 * Steering-message classifier for auto mode.
 *
 * When the user types a message during /implement (auto mode), pi delivers
 * it as the most recent and most specific instruction in context. The
 * agent reliably pivots to that message even when it's tangential to the
 * active phase — recency and specificity beat the system prompt's
 * "work the plan" framing.
 *
 * To force the agent to *decide* between (a) refining the plan, (b) adding
 * a task/phase, or (c) acting on it now, we inject a short routing
 * classifier on the next `before_agent_start`. The classifier is a hidden
 * customType message (display: false) — the user only sees their own text.
 *
 * The phase + task list is already injected by the auto-mode preamble in
 * `before_agent_start`, so this classifier deliberately does NOT repeat
 * it; the agent is told to consult the plan via `plan_view` if needed.
 *
 * Slash commands, skill invocations, extension-injected messages, and
 * empty input are never wrapped — see `shouldInjectSteeringClassifier`.
 */

import type { Phase, Plan } from "./schema.js";
import { WORKTREE_STATUSES } from "./schema.js";

export type SteeringSource = "interactive" | "rpc" | "extension";
export type SteeringMode = "plan" | "auto" | "hack";

export interface SteeringInput {
	text: string;
	source: SteeringSource;
	mode: SteeringMode | null;
	plan: Plan | null;
}

function inflightPhase(plan: Plan): Phase | null {
	return plan.phases.find((p) => WORKTREE_STATUSES.includes(p.status)) ?? null;
}

/**
 * Pure gate. True when the next `before_agent_start` should append the
 * routing classifier to the auto-mode preamble.
 *
 * Returns false for:
 *   - non-auto modes
 *   - extension-sourced messages (sendMessage / sendUserMessage)
 *   - empty / whitespace-only text
 *   - slash commands (skills, templates, /ship etc. — pi routes these)
 *   - no active plan
 *   - no in-flight phase
 *   - in-flight phase whose tasks are all complete (awaiting /ship —
 *     no routing decision left to make; classifier would only confuse)
 *
 * A phase with zero tasks defined is NOT skipped — the agent should
 * consider routing the message into a new task.
 */
export function shouldInjectSteeringClassifier(input: SteeringInput): boolean {
	if (input.mode !== "auto") return false;
	if (input.source === "extension") return false;
	const text = input.text;
	if (text.trim().length === 0) return false;
	if (text.trimStart().startsWith("/")) return false;
	if (!input.plan) return false;
	const phase = inflightPhase(input.plan);
	if (!phase) return false;
	if (phase.tasks.length > 0 && phase.tasks.every((t) => t.done)) return false;
	return true;
}

/**
 * Routing classifier appended to the auto-mode preamble when
 * `shouldInjectSteeringClassifier` returns true. Stable, parameter-free
 * so the prompt prefix stays byte-identical across turns and the prompt
 * cache keeps hitting.
 *
 * Refers the agent to `plan_view` rather than embedding the phase + task
 * list — the auto-mode preamble already carries that context, and
 * duplicating it costs tokens on every steering turn.
 */
export const STEERING_CLASSIFIER = [
	"The user just sent a free-text message. Before acting, classify it",
	"(consult plan_view if you need the current phase/task state):",
	"  1. refines an active task \u2192 plan_task(update, ...) and continue",
	"  2. new task in the active phase \u2192 plan_task(add, ...) and continue",
	"  3. new phase \u2192 plan_phase(add, ...) and continue current phase",
	"  4. immediate course correction \u2192 act on it now",
	"State the chosen option in one line, then proceed.",
].join("\n");
