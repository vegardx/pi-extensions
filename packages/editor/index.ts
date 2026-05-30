/**
 * pi-ext-editor — `/editor [path]` opens the configured IDE/editor.
 *
 * No arg → open at `ctx.cwd`. Arg may be `path`, `path:line`, or
 * `path:line:col`. Configuration lives under `extensionConfig.editor`
 * — see README.md for examples (VS Code, Cursor, IntelliJ, Neovim).
 *
 * Spawns detached + unref'd by default so closing pi doesn't kill
 * the editor. PATH-miss is reported via `ctx.ui.notify`.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { defineExtension } from "@vegardx/pi-extensions-shared/define-extension.js";
import { readRelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import { applyArgvTemplate, parsePathArg } from "./argv.js";
import { EDITOR_PRESETS, EXT_ID, resolveEditorConfig } from "./config.js";
import { launchEditor } from "./spawn.js";

export default defineExtension(
	{
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Open the configured IDE/editor at cwd or path:line:col.",
		configSchema: [
			{
				key: "preset",
				type: "enum",
				enumValues: EDITOR_PRESETS,
				default: "auto",
				doc: "Common editor preset. `auto` uses command/env fallback; `custom` expects `command`/`args`. Valid: auto, code, cursor, windsurf, intellij, nvim, sublime, custom.",
			},
			{
				key: "command",
				type: "string",
				doc: "Custom editor binary/path. When unset, the selected preset is used; with preset `auto`, falls back to $VISUAL, then $EDITOR, then 'code'.",
			},
			{
				key: "args",
				type: "string[]",
				doc: "Argv template override. Placeholders: {path}, {line}, {col}, {cwd}. When unset, the selected preset's template is used.",
			},
			{
				key: "detach",
				type: "boolean",
				default: true,
				doc: "Spawn detached + unref'd so closing pi doesn't kill the editor. Set false to tie editor lifetime to pi.",
			},
		],
	},
	(pi: ExtensionAPI) => {
		pi.registerCommand(EXT_ID, {
			description:
				"Open the configured IDE/editor at cwd, or at the given path " +
				"(optionally `path:line` or `path:line:col`). Configure under " +
				"`extensionConfig.editor` — see README.md for VS Code / Cursor / " +
				"IntelliJ / Neovim examples.",
			handler: async (args, ctx) => {
				const settings = readRelevantSettings(ctx.cwd);
				const config = resolveEditorConfig(settings);
				const parsed = parsePathArg(args, ctx.cwd);
				const argv = applyArgvTemplate(config.args, {
					path: parsed.path,
					cwd: ctx.cwd,
					line: parsed.line,
					col: parsed.col,
				});

				const outcome = await launchEditor({
					command: config.command,
					args: argv,
					cwd: ctx.cwd,
					detach: config.detach,
					onLateError: (err) => {
						// Editor surfaced an error after spawn (e.g. EACCES). The
						// initial outcome was already reported as success, so let
						// the user know something went wrong post-spawn.
						ctx.ui.notify(
							`/editor: editor reported an error after spawn: ${
								err.message ?? String(err)
							}`,
							"warning",
						);
					},
				});

				if (!outcome.ok) {
					if (outcome.reason === "not-found") {
						ctx.ui.notify(
							`/editor: ${outcome.detail}. Configure ` +
								"`extensionConfig.editor.command` in settings.json or set " +
								"$VISUAL / $EDITOR.",
							"warning",
						);
					} else {
						ctx.ui.notify(`/editor: ${outcome.detail}`, "warning");
					}
					return;
				}

				const where = parsed.line
					? parsed.col
						? `${parsed.path}:${parsed.line}:${parsed.col}`
						: `${parsed.path}:${parsed.line}`
					: parsed.path;
				ctx.ui.notify(`/editor: opened ${where}`, "info");
			},
		});
	},
);
