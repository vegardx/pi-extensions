import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { EXT_ID, runReview } from "./core.js";

export type {
	AutoReviewAbortReason,
	RunAutoReviewOptions,
	RunAutoReviewResult,
} from "./auto-review.js";
export {
	AUTO_REVIEW_ROLES,
	readStaticAnalysisConfig,
	runAutoReview,
	VALID_REVIEWER_ROLES,
} from "./auto-review.js";
// Re-exports for tests + downstream consumers (e.g. /develop). `runReview`
// piggybacks on the binding imported above; the others aren't needed at
// runtime in this module so we re-export them straight from their sources.
export type { RunReviewOptions, RunReviewResult } from "./core.js";
export { shouldOfferPostReviewCommit } from "./core.js";
export type { Severity } from "./findings.js";
export { dedupeFindings } from "./findings.js";
export type { ReviewMode } from "./scope.js";
export { parseScope } from "./scope.js";
export type {
	StaticAnalysisConfig,
	StaticToolResult,
} from "./static-checker.js";
export { runReview };

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Run seven specialist reviewer subagents over a diff or codebase.",
		// Uses `ctx.model` directly — no per-extension model override or
		// background-tier resolution today.
	});

	pi.registerCommand(EXT_ID, {
		description:
			"Multi-agent review: seven specialists (architect, code-reviewer, scope-analyst, security-analyst, code-simplifier, doc-reviewer, dependency-checker) " +
			"run in parallel on the same scope. Each one reviews its own lane and returns [] if nothing applies. Walk findings, queue fixes for the agent.",
		handler: async (args, ctx) => {
			await runReview({ ctx, pi, arg: args ?? "" });
		},
	});
}
