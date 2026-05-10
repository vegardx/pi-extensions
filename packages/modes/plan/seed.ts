/**
 * Plan-doc seed for per-phase auto sessions.
 *
 * When `/implement` activates a phase, modes calls `ctx.newSession({
 * setup })` to create a clean auto session for that phase. The `setup`
 * callback runs `seedPlanDoc(sm, plan, phase)`, which writes a single
 * custom message entry containing a deterministic render of the plan
 * doc plus an instruction footer.
 *
 * Why this matters:
 *
 *   - The agent walks into the phase pre-loaded with the plan's shape:
 *     every phase's id, status, title, goal, and (for shipped phases)
 *     PR number and `phase.summary`. Carry-forward summaries let phase
 *     N learn from phase N-1's discoveries without ingesting the raw
 *     auto-session.
 *
 *   - The seed text is byte-stable for a given plan input, so the
 *     prompt cache hits across phases on the stable prefix.
 *
 *   - No LLM call. Deterministic render; runs synchronously inside
 *     `setup`.
 *
 * The seed entry's `customType` is `modes:plan-seed` so the auto
 * session can identify it later (e.g. for footer bucket accounting,
 * see Phase 2 audit task).
 */

import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { Plan, Phase as PlanPhase } from "./schema.js";

/** customType tag for the seed entry. */
export const PLAN_SEED_CUSTOM_TYPE = "modes:plan-seed";

/**
 * Indent each non-empty line of `text` by `indent` spaces. Used to
 * inline `phase.summary` blocks under their phase bullet.
 */
function indentLines(text: string, indent: number): string {
	const pad = " ".repeat(indent);
	return text
		.split("\n")
		.map((line) => (line.length === 0 ? line : pad + line))
		.join("\n");
}

/**
 * Render the plan doc as the seed text. Pure, deterministic, byte-stable
 * for stable input. Layout:
 *
 *     ## Plan: <title> (slug: <slug>)
 *     - `p-1` [shipped] PR #N — title: goal
 *       Summary:
 *         <phase.summary, indented; omitted if not set>
 *     - `p-2` [active]         — title: goal     ← THIS PHASE
 *       Tasks:
 *         - [ ] task 1 title
 *         - [x] task 2 title
 *     - `p-3` [planned]        — title: goal
 *
 *     You are working on phase `p-2`. Only execute its tasks. When all
 *     tasks are done, run `/ship` — do NOT start the next phase.
 */
export function renderPlanSeed(plan: Plan, activePhase: PlanPhase): string {
	const lines: string[] = [`## Plan: ${plan.title} (slug: ${plan.slug})`];

	for (const phase of plan.phases) {
		const isActive = phase.id === activePhase.id;
		const pr = phase.prNumber !== undefined ? ` PR #${phase.prNumber}` : "";
		const marker = isActive ? "     ← THIS PHASE" : "";
		lines.push(
			`- \`${phase.id}\` [${phase.status}]${pr} — ${phase.title}: ${phase.goal}${marker}`,
		);

		if (phase.status === "shipped" && phase.summary) {
			lines.push("  Summary:");
			lines.push(indentLines(phase.summary, 4));
		}

		if (isActive && phase.tasks.length > 0) {
			lines.push("  Tasks:");
			for (const task of phase.tasks) {
				const box = task.done ? "[x]" : "[ ]";
				lines.push(`    - ${box} ${task.title}`);
			}
		}
	}

	lines.push("");
	lines.push(
		`You are working on phase \`${activePhase.id}\`. Only execute its tasks. When all`,
		"tasks are done, run `/ship` — do NOT start the next phase.",
	);

	return lines.join("\n");
}

/**
 * Write the plan-doc seed as a single custom message entry on `sm`.
 * Called from inside `ctx.newSession({ setup })`.
 *
 * `display: false` keeps the seed out of the TUI — it's prompt-prefix
 * scaffolding, not user-facing content.
 */
export function seedPlanDoc(
	sm: SessionManager,
	plan: Plan,
	activePhase: PlanPhase,
): void {
	const text = renderPlanSeed(plan, activePhase);
	sm.appendCustomMessageEntry(PLAN_SEED_CUSTOM_TYPE, text, false, {
		planSlug: plan.slug,
		phaseId: activePhase.id,
	});
}
