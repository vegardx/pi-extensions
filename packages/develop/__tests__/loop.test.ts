import {
	aggregateConcerns,
	buildPostLoopPickerOptions,
	decideLoopAction,
	detectNoProgress,
	toVerdictSnapshot,
	type VerifyVerdictLike,
} from "../plan-utils.js";

describe("aggregateConcerns", () => {
	it("returns empty + isClean when all done/unverifiable", () => {
		const verdicts: VerifyVerdictLike[] = [
			{ step: 1, status: "done" },
			{ step: 2, status: "unverifiable" },
			{ step: 3, status: "done" },
		];
		expect(aggregateConcerns(verdicts)).toEqual({
			concernSteps: [],
			isClean: true,
		});
	});

	it("collects partial+missing as concerns, in input order", () => {
		const verdicts: VerifyVerdictLike[] = [
			{ step: 1, status: "done" },
			{ step: 2, status: "partial" },
			{ step: 3, status: "missing" },
			{ step: 4, status: "done" },
			{ step: 5, status: "partial" },
		];
		expect(aggregateConcerns(verdicts)).toEqual({
			concernSteps: [2, 3, 5],
			isClean: false,
		});
	});

	it("treats unverifiable as clean (not a concern)", () => {
		expect(aggregateConcerns([{ step: 1, status: "unverifiable" }])).toEqual({
			concernSteps: [],
			isClean: true,
		});
	});
});

describe("detectNoProgress", () => {
	it("returns false when prev is undefined or empty (first iteration)", () => {
		const curr: VerifyVerdictLike[] = [{ step: 1, status: "partial" }];
		expect(detectNoProgress(undefined, curr)).toBe(false);
		expect(detectNoProgress([], curr)).toBe(false);
	});

	it("returns false when prev had no concerns", () => {
		const prev: VerifyVerdictLike[] = [{ step: 1, status: "done" }];
		const curr: VerifyVerdictLike[] = [{ step: 1, status: "partial" }];
		expect(detectNoProgress(prev, curr)).toBe(false);
	});

	it("returns true when same step is partial in both iterations", () => {
		const prev: VerifyVerdictLike[] = [{ step: 3, status: "partial" }];
		const curr: VerifyVerdictLike[] = [
			{ step: 1, status: "done" },
			{ step: 3, status: "partial" },
		];
		expect(detectNoProgress(prev, curr)).toBe(true);
	});

	it("returns true when same step is missing in both iterations", () => {
		const prev: VerifyVerdictLike[] = [{ step: 2, status: "missing" }];
		const curr: VerifyVerdictLike[] = [{ step: 2, status: "missing" }];
		expect(detectNoProgress(prev, curr)).toBe(true);
	});

	it("treats partial→missing on same step as no-progress (still stuck)", () => {
		const prev: VerifyVerdictLike[] = [{ step: 4, status: "partial" }];
		const curr: VerifyVerdictLike[] = [{ step: 4, status: "missing" }];
		expect(detectNoProgress(prev, curr)).toBe(true);
	});

	it("returns false when concerns shifted to entirely different steps", () => {
		const prev: VerifyVerdictLike[] = [{ step: 1, status: "partial" }];
		const curr: VerifyVerdictLike[] = [{ step: 5, status: "missing" }];
		expect(detectNoProgress(prev, curr)).toBe(false);
	});

	it("returns false when previously-stuck step healed (even if a new one broke)", () => {
		const prev: VerifyVerdictLike[] = [{ step: 1, status: "partial" }];
		const curr: VerifyVerdictLike[] = [
			{ step: 1, status: "done" },
			{ step: 5, status: "partial" },
		];
		expect(detectNoProgress(prev, curr)).toBe(false);
	});
});

