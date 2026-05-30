import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getDeclaredExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
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
		const k = knob("mode.default");
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
		const k = knob("implement.default");
		expect(k.type).toBe("enum");
		expect(k.enumValues).toBeDefined();
		for (const v of k.enumValues ?? []) {
			expect(resolveImplementDefault(v)).toEqual({ mode: v, valid: true });
		}
		expect(resolveImplementDefault("plan").valid).toBe(false);
	});

	it("does not advertise deprecated local autoreview knobs", () => {
		const schema = getDeclaredExtension("modes")?.configSchema ?? [];
		expect(schema.some((k) => k.key === "review.enable")).toBe(false);
		expect(schema.some((k) => k.key === "review.agents")).toBe(false);
	});

	it("uses unset semantics for optional no-value knobs", () => {
		expect(knob("park.githubProject").default).toBeUndefined();
		expect(knob("compaction.planMaxContextTokens").default).toBeUndefined();
	});

	it("advertises updated delegation and explore defaults", () => {
		expect(knob("research.timeoutMs").default).toBe(120000);
		expect(knob("delegate.maxConcurrent").default).toBe(10);
		expect(knob("explore.parallelism").default).toBe(2);
	});
});
