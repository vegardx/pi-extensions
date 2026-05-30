import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getDeclaredExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { VALID_REVIEWER_ROLES } from "pi-ext-review/auto-review";
import modesExtension, {
	resolveDefaultMode,
	resolveImplementDefault,
} from "../index.js";

// Invoking the default export runs `declareExtension` (registering the
// configSchema) *before* the enabled check, so disabling the extension
// via env registers the metadata while skipping the factory body.
beforeAll(() => {
	const prev = process.env.PI_EXT_MODES;
	process.env.PI_EXT_MODES = "off";
	modesExtension({} as ExtensionAPI);
	if (prev === undefined) delete process.env.PI_EXT_MODES;
	else process.env.PI_EXT_MODES = prev;
});

function knob(key: string) {
	const schema = getDeclaredExtension("modes")?.configSchema ?? [];
	const found = schema.find((k) => k.key === key);
	if (!found) throw new Error(`modes configSchema has no key "${key}"`);
	return found;
}

describe("modes configSchema enum knobs", () => {
	it("defaultMode is an enum whose values all pass resolveDefaultMode", () => {
		const k = knob("defaultMode");
		expect(k.type).toBe("enum");
		expect(k.enumValues).toBeDefined();
		for (const v of k.enumValues ?? []) {
			expect(resolveDefaultMode(v)).toEqual({ mode: v, valid: true });
		}
		// A value outside the enum must be rejected by the validator, so the
		// advertised choices can't silently drift ahead of the accept-list.
		expect(resolveDefaultMode("not-a-mode").valid).toBe(false);
	});

	it("implementDefault is an enum whose values all pass resolveImplementDefault", () => {
		const k = knob("implementDefault");
		expect(k.type).toBe("enum");
		expect(k.enumValues).toBeDefined();
		for (const v of k.enumValues ?? []) {
			expect(resolveImplementDefault(v)).toEqual({ mode: v, valid: true });
		}
		expect(resolveImplementDefault("plan").valid).toBe(false);
	});

	it("review.agents enumValues match the review allowlist (no drift)", () => {
		const k = knob("review.agents");
		expect(k.type).toBe("string[]");
		expect(new Set(k.enumValues)).toEqual(new Set(VALID_REVIEWER_ROLES));
	});

	it("review.agents default is a subset of its enumValues", () => {
		const k = knob("review.agents");
		const allowed = new Set(k.enumValues);
		for (const role of (k.default as string[]) ?? []) {
			expect(allowed.has(role)).toBe(true);
		}
	});
});
