/**
 * pi-ext-wrap-up
 *
 * Registers the `/wrap-up` command. When run:
 *   1. Gathers git context and detects cost-incurring resource signals
 *      synchronously in the command handler.
 *   2. Injects a rich instruction message and triggers an agent turn.
 *   3. The agent writes a structured handover document, asks about
 *      detected resources, and offers to save to `.pi/handover-<date>.md`.
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
import { buildWrapUpPrompt } from "./prompt.js";

const EXT_ID = "wrap-up";

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

	pi.registerCommand(EXT_ID, {
		description:
			"Wrap up the current session: write a detailed handover document " +
			"(goal, done, in-progress, exact resume steps, next steps), ask about " +
			"any running cloud resources, and offer to save to .pi/handover-<date>.md.",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Gathering session context…", "info");

			// Read config from settings.json → extensionConfig.wrap-up
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
					content: buildWrapUpPrompt(wrapCtx, handover),
					display: false,
					details: {},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
	});
}
