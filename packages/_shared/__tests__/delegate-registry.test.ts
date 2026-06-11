/**
 * Tests for the cross-extension delegate-target registry.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	availableDelegateTargets,
	clearDelegateTargets,
	type DelegateTarget,
	getDelegateTarget,
	listDelegateTargets,
	registerDelegateTarget,
} from "../delegate-registry.js";

const REGISTRY_KEY = "__pi_ext_delegate_registry__";

function makeTarget(
	name: string,
	extra?: Partial<DelegateTarget>,
): DelegateTarget {
	return {
		name,
		description: `${name} target`,
		execute: async ({ message }) => ({ text: `${name}: ${message}` }),
		...extra,
	};
}

const fakeCtx = {} as ExtensionContext;

describe("delegate-registry", () => {
	beforeEach(() => {
		clearDelegateTargets();
	});

	it("register + get round-trips a target", async () => {
		registerDelegateTarget(makeTarget("researcher"));
		const t = getDelegateTarget("researcher");
		expect(t?.description).toBe("researcher target");
		const out = await t?.execute({ message: "hi", ctx: fakeCtx });
		expect(out?.text).toBe("researcher: hi");
	});

	it("get returns undefined for unknown names", () => {
		expect(getDelegateTarget("nope")).toBeUndefined();
	});

	it("list returns targets in registration order", () => {
		registerDelegateTarget(makeTarget("b"));
		registerDelegateTarget(makeTarget("a"));
		expect(listDelegateTargets().map((t) => t.name)).toEqual(["b", "a"]);
	});

	it("re-registration is last-wins", () => {
		registerDelegateTarget(makeTarget("x", { description: "first" }));
		registerDelegateTarget(makeTarget("x", { description: "second" }));
		expect(listDelegateTargets()).toHaveLength(1);
		expect(getDelegateTarget("x")?.description).toBe("second");
	});

	it("availableDelegateTargets treats missing isAvailable as available", () => {
		registerDelegateTarget(makeTarget("always"));
		registerDelegateTarget(makeTarget("gated", { isAvailable: () => false }));
		expect(availableDelegateTargets(fakeCtx).map((t) => t.name)).toEqual([
			"always",
		]);
	});

	it("clear empties the registry", () => {
		registerDelegateTarget(makeTarget("x"));
		clearDelegateTargets();
		expect(listDelegateTargets()).toEqual([]);
	});

	it("registry lives on globalThis so separate bundles share it", () => {
		registerDelegateTarget(makeTarget("shared"));
		const map = (globalThis as Record<string, unknown>)[REGISTRY_KEY] as Map<
			string,
			DelegateTarget
		>;
		expect(map.get("shared")?.name).toBe("shared");
	});
});
