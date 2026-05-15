import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeepAwakeState } from "@vegardx/pi-extensions-shared/caffeinate.js";
import {
	renderStatusLine,
	renderStatusReport,
	setEnabledInProjectSettings,
	shouldShowFirstRunHint,
	statusPill,
} from "../index.js";

function state(over: Partial<KeepAwakeState>): KeepAwakeState {
	return {
		enabled: false,
		supported: true,
		active: false,
		reasons: [],
		holders: 0,
		...over,
	};
}

describe("renderStatusLine", () => {
	it("reports unsupported on non-darwin", () => {
		expect(renderStatusLine(state({ supported: false }))).toBe(
			"caffeinate: unsupported (mac only)",
		);
	});

	it("reports disabled when enabled=false and no holders", () => {
		expect(renderStatusLine(state({ supported: true, enabled: false }))).toBe(
			"caffeinate: disabled",
		);
	});

	it("reports inactive when enabled but idle", () => {
		expect(
			renderStatusLine(
				state({ supported: true, enabled: true, active: false, holders: 0 }),
			),
		).toBe("caffeinate: inactive");
	});

	it("lists holders by reason when active", () => {
		expect(
			renderStatusLine(
				state({
					supported: true,
					enabled: true,
					active: true,
					holders: 1,
					reasons: ["develop"],
				}),
			),
		).toBe("caffeinate: active (develop)");

		expect(
			renderStatusLine(
				state({
					supported: true,
					enabled: true,
					active: true,
					holders: 3,
					reasons: ["develop", "review"],
				}),
			),
		).toBe("caffeinate: active (develop, review)");
	});

	it("treats live holders as a stronger signal than `enabled` (so toggling settings mid-hold still shows active)", () => {
		// enabled was flipped off mid-hold; the lock is still live.
		expect(
			renderStatusLine(
				state({
					supported: true,
					enabled: false,
					active: true,
					holders: 1,
					reasons: ["develop"],
				}),
			),
		).toBe("caffeinate: active (develop)");
	});
});

describe("statusPill", () => {
	it("returns undefined when unsupported (non-darwin)", () => {
		expect(statusPill(state({ supported: false }))).toBeUndefined();
	});

	it("returns discoverability text when supported but not enabled", () => {
		expect(
			statusPill(state({ supported: true, enabled: false })),
		).toBe("caffeinate: disabled (run /caffeinate on)");
	});

	it("returns undefined when enabled but idle (no noise in footer)", () => {
		expect(
			statusPill(
				state({ supported: true, enabled: true, active: false, holders: 0 }),
			),
		).toBeUndefined();
	});

	it("returns 'active' with reasons when enabled and active", () => {
		expect(
			statusPill(
				state({
					supported: true,
					enabled: true,
					active: true,
					holders: 1,
					reasons: ["develop"],
				}),
			),
		).toBe("caffeinate: active (develop)");
	});

	it("returns undefined when enabled flipped off mid-hold (pill drains silently)", () => {
		// `active=true` but `enabled=false` — user toggled off while a lock was
		// live. The pill hides immediately rather than showing conflicting state.
		expect(
			statusPill(
				state({
					supported: true,
					enabled: false,
					active: true,
					holders: 1,
					reasons: ["develop"],
				}),
			),
		).toBeUndefined();
	});
});

describe("renderStatusReport", () => {
	it("renders a multi-line report with reasons when present", () => {
		const lines = renderStatusReport(
			state({
				supported: true,
				enabled: true,
				active: true,
				holders: 2,
				reasons: ["develop", "review"],
			}),
		);
		expect(lines[0]).toBe("caffeinate: active (develop, review)");
		expect(lines).toContain("  supported: yes (darwin)");
		expect(lines).toContain("  enabled:   yes");
		expect(lines).toContain("  active:    yes");
		expect(lines).toContain("  holders:   2");
		expect(lines).toContain("  reasons:   develop, review");
	});

	it("omits the reasons line when none are held", () => {
		const lines = renderStatusReport(
			state({ supported: true, enabled: true, active: false }),
		);
		expect(lines.find((l) => l.startsWith("  reasons:"))).toBeUndefined();
	});

	it("flags non-darwin and not-opted-in clearly", () => {
		const lines = renderStatusReport(state({ supported: false }));
		expect(lines[0]).toBe("caffeinate: unsupported (mac only)");
		expect(lines).toContain("  supported: no");
		expect(lines).toContain("  enabled:   no (opt-in via settings)");
	});
});

