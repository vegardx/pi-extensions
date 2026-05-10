import { describe, expect, it } from "vitest";
import {
	buildTransitionOptions,
	decideFromChoice,
} from "../plan/transition.js";

describe("buildTransitionOptions", () => {
	it("returns null when transitioning into a non-plan mode", () => {
		expect(
			buildTransitionOptions({
				hasUI: true,
				prev: "auto",
				next: "ask",
				activePhaseId: "p-1",
			}),
		).toBeNull();
	});

	it("returns null when previous mode wasn't auto/hack", () => {
		expect(
			buildTransitionOptions({
				hasUI: true,
				prev: "ask",
				next: "plan",
				activePhaseId: "p-1",
			}),
		).toBeNull();

		expect(
			buildTransitionOptions({
				hasUI: true,
				prev: "plan",
				next: "plan",
				activePhaseId: "p-1",
			}),
		).toBeNull();
	});

	it("returns null when headless (!hasUI) — silently keep context", () => {
		expect(
			buildTransitionOptions({
				hasUI: false,
				prev: "auto",
				next: "plan",
				activePhaseId: "p-1",
			}),
		).toBeNull();

		expect(
			buildTransitionOptions({
				hasUI: false,
				prev: "hack",
				next: "plan",
				activePhaseId: null,
			}),
		).toBeNull();
	});

	it("auto → plan with active phase: 3 options including lossy compact", () => {
		const built = buildTransitionOptions({
			hasUI: true,
			prev: "auto",
			next: "plan",
			activePhaseId: "p-webhook",
		});
		expect(built).not.toBeNull();
		expect(built?.options).toEqual([
			"Keep current context",
			"Lossy-compact phase `p-webhook` first",
			"New session",
		]);
		expect(built?.title).toContain("from auto");
	});

	it("hack → plan with no active phase: 2 options", () => {
		const built = buildTransitionOptions({
			hasUI: true,
			prev: "hack",
			next: "plan",
			activePhaseId: null,
		});
		expect(built).not.toBeNull();
		expect(built?.options).toEqual(["Keep current context", "New session"]);
		expect(built?.title).toContain("from hack");
	});

	it("hack → plan with active phase: also offers lossy compact", () => {
		// Active phase persists across mode flips — even if user is currently
		// in hack, they may have ended up here from auto with a phase. The
		// option helps them clean up before switching to plan.
		const built = buildTransitionOptions({
			hasUI: true,
			prev: "hack",
			next: "plan",
			activePhaseId: "p-1",
		});
		expect(built?.options).toContain("Lossy-compact phase `p-1` first");
	});
});

describe("decideFromChoice", () => {
	it("undefined choice (dialog cancelled) → flip", () => {
		expect(decideFromChoice(undefined, "p-1")).toEqual({ action: "flip" });
	});

	it("'Keep current context' → flip", () => {
		expect(decideFromChoice("Keep current context", "p-1")).toEqual({
			action: "flip",
		});
	});

	it("'New session' → newSession", () => {
		expect(decideFromChoice("New session", null)).toEqual({
			action: "newSession",
		});
	});

	it("'Lossy-compact phase ...' with active phase → compact", () => {
		expect(decideFromChoice("Lossy-compact phase `p-1` first", "p-1")).toEqual({
			action: "compact",
			phaseId: "p-1",
		});
	});

	it("'Lossy-compact phase ...' WITHOUT active phase → flip (defensive)", () => {
		// Shouldn't be reachable in practice (option isn't offered without a
		// phase) but we don't want to throw on unexpected input.
		expect(decideFromChoice("Lossy-compact phase `p-1` first", null)).toEqual({
			action: "flip",
		});
	});

	it("unknown string → flip (defensive)", () => {
		expect(decideFromChoice("something else entirely", "p-1")).toEqual({
			action: "flip",
		});
	});
});
