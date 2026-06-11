/**
 * Pre-publish review loop for auto mode and fleet workers.
 *
 * Between "implementation finished" and "commit/ship", the worker
 * reviews its own diff via the `reviewer` delegate target:
 *
 *   review → high-confidence findings with fixes are auto-applied
 *   (queued to the agent + re-committed by the caller) → re-review →
 *   … up to `maxRounds`. Everything still surfaced at the end is
 *   returned so the caller can turn it into question work-items on
 *   the plan; the PR publishes regardless — review availability never
 *   blocks the fleet.
 *
 * Oscillation guard: a round only applies fixes that haven't been
 * applied before (fingerprint identity), and the loop stops early
 * when the surfaced set is unchanged AND no new fix was applied —
 * the review has reached a fixed point.
 *
 * Cross-extension discipline: only `import type` from pi-ext-review;
 * the reviewer is reached through the shared delegate registry, and
 * the registry probe is injected so tests run without it.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DelegateTarget } from "@vegardx/pi-extensions-shared/delegate-registry.js";
import type { OrchestratedFinding } from "pi-ext-review/findings";
import type { Deliverable, Plan, WorkItem } from "./schema.js";
import { deliverables, workItemId } from "./schema.js";
import { withPlanLock } from "./storage.js";

/** Local copy of the finding fingerprint (value imports are forbidden). */
export function findingFingerprint(f: {
	file: string;
	line?: number;
	title: string;
}): string {
	return `${f.file}:${f.line ?? 0}:${f.title.toLowerCase().trim()}`;
}

interface ReviewerDetails {
	ran?: boolean;
	autoApplied?: OrchestratedFinding[];
	surfaced?: OrchestratedFinding[];
}

export interface PrePublishReviewOpts {
	deliverable: Pick<Deliverable, "id" | "branch">;
	ctx: ExtensionContext;
	/** Registry probe — `() => getDelegateTarget("reviewer")` in prod. */
	getReviewer(): DelegateTarget | undefined;
	/**
	 * Queue a fix prompt to the agent and resolve once the fix turn has
	 * ended (the caller owns idle detection and re-committing).
	 */
	applyFix(prompt: string): Promise<void>;
	maxRounds?: number;
	signal?: AbortSignal;
	notify?(message: string, level: "info" | "warning"): void;
}

export interface PrePublishReviewResult {
	ran: boolean;
	/** Set when the loop didn't run; the caller publishes regardless. */
	skipReason?: "reviewer-absent" | "review-failed";
	rounds: number;
	/** Fixes handed to the agent across all rounds. */
	applied: OrchestratedFinding[];
	/** Findings still open after the last round → question work-items. */
	surfaced: OrchestratedFinding[];
}

/** Agent prompt applying a round's auto-fix batch. */
export function buildWorkerFixPrompt(
	findings: readonly OrchestratedFinding[],
): string {
	const lines = [
		"[pre-publish review]",
		"",
		"The review pipeline flagged the following high-confidence findings",
		"in the work you just finished. Apply each fix directly, then commit",
		"the fixes on the current branch (git add <paths> && git commit).",
		"",
	];
	findings.forEach((f, idx) => {
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		lines.push(
			`${idx + 1}. **[${f.severity}] \`${loc}\`** — ${f.title}`,
			`   - Why: ${f.description}`,
		);
		if (f.suggestedAction) lines.push(`   - Fix: ${f.suggestedAction}`);
		lines.push("");
	});
	lines.push("Finish the turn after committing the fixes.");
	return lines.join("\n");
}