describe("decideLoopAction", () => {
	const cap = 5;

	it("exit-clean when verdicts all green and no errors", () => {
		const decision = decideLoopAction({
			iteration: 1,
			cap,
			prevVerdicts: undefined,
			currVerdicts: [
				{ step: 1, status: "done" },
				{ step: 2, status: "unverifiable" },
			],
			errorCount: 0,
		});
		expect(decision).toEqual({ kind: "exit-clean" });
	});

	it("retry on first iteration with concerns and no prev to compare", () => {
		const decision = decideLoopAction({
			iteration: 1,
			cap,
			prevVerdicts: undefined,
			currVerdicts: [
				{ step: 1, status: "done" },
				{ step: 2, status: "partial" },
			],
			errorCount: 0,
		});
		expect(decision).toEqual({
			kind: "retry",
			concernSteps: [2],
			nextIteration: 2,
		});
	});

	it("bail-cap when iteration ≥ cap with concerns outstanding", () => {
		const decision = decideLoopAction({
			iteration: 5,
			cap,
			prevVerdicts: [{ step: 1, status: "partial" }],
			currVerdicts: [{ step: 2, status: "partial" }],
			errorCount: 0,
		});
		expect(decision).toMatchObject({
			kind: "bail-cap",
			concernCount: 1,
			errorCount: 0,
			iteration: 5,
		});
	});

	it("bail-no-progress beats cap-not-reached when same step stuck", () => {
		const decision = decideLoopAction({
			iteration: 2,
			cap,
			prevVerdicts: [{ step: 3, status: "partial" }],
			currVerdicts: [{ step: 3, status: "partial" }],
			errorCount: 0,
		});
		expect(decision).toMatchObject({
			kind: "bail-no-progress",
			concernCount: 1,
			iteration: 2,
		});
	});

	it("cap takes precedence over no-progress when both apply", () => {
		// iteration === cap means we're done either way; cap is reported.
		const decision = decideLoopAction({
			iteration: 5,
			cap,
			prevVerdicts: [{ step: 1, status: "partial" }],
			currVerdicts: [{ step: 1, status: "partial" }],
			errorCount: 0,
		});
		expect(decision.kind).toBe("bail-cap");
	});

	it("errors-only with no concerns blocks clean exit (still retry)", () => {
		const decision = decideLoopAction({
			iteration: 1,
			cap,
			prevVerdicts: undefined,
			currVerdicts: [{ step: 1, status: "done" }],
			errorCount: 2,
		});
		expect(decision.kind).toBe("retry");
	});

	it("clean verdicts but iteration overshoots cap still retries (impossible state, exits clean)", () => {
		// Defensive: clean wins regardless.
		const decision = decideLoopAction({
			iteration: 9,
			cap,
			prevVerdicts: [{ step: 1, status: "partial" }],
			currVerdicts: [{ step: 1, status: "done" }],
			errorCount: 0,
		});
		expect(decision).toEqual({ kind: "exit-clean" });
	});
});

describe("toVerdictSnapshot", () => {
	it("strips reason/suggestion, keeps step+status", () => {
		const snapshot = toVerdictSnapshot([
			{
				step: 1,
				status: "partial",
				// extras the loop driver doesn't care about; cast loose
				...({ reason: "x", suggestion: "y" } as Record<string, unknown>),
			} as VerifyVerdictLike,
		]);
		expect(snapshot).toEqual([{ step: 1, status: "partial" }]);
	});
});

describe("buildPostLoopPickerOptions", () => {
	it("Stay here always present, even when no follow-ups installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(),
			loopBailed: false,
			unresolvedConcerns: 0,
		});
		expect(options).toEqual(["Stay here — I'll handle it"]);
	});

	it("only review when only review installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["review"]),
			loopBailed: false,
			unresolvedConcerns: 0,
		});
		expect(options).toEqual(["Run /review", "Stay here — I'll handle it"]);
	});

	it("only commit when only commit installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["commit"]),
			loopBailed: false,
			unresolvedConcerns: 0,
		});
		expect(options).toEqual(["Run /commit", "Stay here — I'll handle it"]);
	});

	it("review+commit when both installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["review", "commit"]),
			loopBailed: false,
			unresolvedConcerns: 0,
		});
		expect(options).toEqual([
			"Run /review",
			"Run /commit",
			"Stay here — I'll handle it",
		]);
	});

	it("annotates Run /commit with concern count when bailed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["commit"]),
			loopBailed: true,
			unresolvedConcerns: 3,
		});
		expect(options).toEqual([
			"Run /commit (with 3 unresolved concerns)",
			"Stay here — I'll handle it",
		]);
	});

	it("uses singular 'concern' when only one unresolved", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["commit"]),
			loopBailed: true,
			unresolvedConcerns: 1,
		});
		expect(options).toEqual([
			"Run /commit (with 1 unresolved concern)",
			"Stay here — I'll handle it",
		]);
	});

	it("does not annotate when bailed but no unresolved concerns (verifier-error-only bail)", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["commit"]),
			loopBailed: true,
			unresolvedConcerns: 0,
		});
		expect(options).toEqual(["Run /commit", "Stay here — I'll handle it"]);
	});

	it("review unaffected by bail annotation (concerns are about committing, not reviewing)", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["review", "commit"]),
			loopBailed: true,
			unresolvedConcerns: 2,
		});
		expect(options[0]).toBe("Run /review");
		expect(options[1]).toBe("Run /commit (with 2 unresolved concerns)");
	});
});
