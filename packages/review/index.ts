/**
 * pi-ext-review — multi-lens review pipeline exposed as the
 * `reviewer` delegate target (no slash command).
 *
 * Hard-depends on `subagent`: without the delegate tool there is no
 * way to invoke the pipeline from the agent. TS-side consumers
 * (commit's review offer, modes' post-exec picker, fleet workers)
 * reach it via `getDelegateTarget("reviewer")` and call `execute`
 * directly — never via a dynamic sibling import.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { defineExtension } from "@vegardx/pi-extensions-shared/define-extension.js";
import { registerDelegateTarget } from "@vegardx/pi-extensions-shared/delegate-registry.js";
import {
	type ReviewScope,
	type RunReviewerResult,
	runReviewer,
} from "./run-reviewer.js";

export const EXT_ID = "review";

// Re-exports for tests + downstream consumers. Cross-extension
// consumers must stick to `import type` (enforced by
// scripts/check-cross-extension-imports.mjs).
export type {
	LensId,
	OrchestratedFinding,
	OrchestratorConfidence,
	Severity,
} from "./findings.js";
export { dedupeFindings } from "./findings.js";
export type { AgentModelSpec, ReviewAgentId } from "./models.js";
export {
	ALL_LENSES,
	BUILTIN_MODEL_DEFAULTS,
	resolveAgentModelSpec,
} from "./models.js";
export type {
	ReviewScope,
	RunReviewerOptions,
	RunReviewerResult,
} from "./run-reviewer.js";
export { runReviewer } from "./run-reviewer.js";
export type {
	StaticAnalysisConfig,
	StaticToolResult,
} from "./static-checker.js";

const REVIEWER_PARAMS = Type.Object({
	lenses: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Lenses to run: "generic", "code-review", "security", ' +
				'"simplification". Default: all four.',
		}),
	),
	scope: Type.Optional(
		Type.Union(
			[Type.Literal("auto"), Type.Literal("branch"), Type.Literal("working")],
			{
				description:
					'Diff scope. "auto" (default) prefers the branch diff and falls ' +
					'back to the working tree; "branch"/"working" force one.',
			},
		),
	),
	artifactDir: Type.Optional(
		Type.String({
			description:
				"Directory for the full report artifact. Default: <agentDir>/review.",
		}),
	),
});

interface ReviewerParams {
	lenses?: string[];
	scope?: ReviewScope;
	artifactDir?: string;
}

export default defineExtension(
	{
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc:
			"Multi-lens review pipeline (scanners → indexer → lens fan-out → " +
			'curator) behind the `reviewer` delegate target: delegate({to: "reviewer"}).',
		// Per-agent models configure via `extensionConfig.review.models.<agent>`
		// = {set, tier} and `extensionConfig.review.defaultModel` (object-valued
		// keys, so not listed in configSchema — see models.ts).
		dependsOn: ["subagent"],
	},
	(_pi: ExtensionAPI) => {
		registerDelegateTarget({
			name: "reviewer",
			description:
				"multi-lens code review of the current diff (scanners + indexer + " +
				"lens fan-out + curator); returns a curated findings summary",
			paramsSchema: REVIEWER_PARAMS,
			execute: async ({ params, ctx, signal, timeoutMs }) => {
				const p = (params ?? {}) as ReviewerParams;
				const result: RunReviewerResult = await runReviewer(
					{
						lenses: p.lenses,
						scope: p.scope,
						artifactDir: p.artifactDir,
						timeoutMs,
						signal,
					},
					ctx,
				);
				return { text: result.text, details: result };
			},
		});
	},
);