export async function runPrePublishReview(
	opts: PrePublishReviewOpts,
): Promise<PrePublishReviewResult> {
	const maxRounds = opts.maxRounds ?? 2;
	const note = opts.notify ?? (() => {});
	const applied: OrchestratedFinding[] = [];
	const appliedFp = new Set<string>();
	let prevSurfacedFp: string | null = null;
	let surfaced: OrchestratedFinding[] = [];
	let rounds = 0;

	for (let round = 1; round <= maxRounds; round++) {
		const reviewer = opts.getReviewer();
		if (!reviewer) {
			// Soft-skip: never block the fleet on review availability.
			note(
				`pre-publish review skipped for \`${opts.deliverable.id}\` — reviewer target not registered`,
				"warning",
			);
			return {
				ran: false,
				skipReason: "reviewer-absent",
				rounds,
				applied,
				surfaced,
			};
		}
		rounds = round;
		let details: ReviewerDetails | undefined;
		try {
			const result = await reviewer.execute({
				message: `Review the diff of deliverable \`${opts.deliverable.id}\` before its PR publishes.`,
				params: { scope: "branch" },
				ctx: opts.ctx,
				signal: opts.signal,
			});
			details = result.details as ReviewerDetails | undefined;
		} catch {
			details = undefined;
		}
		if (!details?.ran) {
			note(
				`pre-publish review failed for \`${opts.deliverable.id}\` — publishing without it`,
				"warning",
			);
			return {
				ran: rounds > 1,
				skipReason: "review-failed",
				rounds,
				applied,
				surfaced,
			};
		}
		surfaced = details.surfaced ?? [];
		const surfacedFp = surfaced.map(findingFingerprint).sort().join("|");
		const toApply = (details.autoApplied ?? []).filter(
			(f) => !appliedFp.has(findingFingerprint(f)),
		);
		// Fixed point: nothing new to apply, or the surfaced set didn't
		// move and we'd just re-apply identical fixes. Includes the
		// applied-fix identity so an oscillating fix (apply → reverted by
		// the next round's "fix") can't ping-pong.
		if (toApply.length === 0) break;
		if (prevSurfacedFp !== null && surfacedFp === prevSurfacedFp) break;
		prevSurfacedFp = surfacedFp;
		note(
			`pre-publish review round ${round}: applying ${toApply.length} fix(es) on \`${opts.deliverable.id}\``,
			"info",
		);
		await opts.applyFix(buildWorkerFixPrompt(toApply));
		for (const f of toApply) {
			applied.push(f);
			appliedFp.add(findingFingerprint(f));
		}
		// Round maxRounds applied fixes but won't re-review — accepted.
	}
	return { ran: true, rounds, applied, surfaced };
}

// ---- Surfacing findings as plan question items --------------------------

/**
 * Append surfaced findings to a deliverable as `question` work-items,
 * id-stable (re-running with the same findings adds nothing). Returns
 * the ids of the question items that now represent the findings.
 * Holds the plan lock only for the mutation — call AFTER all LLM work.
 */
export async function appendSurfacedQuestions(
	slug: string,
	deliverableId: string,
	findings: readonly OrchestratedFinding[],
): Promise<string[]> {
	if (findings.length === 0) return [];
	return withPlanLock(slug, (plan: Plan) => {
		const target = deliverables(plan).find((d) => d.id === deliverableId);
		if (!target) return [] as string[];
		const now = new Date().toISOString();
		const ids: string[] = [];
		for (const f of findings) {
			const id = workItemId(`review ${findingFingerprint(f)}`);
			ids.push(id);
			const exists = target.children.some(
				(n) => n.type === "work-item" && n.id === id,
			);
			if (exists) continue;
			const loc = f.line ? `${f.file}:${f.line}` : f.file;
			const item: WorkItem = {
				type: "work-item",
				id,
				title: `[review] ${f.title}`,
				body: [
					`Severity: ${f.severity} · Confidence: ${f.confidence}`,
					`Location: ${loc}`,
					"",
					f.description,
					...(f.suggestedAction
						? ["", `Proposed fix: ${f.suggestedAction}`]
						: []),
				].join("\n"),
				done: false,
				kind: "question",
				createdAt: now,
				updatedAt: now,
			};
			target.children.push(item);
			target.updatedAt = now;
		}
		plan.updatedAt = now;
		return ids;
	});
}
