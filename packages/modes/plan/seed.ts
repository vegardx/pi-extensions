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
import {
	deliverables,
	effectiveWorkItemKind,
	gatingTasks,
	ownWorkItems,
	type Plan,
	type Deliverable as PlanPhase,
} from "./schema.js";
import { topLevelLeaves } from "./tree.js";

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
 *     - Phase `1` [shipped] PR #N — title: goal
 *       Summary:
 *         <phase.summary, indented; omitted if not set>
 *     - Phase `2` [active]         — title: goal     ← THIS PHASE
 *       Deliverables (your work; tick each as you finish):
 *         - [ ] task 1 title
 *         - [x] task 2 title
 *       Notes (informational; not for you to tick):
 *         - [?] open question title
 *         - [!] manual smoke step title
 *         - [~] follow-up to file later
 *     - Phase `3` [planned]        — title: goal
 *
 *     Plan-level follow-ups (not gating any phase):
 *       - [~] cross-cutting follow-up
 *
 *     You are working on Phase `2`. Only execute its deliverables. When
 *     all deliverables are done, run `/ship` — do NOT start the next
 *     phase. Notes are reviewer-facing and surface in the PR body; do
 *     not tick them.
 */
export function renderPlanSeed(plan: Plan, activePhase: PlanPhase): string {
	const lines: string[] = [`## Plan: ${plan.title} (slug: ${plan.slug})`];

	for (const phase of deliverables(plan)) {
		const isActive = phase.id === activePhase.id;
		const pr = phase.prNumber !== undefined ? ` PR #${phase.prNumber}` : "";
		const marker = isActive ? "     ← THIS PHASE" : "";
		const lifecycle = phase.lifecycle;
		const kindMarker = lifecycle ? ` [${lifecycle}]` : "";
		lines.push(
			`- Deliverable \`${phase.id}\`${kindMarker} [${phase.status}]${pr} — ${phase.title}: ${phase.body}${marker}`,
		);

		if (phase.status === "shipped" && phase.summary) {
			lines.push("  Summary:");
			lines.push(indentLines(phase.summary, 4));
		}

		// Surface pre/post tasks even when not active so the agent has
		// the manual checklist visible without a side-load. Always
		// rendered as `[!]` (manual) regardless of declared task kind —
		// pre/post tasks are reviewer-facing, not agent work.
		const items = ownWorkItems(phase);
		if (lifecycle && items.length > 0) {
			lines.push(
				lifecycle === "pre"
					? "  Preflight (manual; user ticks before regular phases proceed):"
					: "  Handover (manual; user completes after last regular phase ships):",
			);
			for (const task of items) {
				const box = task.done ? "[x]" : "[!]";
				lines.push(`    - ${box} ${task.title}`);
			}
		}

		if (isActive && !lifecycle && items.length > 0) {
			// Split by kind so the agent gets a clean signal: deliverables
			// are its work; question / manual / followUp tasks are
			// reviewer-facing notes that surface in the PR body and must
			// not be ticked off.
			const gating = gatingTasks(phase);
			const notes = items.filter((t) => effectiveWorkItemKind(t) !== "task");

			if (gating.length > 0) {
				lines.push("  Tasks (your work; tick each as you finish):");
				for (const task of gating) {
					const box = task.done ? "[x]" : "[ ]";
					lines.push(`    - ${box} ${task.title}`);
				}
			}

			if (notes.length > 0) {
				lines.push("  Notes (informational; not for you to tick):");
				for (const task of notes) {
					const kind = effectiveWorkItemKind(task);
					const kindMarker =
						kind === "question" ? "[?]" : kind === "manual" ? "[!]" : "[~]";
					lines.push(`    - ${kindMarker} ${task.title} (${kind})`);
				}
			}
		}
	}

	const looseLeaves = topLevelLeaves(plan);
	if (looseLeaves.length > 0) {
		lines.push("");
		lines.push("Plan-level loose items (not gating any deliverable):");
		for (const task of looseLeaves) {
			const kind = effectiveWorkItemKind(task);
			const kindMarker =
				kind === "question"
					? "[?]"
					: kind === "manual"
						? "[!]"
						: kind === "followup"
							? "[~]"
							: task.done
								? "[x]"
								: "[ ]";
			lines.push(`  - ${kindMarker} ${task.title} (${kind})`);
		}
	}

	lines.push("");
	lines.push(
		`You are working on deliverable \`${activePhase.id}\`. Only execute its tasks. When`,
		"all tasks are done, run `/ship` — do NOT start the next deliverable.",
		"Notes are reviewer-facing and surface in the PR body; do not tick them.",
		"",
		"Route commit/push/PR work through `/commit` and `/ship` so plan state stays in sync.",
		"Don't shell out to `git commit`, `git push`, or `gh pr create` directly while a phase is active —",
		"those bypass the plan's prNumber/status tracking. If you already did, run `/sync` to reconcile.",
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
