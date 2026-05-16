import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getActiveMode } from "@vegardx/pi-extensions-shared/active-mode.js";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { EXT_ID, runCommit } from "./core.js";

// Re-exports for tests + downstream consumers (e.g. /develop). `runCommit`
// piggybacks on the binding imported above; the others aren't needed at
// runtime in this module so we re-export them straight from their sources.
export type { RunCommitOptions, RunCommitResult } from "./core.js";
export {
	buildForkUrl,
	isSafeBranchName,
	isValidIssueNumber,
	parseTitleAndBody,
	summarisePlan,
} from "./helpers.js";
export { runCommit };

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Drive a focused commit/PR loop: stage, summarise, push, open or edit the PR.",
	});

	pi.registerCommand(EXT_ID, {
		description:
			"Analyze changes, propose a conventional-commit plan, execute, and optionally push + open/update a PR. " +
			"Auto-appends `Closes #N` when the branch has a `tracking-issue` git config (set by `/develop`'s park path).",
		handler: async (args, ctx) => {
			await runCommit({
				ctx,
				pi,
				guidance: args ?? "",
				mode: getActiveMode() ?? undefined,
			});
		},
	});
}
