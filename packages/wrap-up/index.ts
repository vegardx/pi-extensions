/**
 * pi-ext-wrap-up
 *
 * Registers `/pause` and `/continue` commands.
 *
 * /pause:
 *   1. Gathers git context and detects cost-incurring resource signals.
 *   2. Injects a rich instruction message and triggers an agent turn.
 *   3. The agent writes a structured handover document with YAML
 *      frontmatter, asks about detected resources, and saves to disk.
 *
 * /continue:
 *   1. Scans the handover directory for handover files.
 *   2. Ranks candidates by branch/repo/date relevance.
 *   3. Injects the best match and asks the user how to proceed.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import {
	getExtensionConfigBoolean,
	getExtensionConfigString,
	readRelevantSettings,
} from "@vegardx/pi-extensions-shared/extension-settings.js";
import { gatherContext, resolveHandoverConfig } from "./context.js";
import { discoverHandovers, needsHandoverPicker } from "./discover.js";
import { buildContinuePrompt, buildPausePrompt } from "./prompt.js";

const EXT_ID = "wrap-up";
const PAUSE_CMD = "pause";
const CONTINUE_CMD = "continue";

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "End-of-session wrap-up: produces a detailed handover document from session history and git state, then prompts about cost-incurring resources before you sign off.",
		configSchema: [
			{
				key: "handoverDir",
				type: "string",
				default: "~/.pi/agent/handovers",
				doc: "Directory where handover files are written. Supports ~ expansion. Default: ~/.pi/agent/handovers",
			},
			{
				key: "autoSave",
				type: "boolean",
				default: false,
				doc: "When true, the agent writes the handover file immediately without asking. Default: false",
			},
		],
	});

	pi.registerCommand(PAUSE_CMD, {
		description:
			"Pause the current session: write a detailed handover document " +
			"(goal, done, in-progress, exact resume steps, next steps), ask about " +
			"any running cloud resources, and save to disk for /continue.",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Gathering session context…", "info");

			const settings = readRelevantSettings(ctx.cwd);
			const configuredDir = getExtensionConfigString(
				settings,
				EXT_ID,
				"handoverDir",
				"",
			);
			const autoSave = getExtensionConfigBoolean(
				settings,
				EXT_ID,
				"autoSave",
				false,
			);

			const wrapCtx = gatherContext(ctx.cwd, {
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				sessionName: ctx.sessionManager.getSessionName(),
			});

			const handover = resolveHandoverConfig(wrapCtx, {
				configuredDir: configuredDir || undefined,
				autoSave,
			});

			const resourceSummary =
				wrapCtx.resources.length > 0
					? `Detected resource signals: ${wrapCtx.resources.map((r) => r.label).join(", ")}`
					: "No infrastructure signals detected.";

			ctx.ui.notify(
				[
					`Branch: ${wrapCtx.branch ?? "(none)"}`,
					wrapCtx.prInfo ? "PR: found" : "PR: none",
					resourceSummary,
					`Handover: ${handover.fullPath}${autoSave ? " (auto-save on)" : ""}`,
				].join(" · "),
				"info",
			);

			pi.sendMessage(
				{
					customType: EXT_ID,
					content: buildPausePrompt(wrapCtx, handover),
					display: false,
					details: {},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
	});

	pi.registerCommand(CONTINUE_CMD, {
		description:
			"Resume from a previous session's handover document. " +
			"Finds the most relevant handover file, injects it, and asks how to proceed.",
		handler: async (_args, ctx) => {
			const settings = readRelevantSettings(ctx.cwd);
			const configuredDir = getExtensionConfigString(
				settings,
				EXT_ID,
				"handoverDir",
				"",
			);

			const candidates = discoverHandovers(ctx.cwd, {
				configuredDir: configuredDir || undefined,
			});

			if (candidates.length === 0) {
				ctx.ui.notify(
					"No handover files found. Run /pause at the end of a session first.",
					"warning",
				);
				return;
			}

			let chosen = candidates[0];

			// If the top candidate has no relevance signal at all, or
			// multiple candidates tie, let the user pick explicitly.
			// Require a non-recency signal (branch or repo match, score ≥ 50)
			// before auto-selecting. A pure-recency hit (score 1–10) is too
			// weak — it just means the file is recent, not that it belongs to
			// this repo/branch. Always show the picker in that case.
			const needsPicker = needsHandoverPicker(candidates);
			if (needsPicker) {
				const top = candidates.slice(0, 10);
				const labels = top.map((c) => {
					const parts = [c.meta.date];
					if (c.meta.branch) parts.push(c.meta.branch);
					if (c.meta.repo) parts.push(c.meta.repo);
					parts.push(c.meta.session_id);
					return parts.join(" · ");
				});

				// Disambiguate duplicate labels with a numeric suffix
				const seen = new Map<string, number>();
				const uniqueLabels = labels.map((label) => {
					const count = seen.get(label) ?? 0;
					seen.set(label, count + 1);
					return count > 0 ? `${label} (${count + 1})` : label;
				});

				const picked = await ctx.ui.select(
					"Multiple handovers found — which one?",
					uniqueLabels,
				);
				if (picked === undefined) return;
				const pickedIdx = uniqueLabels.indexOf(picked);
				if (pickedIdx === -1) return;
				chosen = candidates[pickedIdx];
			}

			ctx.ui.notify(
				`Loading handover: ${chosen.meta.date}${chosen.meta.branch ? ` (${chosen.meta.branch})` : ""}`,
				"info",
			);

			pi.sendMessage(
				{
					customType: EXT_ID,
					content: buildContinuePrompt(chosen.body),
					display: false,
					details: { handoverFile: chosen.filePath },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
	});
}
