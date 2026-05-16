import type { RelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import {
	BUILTIN_LANE_DEFAULTS,
	type LaneId,
	resolveAllLanes,
	resolveLaneSpec,
} from "../lanes.js";

function settings(reviewCfg?: unknown): RelevantSettings {
	return {
		extensionConfig: { review: reviewCfg },
	} as RelevantSettings;
}

describe("resolveLaneSpec", () => {
	it("returns built-in default when settings is empty", () => {
		const spec = resolveLaneSpec(settings(), "code-reviewer");
		expect(spec).toEqual({ set: "secondary", tier: "normal" });
	});

	it("returns the heavy default for security-analyst", () => {
		expect(resolveLaneSpec(settings(), "security-analyst")).toEqual({
			set: "secondary",
			tier: "heavy",
		});
	});

	it("returns the heavy default for orchestrator", () => {
		expect(resolveLaneSpec(settings(), "orchestrator")).toEqual({
			set: "secondary",
			tier: "heavy",
		});
	});

	it("uses defaultLane when lanes.<id> is unset", () => {
		const cfg = settings({
			defaultLane: { set: "primary", tier: "fast" },
		});
		expect(resolveLaneSpec(cfg, "code-reviewer")).toEqual({
			set: "primary",
			tier: "fast",
		});
	});

	it("uses lanes.<id> over defaultLane", () => {
		const cfg = settings({
			defaultLane: { set: "primary", tier: "normal" },
			lanes: {
				architect: { set: "secondary", tier: "heavy" },
			},
		});
		expect(resolveLaneSpec(cfg, "architect")).toEqual({
			set: "secondary",
			tier: "heavy",
		});
		// Other lanes still use defaultLane.
		expect(resolveLaneSpec(cfg, "code-reviewer")).toEqual({
			set: "primary",
			tier: "normal",
		});
	});

	it("falls through invalid lanes.<id> to defaultLane", () => {
		const cfg = settings({
			defaultLane: { set: "primary", tier: "heavy" },
			lanes: {
				architect: { set: "tertiary", tier: "huge" }, // both invalid
			},
		});
		expect(resolveLaneSpec(cfg, "architect")).toEqual({
			set: "primary",
			tier: "heavy",
		});
	});

	it("falls through invalid defaultLane to built-in default", () => {
		const cfg = settings({
			defaultLane: { set: "tertiary", tier: "fast" }, // invalid set
		});
		expect(resolveLaneSpec(cfg, "code-reviewer")).toEqual(
			BUILTIN_LANE_DEFAULTS["code-reviewer"],
		);
	});

	it("rejects partial entries (missing tier)", () => {
		const cfg = settings({
			lanes: { architect: { set: "primary" } },
		});
		expect(resolveLaneSpec(cfg, "architect")).toEqual(
			BUILTIN_LANE_DEFAULTS.architect,
		);
	});

	it("rejects array-shaped review config", () => {
		const cfg = settings([
			{ set: "primary", tier: "fast" },
		] as unknown as object);
		expect(resolveLaneSpec(cfg, "code-reviewer")).toEqual(
			BUILTIN_LANE_DEFAULTS["code-reviewer"],
		);
	});

	it("rejects non-object review config", () => {
		const cfg = settings("oops");
		expect(resolveLaneSpec(cfg, "code-reviewer")).toEqual(
			BUILTIN_LANE_DEFAULTS["code-reviewer"],
		);
	});
});

describe("resolveAllLanes", () => {
	it("returns built-in defaults when no settings", () => {
		expect(resolveAllLanes(settings())).toEqual(BUILTIN_LANE_DEFAULTS);
	});

	it("applies overrides per lane while keeping defaults for the rest", () => {
		const cfg = settings({
			lanes: {
				index: { set: "primary", tier: "fast" },
				orchestrator: { set: "primary", tier: "heavy" },
			},
		});
		const all = resolveAllLanes(cfg);
		expect(all.index).toEqual({ set: "primary", tier: "fast" });
		expect(all.orchestrator).toEqual({ set: "primary", tier: "heavy" });
		// Untouched lanes keep built-in defaults.
		expect(all["code-reviewer"]).toEqual(
			BUILTIN_LANE_DEFAULTS["code-reviewer"],
		);
		expect(all["security-analyst"]).toEqual(
			BUILTIN_LANE_DEFAULTS["security-analyst"],
		);
	});

	it("returns every LaneId key", () => {
		const all = resolveAllLanes(settings());
		const expected: LaneId[] = [
			"index",
			"architect",
			"code-reviewer",
			"scope-analyst",
			"security-analyst",
			"code-simplifier",
			"doc-reviewer",
			"dependency-checker",
			"orchestrator",
		];
		expect(Object.keys(all).sort()).toEqual([...expected].sort());
	});
});
