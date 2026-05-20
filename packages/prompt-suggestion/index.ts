import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { defineExtension } from "@vegardx/pi-extensions-shared/define-extension.js";
import {
	getExtensionConfigBoolean,
	readRelevantSettings,
} from "@vegardx/pi-extensions-shared/extension-settings.js";
import { GhostEditor } from "./ghost-editor.js";
import { sanitiseSuggestion } from "./sanitise.js";

export { INLINE_SUGGESTION_SYSTEM_ADDENDUM } from "./sanitise.js";

const EXT_ID = "prompt-suggestion";

// Component whose render() returns no lines. Used as both the call and
// result slot for the suggest_next_prompt tool so the row collapses to
// zero height in the TUI. Pi has no native "hidden tool" flag; this is
// the supported way to make a registered tool effectively invisible.
const HIDDEN_RENDER = {
	render(): string[] {
		return [];
	},
	invalidate(): void {},
};

export default defineExtension(
	{
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Inline ghost-text prompt suggestions delivered via a hidden suggest_next_prompt tool call at the end of each agent turn.",
		configSchema: [
			{
				key: "enabled",
				type: "boolean",
				fallbackChain:
					"extensionConfig.prompt-suggestion.enabled (default true)",
				doc: "Set to false to disable ghost-text suggestions for this scope.",
			},
		],
	},
	(pi: ExtensionAPI): void => {
		let editor: GhostEditor | undefined;
		let enabled = true;
		// True only when the most recent user action was a direct editor submission
		// (i.e. the `input` event fired). Extension-internal agent calls — e.g.
		// those driven by /commit or /review — bypass `input`, so this stays false
		// and we skip suggestions for those runs.
		let pendingRealInput = false;

		pi.on("session_start", async (_event, ctx) => {
			pendingRealInput = false;
			const settings = readRelevantSettings(ctx.cwd);
			enabled =
				getExtensionConfigBoolean(settings, EXT_ID, "enabled", true) ?? true;
			editor = undefined;
			if (!enabled) return;
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				editor = new GhostEditor(tui, theme, keybindings);
				return editor;
			});
		});

		// Any new agent turn means the previous ghost is stale (e.g. modes
		// triggered a follow-up turn via sendMessage after the user picked
		// "Implement").
		pi.on("turn_start", () => {
			editor?.clearGhost();
		});

		// The editor's handleInput already clears the ghost for interactive
		// submissions. This covers RPC/extension sources that bypass the editor
		// entirely, and flags the next tool call as belonging to a real user turn.
		pi.on("input", () => {
			editor?.clearGhost();
			pendingRealInput = true;
		});

		pi.on("session_shutdown", () => {
			pendingRealInput = false;
			editor?.clearGhost();
			editor = undefined;
		});

		pi.registerTool({
			name: "suggest_next_prompt",
			label: "Suggest Next Prompt",
			description:
				"Suggest a one-line prompt to show the developer as ghost text.",
			// No promptSnippet / promptGuidelines — the system addendum the user
			// pastes into their AGENTS.md owns the calling contract. Listing
			// the tool in the default Available-tools section would conflict
			// with the addendum's "invisible to the developer" framing.
			parameters: Type.Object({
				text: Type.String({
					description:
						"One short sentence directing the developer to do something next, ≤120 chars.",
				}),
			}),
			// Render nothing — see HIDDEN_RENDER above. `renderShell: "self"`
			// stops pi from wrapping our zero-line components in the default
			// padded Box, which would still take vertical space.
			renderShell: "self",
			renderCall: () => HIDDEN_RENDER,
			renderResult: () => HIDDEN_RENDER,

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const ok = {
					content: [{ type: "text" as const, text: "" }],
					details: {},
					// terminate skips the follow-up LLM turn that would otherwise
					// fire after a tool batch. Since the addendum tells the agent
					// to call this exactly once at the very end of its reply, we
					// want the turn to end here without a second round-trip.
					terminate: true,
				};

				if (!enabled) return ok;
				if (!editor) return ok;
				if (!ctx.hasUI) return ok;
				// hasPendingMessages — another turn is queued; surfacing a ghost
				// suggestion now would race the next turn_start clearing it.
				if (ctx.hasPendingMessages()) return ok;
				// User started typing during this turn; don't overwrite their work.
				if (ctx.ui.getEditorText() !== "") return ok;
				// Only react to suggestions for turns that started from a real
				// user submission (i.e. the `input` event fired). Internal
				// extension calls bypass that path.
				if (!pendingRealInput) return ok;
				pendingRealInput = false;

				const sanitised = sanitiseSuggestion(params.text);
				if (sanitised) {
					editor.setGhost(sanitised);
				}
				return ok;
			},
		});
	},
);
