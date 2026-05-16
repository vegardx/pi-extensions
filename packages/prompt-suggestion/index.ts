import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import {
	getExtensionConfigBoolean,
	getExtensionConfigString,
	readRelevantSettings,
} from "@vegardx/pi-extensions-shared/extension-settings.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { appendAbSample, DEFAULT_AB_LOG_PATH } from "./ab-telemetry.js";
import { GhostEditor } from "./ghost-editor.js";
import { Predictor, parseModelSpec } from "./predictor.js";
import { tryParseInlineSuggestion } from "./sentinel.js";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "prompt-suggestion.json");

interface PersistedConfig {
	modelSpec?: string;
	enabled?: boolean;
}

function loadPersistedConfig(): PersistedConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null)
			return parsed as PersistedConfig;
	} catch {
		// File missing or unreadable — fine, caller uses defaults.
	}
	return {};
}

function savePersistedConfig(config: PersistedConfig): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
	} catch {
		// Best-effort; persistence is an ergonomic improvement, not load-bearing.
	}
}

/**
 * Resolve the initial model spec for prompt-suggestion.
 *
 * Precedence (high → low):
 *   1. Persisted pick from `/suggest` in `~/.pi/agent/prompt-suggestion.json`.
 *   2. `--suggest-model=<spec>` CLI flag (session override).
 *   3. Shared resolver — extensionConfig.prompt-suggestion.model →
 *      backgroundModels.fast → ctx.model. Returns null if nothing
 *      usable, in which case we disable the feature silently (the
 *      predictor's own auth-probe surfaces a one-time notify if the
 *      chosen model later fails auth).
 */
async function resolveInitialModelSpec(
	ctx: ExtensionContext,
	persisted: PersistedConfig,
	flagSpec: string | undefined,
): Promise<string | null> {
	if (persisted.modelSpec && typeof persisted.modelSpec === "string") {
		return persisted.modelSpec;
	}
	if (flagSpec) return flagSpec;
	const resolved = await resolveModel(ctx, {
		name: "prompt-suggestion",
		tier: "fast",
	});
	if (!resolved) return null;
	return `${resolved.model.provider}/${resolved.model.id}`;
}

