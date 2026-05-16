import type { RelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import { resolveEditorConfig } from "../config.js";

function settings(overrides?: Record<string, unknown>): RelevantSettings {
	return {
		extensionConfig: {
			editor: overrides ?? {},
		},
	} as RelevantSettings;
}

const noEnv = () => undefined;

describe("resolveEditorConfig", () => {
	it("falls back to `code` when nothing is set", () => {
		expect(resolveEditorConfig(settings(), noEnv)).toEqual({
			command: "code",
			args: ["{path}"],
			detach: true,
		});
	});

	it("uses extensionConfig.editor.command verbatim", () => {
		expect(
			resolveEditorConfig(settings({ command: "vim" }), noEnv).command,
		).toBe("vim");
	});

	it("ignores env when extensionConfig.editor.command is set", () => {
		const env = (n: string) =>
			n === "VISUAL" ? "subl" : n === "EDITOR" ? "nano" : undefined;
		expect(
			resolveEditorConfig(settings({ command: "code-insiders" }), env).command,
		).toBe("code-insiders");
	});

	it("uses $VISUAL when settings has no command", () => {
		const env = (n: string) =>
			n === "VISUAL" ? "subl" : n === "EDITOR" ? "nano" : undefined;
		expect(resolveEditorConfig(settings(), env).command).toBe("subl");
	});

	it("falls back to $EDITOR when $VISUAL is missing", () => {
		const env = (n: string) => (n === "EDITOR" ? "nano" : undefined);
		expect(resolveEditorConfig(settings(), env).command).toBe("nano");
	});

	it("treats empty-string command-setting as unset (env still wins)", () => {
		const env = (n: string) => (n === "VISUAL" ? "subl" : undefined);
		expect(resolveEditorConfig(settings({ command: "" }), env).command).toBe(
			"subl",
		);
	});

	it("respects custom args", () => {
		const cfg = resolveEditorConfig(
			settings({
				command: "code",
				args: ["-g", "{path}:{line}:{col}"],
			}),
			noEnv,
		);
		expect(cfg.args).toEqual(["-g", "{path}:{line}:{col}"]);
	});

	it("falls back to default args when settings.args is malformed", () => {
		const cfg = resolveEditorConfig(
			settings({ args: ["valid", 42] as unknown as string[] }),
			noEnv,
		);
		expect(cfg.args).toEqual(["{path}"]);
	});

	it("respects detach=false", () => {
		expect(resolveEditorConfig(settings({ detach: false }), noEnv).detach).toBe(
			false,
		);
	});

	it("ignores non-boolean detach (fails closed to default true)", () => {
		expect(
			resolveEditorConfig(
				settings({ detach: "true" as unknown as boolean }),
				noEnv,
			).detach,
		).toBe(true);
	});
});
