import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import {
	getExtensionConfigBoolean,
	readRelevantSettings,
} from "@vegardx/pi-extensions-shared/extension-settings.js";
import { GhostEditor } from "./ghost-editor.js";
import { tryParseInlineSuggestion } from "./sentinel.js";

export { INLINE_SUGGESTION_SYSTEM_ADDENDUM } from "./sentinel.js";

const EXT_ID = "prompt-suggestion";

export default function (pi: ExtensionAPI): void {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Inline ghost-text prompt suggestions parsed from a sentinel block emitted by the main agent at the end of each turn.",
		configSchema: [
			{
				key: "enabled",
				type: "boolean",
				fallbackChain:
					"extensionConfig.prompt-suggestion.enabled (default true)",
				doc: "Set to false to disable ghost-text suggestions for this scope.",
			},
		],
	});

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
	// entirely, and flags the next agent_end as belonging to a real user turn.
	pi.on("input", () => {
		editor?.clearGhost();
		pendingRealInput = true;
	});

	pi.on("session_shutdown", () => {
		pendingRealInput = false;
		editor?.clearGhost();
		editor = undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!enabled) return;
		if (!editor) return;
		if (!ctx.hasUI) return;
		// Intentionally NOT checking ctx.isIdle() pre-await — agent_end means the
		// agent just ended; Pi's internal streaming flag may not flip until after
		// this handler runs, so isIdle() is racy here.
		if (ctx.hasPendingMessages()) return;
		if (ctx.ui.getEditorText() !== "") return;
		if (!pendingRealInput) return;
		pendingRealInput = false;

		const suggestion = tryParseInlineSuggestion(
			event.messages as readonly { role: string; content: unknown }[],
		);
		if (!suggestion) return;

		// Re-check after parse: extension-internal RPC could have raced.
		if (
			!ctx.isIdle() ||
			ctx.hasPendingMessages() ||
			ctx.ui.getEditorText() !== ""
		) {
			editor.clearGhost();
			return;
		}
		editor.setGhost(suggestion);
	});
}
