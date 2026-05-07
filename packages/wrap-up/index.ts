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
import { gatherContext } from "./context.js";
import { buildWrapUpPrompt } from "./prompt.js";

const EXT_ID = "wrap-up";

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "End-of-session wrap-up: produces a detailed handover document from session history and git state, then prompts about cost-incurring resources before you sign off.",
	});

	pi.registerCommand(EXT_ID, {
		description:
			"Wrap up the current session: write a detailed handover document " +
			"(goal, done, in-progress, exact resume steps, next steps), ask about " +
			"any running cloud resources, and offer to save to .pi/handover-<date>.md.",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Gathering session context…", "info");

			const wrapCtx = gatherContext(ctx.cwd);

			const resourceSummary =
				wrapCtx.resources.length > 0
					? `Detected resource signals: ${wrapCtx.resources.map((r) => r.label).join(", ")}`
					: "No infrastructure signals detected.";

			ctx.ui.notify(
				[
					`Branch: ${wrapCtx.branch ?? "(none)"}`,
					wrapCtx.prInfo ? "PR: found" : "PR: none",
					resourceSummary,
				].join(" · "),
				"info",
			);

			pi.sendMessage(
				{
					customType: EXT_ID,
					content: buildWrapUpPrompt(wrapCtx),
					display: false,
					details: {},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
	});
}