export default function (pi: ExtensionAPI): void {
	declareExtension({
		name: "prompt-suggestion",
		path: fileURLToPath(import.meta.url),
		doc: "Ghost-text prompt suggestions in the input box, powered by a configurable fast model.",
		configSchema: [
			{
				key: "model",
				type: "string",
				fallbackChain:
					"--suggest-model flag → /suggest pick → extensionConfig.prompt-suggestion.model → backgroundModels.primary.fast → ctx.model",
				doc: "provider/id override for the suggestion model.",
			},
		],
		backgroundModelUse: {
			tier: "fast",
			set: "primary",
			explanation:
				"Used for ghost-text completions; runs once per keystroke debounce.",
		},
	});

	pi.registerFlag("suggest", {
		type: "boolean",
		default: true,
		description: "Enable ghost-text prompt suggestions",
	});
	pi.registerFlag("suggest-model", {
		type: "string",
		description:
			"provider/modelId for prompt suggestions (session override). Without this, uses the `/suggest` pick, then settings.json extensionConfig.prompt-suggestion.model, then backgroundModels.fast, then the active session model.",
	});

	let editor: GhostEditor | undefined;
	let predictor: Predictor | undefined;
	let enabled = true;
	let inlineMode = false;
	let abLogPath: string | null = null;
	// True only when the most recent user action was a direct editor submission
	// (i.e. the `input` event fired). Extension-internal agent calls — e.g.
	// those driven by /commit or /review — bypass `input`, so this stays false
	// and we skip suggestions for those runs.
	let pendingRealInput = false;

	const persist = () => {
		savePersistedConfig({
			modelSpec: predictor?.modelSpec,
			enabled,
		});
	};

	const OFF_OPTION = "(off — disable suggestions)";

	pi.registerCommand("suggest", {
		description: "Pick a suggestion model or turn off suggestions",
		handler: async (_args, ctx) => {
			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify(
					"No models have configured auth. Set an API key first (e.g. ANTHROPIC_API_KEY) or run /login.",
					"warning",
				);
				return;
			}
			const current = predictor?.modelSpec ?? "";
			const modelOptions = available.map((m) => {
				const label = `${m.provider}/${m.id}`;
				return enabled && label === current ? `${label} (current)` : label;
			});
			const options = [...modelOptions, OFF_OPTION];
			const picked = await ctx.ui.select("Suggestions:", options);
			if (!picked) return;

			if (picked === OFF_OPTION) {
				enabled = false;
				predictor?.cancel();
				editor?.clearGhost();
				persist();
				ctx.ui.notify("Prompt suggestions: off", "info");
				return;
			}
			const chosen = picked.replace(/ \(current\)$/, "");
			predictor?.setModelSpec(chosen);
			enabled = true;
			persist();
			ctx.ui.notify(`Prompt suggestions: on (${chosen})`, "info");
		},
	});

	pi.registerCommand("suggest-status", {
		description: "Show diagnostic state of prompt suggestions",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			lines.push(`enabled: ${enabled}`);
			lines.push(`inline mode (#146 spike): ${inlineMode}`);
			lines.push(`A/B log: ${abLogPath ?? "off"}`);
			lines.push(`pending real input: ${pendingRealInput}`);
			lines.push(`editor installed: ${editor ? "yes" : "no"}`);
			lines.push(`predictor: ${predictor ? "yes" : "no"}`);
			lines.push(
				`seen real turn: ${predictor?.sawTurnInThisSession ? "yes" : "no"}`,
			);
			const spec = predictor?.modelSpec ?? "(unset)";
			lines.push(`model spec: ${spec}`);
			const parsed = predictor ? parseModelSpec(predictor.modelSpec) : null;
			if (parsed) {
				const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
				lines.push(`model in registry: ${model ? "yes" : "no"}`);
				if (model) {
					lines.push(
						`configured auth: ${ctx.modelRegistry.hasConfiguredAuth(model) ? "yes" : "no"}`,
					);
				}
			} else if (predictor) {
				lines.push(`model in registry: parse-error`);
			}
			lines.push(`idle: ${ctx.isIdle() ? "yes" : "no"}`);
			lines.push(
				`pending messages: ${ctx.hasPendingMessages() ? "yes" : "no"}`,
			);
			lines.push(
				`editor buffer empty: ${ctx.ui.getEditorText() === "" ? "yes" : "no"}`,
			);
			if (predictor) {
				lines.push("");
				lines.push(`last predict status: ${predictor.lastStatus}`);
				if (predictor.lastAgentEndAt) {
					const agoMs = Date.now() - predictor.lastAgentEndAt;
					lines.push(`last agent_end fired: ${Math.round(agoMs / 1000)}s ago`);
				} else {
					lines.push(`last agent_end fired: never`);
				}
				if (predictor.lastAt) {
					const agoMs = Date.now() - predictor.lastAt;
					lines.push(`last predict at: ${Math.round(agoMs / 1000)}s ago`);
				}
				if (predictor.lastStopReason)
					lines.push(`last stopReason: ${predictor.lastStopReason}`);
				if (predictor.lastTrimmedCount !== null)
					lines.push(`last trimmed count: ${predictor.lastTrimmedCount}`);
				if (predictor.lastContentTypes)
					lines.push(`last content types: ${predictor.lastContentTypes}`);
				if (predictor.lastRawText !== null) {
					lines.push(
						`last raw (trunc 200): ${JSON.stringify(predictor.lastRawText)}`,
					);
				}
				if (predictor.lastSanitized !== null) {
					lines.push(
						`last sanitized: ${JSON.stringify(predictor.lastSanitized)}`,
					);
				}
				if (predictor.lastErrorMessage)
					lines.push(`last error: ${predictor.lastErrorMessage}`);
			}
			ctx.ui.notify(`prompt-suggestion status:\n${lines.join("\n")}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		pendingRealInput = false;
		const persisted = loadPersistedConfig();

		// #146 spike: read inline-mode + ab-log flags. Both default off; the
		// inline path is opt-in until the A/B finishes.
		const settings = readRelevantSettings(ctx.cwd);
		inlineMode =
			getExtensionConfigBoolean(
				settings,
				"promptSuggestion",
				"inline",
				false,
			) ?? false;
		const abLogEnabled =
			getExtensionConfigBoolean(settings, "promptSuggestion", "abLog", false) ??
			false;
		const abLogPathSetting = getExtensionConfigString(
			settings,
			"promptSuggestion",
			"abLogPath",
			"",
		);
		abLogPath = abLogEnabled
			? abLogPathSetting && abLogPathSetting.length > 0
				? abLogPathSetting
				: DEFAULT_AB_LOG_PATH
			: null;

		// Enabled precedence: persisted > flag > default(true).
		// Flag is checked via user-explicit presence; a bare default(true) shouldn't
		// override the persisted off-state.
		const flagEnabled = pi.getFlag("suggest");
		if (typeof persisted.enabled === "boolean") {
			enabled = persisted.enabled;
		} else {
			enabled = flagEnabled !== false;
		}

		const flagModel = pi.getFlag("suggest-model");
		const flagSpec =
			typeof flagModel === "string" && flagModel ? flagModel : undefined;
		const modelSpec = await resolveInitialModelSpec(ctx, persisted, flagSpec);

		if (!modelSpec) {
			// No configured model anywhere and no active session model. Feature
			// stays disabled for the session; surfaced once at startup so the
			// user knows why ghost text isn't showing.
			if (enabled && ctx.hasUI) {
				ctx.ui.notify(
					"prompt-suggestion: no model configured (set backgroundModels.fast or extensionConfig.prompt-suggestion.model in settings.json, or run /suggest). Ghost text disabled.",
					"info",
				);
			}
			predictor = undefined;
			editor = undefined;
			return;
		}

		predictor = new Predictor(modelSpec, ctx);
		editor = undefined;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new GhostEditor(tui, theme, keybindings);
			return editor;
		});
	});

	// Only predict after a real user turn. Session-resume fires a synthetic
	// agent_end on load; without this flag we'd immediately ship the restored
	// conversation to the suggestion model and guess a message the user
	// already answered.
	pi.on("turn_start", () => {
		if (predictor) predictor.sawTurnInThisSession = true;
		// Any new agent turn means the previous ghost is stale (e.g. modes
		// triggered a follow-up turn via sendMessage after the user picked
		// "Implement").
		predictor?.cancel();
		editor?.clearGhost();
	});

	// Belt-and-suspenders: the editor's handleInput already clears the ghost
	// and cancels for interactive submissions. This covers RPC/extension
	// sources that bypass the editor entirely.
	pi.on("input", () => {
		predictor?.cancel();
		editor?.clearGhost();
		pendingRealInput = true;
	});

	pi.on("session_shutdown", () => {
		pendingRealInput = false;
		predictor?.cancel();
		predictor = undefined;
		editor?.clearGhost();
		editor = undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (predictor) predictor.lastAgentEndAt = Date.now();
		if (!enabled) {
			if (predictor) predictor.lastStatus = "gate: disabled";
			return;
		}
		if (!editor) {
			if (predictor) predictor.lastStatus = "gate: no-editor";
			return;
		}
		if (!predictor) return;
		if (!ctx.hasUI) {
			predictor.lastStatus = "gate: no-ui";
			return;
		}
		// Intentionally NOT checking ctx.isIdle() pre-await — agent_end means the
		// agent just ended; Pi's internal streaming flag may not flip until after
		// this handler runs, so isIdle() is racy here. We check it post-await
		// instead, where enough time has elapsed for the flag to settle.
		if (ctx.hasPendingMessages()) {
			predictor.lastStatus = "gate: pending-messages";
			return;
		}
		if (ctx.ui.getEditorText() !== "") {
			predictor.lastStatus = "gate: buffer-not-empty";
			return;
		}
		if (!predictor.sawTurnInThisSession) {
			predictor.lastStatus = "gate: no-real-turn-seen";
			return;
		}
		if (!pendingRealInput) {
			predictor.lastStatus = "gate: no-editor-input";
			return;
		}
		pendingRealInput = false;

		// Snapshot the live references before the async gap. If a session
		// switch fires while the prediction is in-flight (session_shutdown
		// → editor_ready), the module-level `editor` and `predictor` will
		// have been replaced. Comparing post-await prevents us from showing
		// a stale suggestion on the new session's editor.
		const snapEditor = editor;
		const snapPredictor = predictor;

		const predictStart = Date.now();

		// #146 spike: try the inline sentinel-protocol first. If the main
		// agent emitted a guess, surface it and skip the cheap-model call
		// entirely. Falls back to the predictor on miss.
		if (inlineMode) {
			const inline = tryParseInlineSuggestion(
				event.messages as readonly { role: string; content: unknown }[],
			);
			if (inline) {
				snapPredictor.lastStatus = "success (inline)";
				snapPredictor.lastAt = Date.now();
				if (abLogPath) {
					appendAbSample(abLogPath, {
						at: Date.now(),
						source: "inline",
						suggestion: inline,
						latencyMs: Date.now() - predictStart,
						notes: "main-agent sentinel",
					});
				}
				if (editor !== snapEditor || predictor !== snapPredictor) return;
				if (
					!ctx.isIdle() ||
					ctx.hasPendingMessages() ||
					ctx.ui.getEditorText() !== ""
				) {
					snapEditor.clearGhost();
					return;
				}
				snapEditor.setGhost(inline);
				return;
			}
			// Inline path missed — fall through to predictor, but tag the
			// telemetry source as `inline-fallback-predictor` for the A/B.
		}

		const suggestion = await snapPredictor.predict(event.messages);
		const predictorLatencyMs = Date.now() - predictStart;
		if (abLogPath) {
			appendAbSample(abLogPath, {
				at: Date.now(),
				source: inlineMode ? "inline-fallback-predictor" : "predictor",
				suggestion: suggestion ?? null,
				latencyMs: predictorLatencyMs,
				model: snapPredictor.modelSpec,
				stopReason: snapPredictor.lastStopReason ?? undefined,
				notes: snapPredictor.lastStatus,
			});
		}
		if (!suggestion) return;
		// Session changed during prediction — bail.
		if (editor !== snapEditor || predictor !== snapPredictor) return;
		// Post-await guards: the prediction API call takes time; by the time it
		// resolves the user may have submitted another prompt (agent is running
		// again) or started typing. isIdle() is reliable here — unlike the
		// pre-await path, enough wall-clock time has elapsed for Pi's internal
		// streaming flag to have settled.
		if (!ctx.isIdle()) {
			snapPredictor.lastStatus = "post: agent-running";
			snapEditor.clearGhost();
			return;
		}
		if (ctx.hasPendingMessages()) {
			snapPredictor.lastStatus = "post: pending-messages";
			snapEditor.clearGhost();
			return;
		}
		if (ctx.ui.getEditorText() !== "") {
			snapPredictor.lastStatus = "post: buffer-not-empty";
			return;
		}

		snapEditor.setGhost(suggestion);
	});
}