describe("setEnabledInProjectSettings", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-ext-caffeinate-cmd-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("creates .pi/settings.json on a fresh project and reports previous=false", () => {
		const { path, previous } = setEnabledInProjectSettings(cwd, true);
		expect(path).toBe(join(cwd, ".pi", "settings.json"));
		expect(previous).toBe(false);
		const written = JSON.parse(readFileSync(path, "utf8"));
		expect(written).toEqual({
			extensionConfig: { caffeinate: { enabled: true } },
		});
	});

	it("preserves unrelated settings keys when toggling", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				defaultProvider: "anthropic",
				backgroundModels: { primary: { fast: "anthropic/haiku" } },
				extensionConfig: {
					verify: { model: "openai/gpt-4o" },
					caffeinate: { flags: ["-i", "-d"] },
				},
			}),
		);
		const { previous } = setEnabledInProjectSettings(cwd, true);
		expect(previous).toBe(false); // enabled wasn't set before
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.defaultProvider).toBe("anthropic");
		expect(written.backgroundModels.primary.fast).toBe("anthropic/haiku");
		expect(written.extensionConfig.verify.model).toBe("openai/gpt-4o");
		expect(written.extensionConfig.caffeinate).toEqual({
			flags: ["-i", "-d"],
			enabled: true,
		});
	});

	it("reports previous=true when flipping off after on", () => {
		setEnabledInProjectSettings(cwd, true);
		const { previous } = setEnabledInProjectSettings(cwd, false);
		expect(previous).toBe(true);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig.caffeinate.enabled).toBe(false);
	});

	it("is idempotent when the value already matches", () => {
		setEnabledInProjectSettings(cwd, true);
		const { previous } = setEnabledInProjectSettings(cwd, true);
		expect(previous).toBe(true);
	});

	it("throws on a corrupt settings.json instead of silently overwriting it", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), "this is not json {{{");
		// Fail closed: the user's existing (broken) file is preserved
		// and the toggle is reported as a hard error in the slash-command
		// handler. Silently overwriting could clobber a partially-written
		// edit the user is mid-rescue on.
		expect(() => setEnabledInProjectSettings(cwd, true)).toThrow();
	});
});

// ---------------------------------------------------------------------------
// shouldShowFirstRunHint
// ---------------------------------------------------------------------------

describe("shouldShowFirstRunHint", () => {
	function s(over: Partial<KeepAwakeState>): KeepAwakeState {
		return state(over);
	}

	it("returns true when supported, not enabled, and hint not yet shown", () => {
		expect(
			shouldShowFirstRunHint(s({ supported: true, enabled: false }), false),
		).toBe(true);
	});

	it("returns false when hint has already been shown", () => {
		expect(
			shouldShowFirstRunHint(s({ supported: true, enabled: false }), true),
		).toBe(false);
	});

	it("returns false when not supported (non-darwin)", () => {
		expect(
			shouldShowFirstRunHint(s({ supported: false, enabled: false }), false),
		).toBe(false);
	});

	it("returns false when already enabled (user opted in)", () => {
		expect(
			shouldShowFirstRunHint(s({ supported: true, enabled: true }), false),
		).toBe(false);
	});

	it("returns false when supported + enabled + hint shown", () => {
		expect(
			shouldShowFirstRunHint(s({ supported: true, enabled: true }), true),
		).toBe(false);
	});
});
