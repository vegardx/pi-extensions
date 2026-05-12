import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { runCopilotTriage } from "./copilot-watcher.js";
import { runPrsTriage } from "./pr-agent.js";

const EXT_ID = "triage";

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Triage GitHub inbox. prs: validate bot reviews, fix and push in parallel sub-agents. copilot: wait for Copilot review then triage. issues/actions/stale: skill-driven.",
		backgroundModelUse: { tier: "normal", set: "primary" },
	});

	pi.registerCommand(EXT_ID, {
		description:
			"Triage GitHub inbox. " +
			"Modes: prs (fan-out one primary.normal sub-agent per PR — validate, fix, push, resolve threads), " +
			"copilot <N> (wait for Copilot review on PR #N then triage), " +
			"issues / actions / stale (skill-driven, use /skill:triage).",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/);
			const mode = parts[0] ?? "";

			if (mode === "prs") {
				return runPrsTriage(ctx);
			}

			if (mode === "copilot") {
				const prArg = parts[1];
				const prNumber = prArg ? parseInt(prArg, 10) : undefined;
				return runCopilotTriage(
					ctx,
					prNumber != null && !Number.isNaN(prNumber) ? prNumber : undefined,
				);
			}

			// issues / actions / stale remain skill-driven
			if (ctx.hasUI) {
				ctx.ui.notify(
					"triage: use /skill:triage for issues, actions, and stale modes",
					"info",
				);
			}
		},
	});
}
