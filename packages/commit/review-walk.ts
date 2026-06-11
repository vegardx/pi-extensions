/**
 * Deterministic accept/skip/explain walk over curated review findings,
 * driven by the curator's confidence. Ported from the old /review
 * walkthrough when the review pipeline became a delegate target —
 * commit owns the interactive walk now, fed from the `reviewer`
 * target's `details` payload.
 *
 * Only `import type` from pi-ext-review is allowed here (cross-
 * extension value imports are forbidden); all walk logic lives in
 * this package.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { OrchestratedFinding } from "pi-ext-review/findings";

export interface ReviewWalkResult {
	accepted: OrchestratedFinding[];
	explainRequests: OrchestratedFinding[];
}

export interface WalkRecommendation {
	action: "accept" | "explain";
	/** Human-readable bullets explaining why we're confident. */
	reasons: string[];
}

/**
 * Decide whether the walk should mark one option as "(Recommended)".
 * Driven by the curator's confidence — we never recommend Skip,
 * because being confidently wrong about dismissing a real issue is
 * worse than leaving the user neutral.
 *
 *   - high confidence + concrete fix      → Accept
 *   - high confidence, no fix             → Explain
 *   - CRITICAL at any confidence, no fix  → Explain
 *   - anything else                       → no nudge
 */
export function recommendationFor(
	f: OrchestratedFinding,
): WalkRecommendation | null {
	const hasFix = Boolean(f.suggestedAction?.trim());
	if (f.confidence === "high") {
		return hasFix
			? {
					action: "accept",
					reasons: ["high curator confidence", "concrete fix available"],
				}
			: {
					action: "explain",
					reasons: ["high curator confidence", "no concrete fix yet"],
				};
	}
	if (f.severity === "CRITICAL" && !hasFix) {
		return {
			action: "explain",
			reasons: ["CRITICAL severity", "no concrete fix yet"],
		};
	}
	return null;
}

export function pickerOptions(rec: WalkRecommendation | null): string[] {
	const accept = "Accept — queue the suggested fix";
	const skip = "Skip — move to the next finding";
	const explain = "Explain — have the agent walk me through this one";
	if (rec?.action === "accept") {
		return [`${accept} (Recommended)`, skip, explain];
	}
	if (rec?.action === "explain") {
		return [accept, skip, `${explain} (Recommended)`];
	}
	return [accept, skip, explain];
}

export function formatFinding(
	n: number,
	total: number,
	f: OrchestratedFinding,
): string {
	const loc = f.line ? `${f.file}:${f.line}` : f.file;
	const lenses = f.confirmedByRoles.join(", ") || "curator";
	const staticTag = f.staticToolSource ? ` (via ${f.staticToolSource})` : "";
	const parts = [
		`## [${n}/${total}] ${f.severity} — ${f.title}`,
		"",
		`**Location**: \`${loc}\``,
		`**Confidence**: ${f.confidence} · **Lenses**: ${lenses}${staticTag}`,
		"",
		f.description,
	];
	if (f.suggestedAction) {
		parts.push("", `**Suggested action**: ${f.suggestedAction}`);
	}
	if (f.orchestratorNote) {
		parts.push("", `**Curator note**: ${f.orchestratorNote}`);
	}
	const rec = recommendationFor(f);
	if (rec) {
		const verb = rec.action === "accept" ? "Accept" : "Explain";
		parts.push("", `Recommending **${verb}** (${rec.reasons.join(", ")}).`);
	}
	return parts.join("\n");
}

/**
 * Walk the actionable findings one by one. Each finding is shown as a
 * display message, then the user picks accept / skip / explain.
 */
export async function walkReviewFindings(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	findings: readonly OrchestratedFinding[],
	customType: string,
): Promise<ReviewWalkResult> {
	const accepted: OrchestratedFinding[] = [];
	const explainRequests: OrchestratedFinding[] = [];
	for (let i = 0; i < findings.length; i++) {
		const f = findings[i];
		if (!f) continue;
		pi.sendMessage(
			{
				customType,
				content: formatFinding(i + 1, findings.length, f),
				display: true,
			},
			{ deliverAs: "steer" },
		);
		const choice = await ctx.ui.select(
			`${f.severity}: ${f.title.slice(0, 60)}`,
			pickerOptions(recommendationFor(f)),
		);
		if (!choice) continue;
		if (choice.startsWith("Accept")) accepted.push(f);
		else if (choice.startsWith("Explain")) explainRequests.push(f);
	}
	return { accepted, explainRequests };
}

/** Build the agent prompt that applies the walked decisions. */
export function buildReviewFixPrompt(
	accepted: readonly OrchestratedFinding[],
	explain: readonly OrchestratedFinding[],
): string {
	const lines: string[] = [
		"The user has walked the review findings and made the following decisions.",
		"Apply the accepted fixes directly (edit/write) and stage them when done.",
		"Group related fixes into cohesive commits — do not commit until the user",
		"says so, but do propose a commit structure.",
		"",
	];
	if (accepted.length > 0) {
		lines.push("## Accepted — apply these fixes", "");
		accepted.forEach((f, idx) => {
			const loc = f.line ? `${f.file}:${f.line}` : f.file;
			lines.push(
				`${idx + 1}. **[${f.severity}] \`${loc}\`** — ${f.title}`,
				`   - Why: ${f.description}`,
			);
			if (f.suggestedAction) {
				lines.push(`   - Fix: ${f.suggestedAction}`);
			}
			lines.push("");
		});
	}
	if (explain.length > 0) {
		lines.push("## Explain — user requested more detail", "");
		explain.forEach((f, idx) => {
			const loc = f.line ? `${f.file}:${f.line}` : f.file;
			lines.push(
				`${idx + 1}. **[${f.severity}] \`${loc}\`** — ${f.title}`,
				`   - ${f.description}`,
			);
			if (f.suggestedAction) {
				lines.push(`   - Proposed fix: ${f.suggestedAction}`);
			}
			lines.push("");
		});
		lines.push(
			"For each Explain item, walk the user through what the issue is, why it",
			"matters, and the trade-offs of the proposed fix. Then ask if they want",
			"to accept it.",
		);
	}
	return lines.join("\n");
}
