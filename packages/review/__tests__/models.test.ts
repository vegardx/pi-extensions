/**
 * Per-agent model resolution: `review.models.<id>` → `review.defaultModel`
 * → built-in defaults, with invalid entries failing closed.
 */

import type { RelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import {
	ALL_LENSES,
	BUILTIN_MODEL_DEFAULTS,
	isLensId,
	resolveAgentModelSpec,
	resolveAllAgentModels,
} from "../models.js";

function settings(review?: unknown): RelevantSettings {
	return {
		extensionConfig: review ? { review } : {},
	} as RelevantSettings;
}

describe("review models config", () => {
	it("falls back to built-in defaults with no settings", () => {
		const all = resolveAllAgentModels(settings());
		expect(all).toEqual(BUILTIN_MODEL_DEFAULTS);
		// Deep lenses that need depth get heavy; the rest stay normal.
		expect(all.security).toEqual({ set: "secondary", tier: "heavy" });
		expect(all.curator).toEqual({ set: "secondary", tier: "heavy" });
		expect(all.generic).toEqual({ set: "secondary", tier: "normal" });
		expect(all["code-review"]).toEqual({ set: "secondary", tier: "normal" });
		expect(all.simplification).toEqual({ set: "secondary", tier: "normal" });
		expect(all.indexer).toEqual({ set: "secondary", tier: "normal" });
	});

	it("review.models.<agent> overrides one agent only", () => {
		const s = settings({
			models: { security: { set: "primary", tier: "heavy" } },
		});
		expect(resolveAgentModelSpec(s, "security")).toEqual({
			set: "primary",
			tier: "heavy",
		});
		expect(resolveAgentModelSpec(s, "generic")).toEqual(
			BUILTIN_MODEL_DEFAULTS.generic,
		);
	});

	it("review.defaultModel applies to every agent without an explicit override", () => {
		const s = settings({
			defaultModel: { set: "primary", tier: "fast" },
			models: { curator: { set: "secondary", tier: "heavy" } },
		});
		expect(resolveAgentModelSpec(s, "generic")).toEqual({
			set: "primary",
			tier: "fast",
		});
		expect(resolveAgentModelSpec(s, "curator")).toEqual({
			set: "secondary",
			tier: "heavy",
		});
	});

	it("invalid entries fail closed through to the next layer", () => {
		const s = settings({
			models: { security: { set: "tertiary", tier: "heavy" } },
			defaultModel: { set: "primary" },
		});
		expect(resolveAgentModelSpec(s, "security")).toEqual(
			BUILTIN_MODEL_DEFAULTS.security,
		);
	});

	it("isLensId accepts exactly the four lenses", () => {
		for (const l of ALL_LENSES) expect(isLensId(l)).toBe(true);
		expect(isLensId("architect")).toBe(false);
		expect(isLensId("curator")).toBe(false);
		expect(isLensId("indexer")).toBe(false);
	});
});
