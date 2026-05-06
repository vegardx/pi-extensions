import {
	buildPostLoopPickerOptions,
	cleanStepText,
	decideAutoReviewNextAction,
	extractDoneSteps,
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
} from "../plan-utils.js";

describe("buildPostLoopPickerOptions", () => {
	it("Stay here always present, even when no follow-ups installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(),
		});
		expect(options).toEqual(["Stay here — I'll handle it"]);
	});

	it("only review when only review installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["review"]),
		});
		expect(options).toEqual(["Run /review", "Stay here — I'll handle it"]);
	});

	it("only commit when only commit installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["commit"]),
		});
		expect(options).toEqual(["Run /commit", "Stay here — I'll handle it"]);
	});

	it("review+commit when both installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["review", "commit"]),
		});
		expect(options).toEqual([
			"Run /review",
			"Run /commit",
			"Stay here — I'll handle it",
		]);
	});
});

describe("decideAutoReviewNextAction", () => {
	it("skips to picker when the auto-review pass didn't run", () => {
		expect(
			decideAutoReviewNextAction({
				ran: false,
				appliedCount: 0,
				surfacedCount: 0,
			}),
		).toBe("skip-to-picker");
		// Even if a leftover applied-count is nonzero, a non-run pass
		// can't have queued anything for the host — still skip.
		expect(
			decideAutoReviewNextAction({
				ran: false,
				appliedCount: 5,
				surfacedCount: 0,
			}),
		).toBe("skip-to-picker");
	});

	it("skips to picker when the pass ran but found no consensus", () => {
		expect(
			decideAutoReviewNextAction({
				ran: true,
				appliedCount: 0,
				surfacedCount: 0,
			}),
		).toBe("skip-to-picker");
	});

	it("applies fixes when at least one consensus finding was queued", () => {
		expect(
			decideAutoReviewNextAction({
				ran: true,
				appliedCount: 1,
				surfacedCount: 0,
			}),
		).toBe("apply-fixes");
		expect(
			decideAutoReviewNextAction({
				ran: true,
				appliedCount: 12,
				surfacedCount: 0,
			}),
		).toBe("apply-fixes");
	});

	it("applies fixes when surfaced findings need discussion even with no auto-applied", () => {
		expect(
			decideAutoReviewNextAction({
				ran: true,
				appliedCount: 0,
				surfacedCount: 1,
			}),
		).toBe("apply-fixes");
		expect(
			decideAutoReviewNextAction({
				ran: true,
				appliedCount: 2,
				surfacedCount: 3,
			}),
		).toBe("apply-fixes");
	});

	it("treats negative applied counts defensively as skip-to-picker", () => {
		// Shouldn't happen in practice, but make sure the boundary is
		// `> 0` not `!= 0` so a defensive negative still routes safely.
		expect(
			decideAutoReviewNextAction({
				ran: true,
				appliedCount: -1,
				surfacedCount: 0,
			}),
		).toBe("skip-to-picker");
	});
});

describe("isSafeCommand", () => {
	it("allows read-only commands", () => {
		expect(isSafeCommand("cat README.md")).toBe(true);
		expect(isSafeCommand("grep -r 'foo' src/")).toBe(true);
		expect(isSafeCommand("ls -la")).toBe(true);
		expect(isSafeCommand("git status")).toBe(true);
		expect(isSafeCommand("git log --oneline -10")).toBe(true);
		expect(isSafeCommand("git diff HEAD~1")).toBe(true);
		expect(isSafeCommand("find . -name '*.ts'")).toBe(true);
		expect(isSafeCommand("wc -l src/index.ts")).toBe(true);
	});

	it("blocks destructive commands", () => {
		expect(isSafeCommand("rm -rf dist/")).toBe(false);
		expect(isSafeCommand("git commit -m 'wip'")).toBe(false);
		expect(isSafeCommand("npm install")).toBe(false);
		expect(isSafeCommand("git push origin main")).toBe(false);
	});

	it("blocks commands with redirections", () => {
		expect(isSafeCommand("cat README.md > out.txt")).toBe(false);
		expect(isSafeCommand("echo foo >> file.txt")).toBe(false);
	});
});

describe("cleanStepText", () => {
	it("strips markdown emphasis", () => {
		expect(cleanStepText("**Write** the tests")).toBe("Tests");
		expect(cleanStepText("*Update* the config file")).toBe("Config file");
	});

	it("strips inline code backticks", () => {
		// `foo` → foo, then leading verbs are also stripped
		expect(cleanStepText("Run `npm test`")).toBe("Npm test");
	});

	it("strips common leading verbs", () => {
		expect(cleanStepText("Create the new module")).toBe("New module");
		expect(cleanStepText("Update the README")).toBe("README");
	});

	it("capitalises first character after transformations", () => {
		// submit is not a stripped verb, so first char capitalises directly
		expect(cleanStepText("submit a detailed change").charAt(0)).toBe("S");
	});

	it("truncates at 60 chars", () => {
		const long = "a".repeat(70);
		const result = cleanStepText(long);
		expect(result.length).toBeLessThanOrEqual(60);
		expect(result.endsWith("...")).toBe(true);
	});
});

describe("extractTodoItems", () => {
	it("returns empty array when no Plan: header", () => {
		expect(extractTodoItems("some text without a plan header")).toEqual([]);
	});

	it("parses numbered steps under a Plan: header", () => {
		const text = `
Plan:
1. Write unit tests
2. Update documentation
3. Submit PR
`;
		const items = extractTodoItems(text);
		expect(items).toHaveLength(3);
		expect(items[0]?.step).toBe(1);
		expect(items[1]?.step).toBe(2);
		expect(items[2]?.step).toBe(3);
		expect(items.every((t) => !t.completed)).toBe(true);
	});

	it("accepts bolded Plan: header", () => {
		const text = "**Plan:**\n1. Do something meaningful here\n";
		const items = extractTodoItems(text);
		expect(items).toHaveLength(1);
	});

	it("accepts ## Plan: heading", () => {
		const text = "## Plan:\n1. First step with enough text\n";
		expect(extractTodoItems(text)).toHaveLength(1);
	});

	it("skips steps that start with ` / -", () => {
		const text =
			"Plan:\n1. `code-only step`\n2. /some/path\n3. - bullet item\n4. Real step here\n";
		const items = extractTodoItems(text);
		expect(items).toHaveLength(1);
		expect(items[0]?.text).toBe("Real step here");
	});
});

describe("extractDoneSteps", () => {
	it("returns empty array when no markers", () => {
		expect(extractDoneSteps("no markers here")).toEqual([]);
	});

	it("extracts [DONE:n] markers", () => {
		expect(extractDoneSteps("did [DONE:1] then [DONE:3]")).toEqual([1, 3]);
	});

	it("deduplicates repeated markers", () => {
		expect(extractDoneSteps("[DONE:2] and [DONE:2] again")).toEqual([2]);
	});

	it("is case-insensitive", () => {
		expect(extractDoneSteps("[done:4]")).toEqual([4]);
	});

	it("returns steps sorted numerically", () => {
		expect(extractDoneSteps("[DONE:5] [DONE:1] [DONE:3]")).toEqual([1, 3, 5]);
	});
});

describe("markCompletedSteps", () => {
	it("marks matching steps complete", () => {
		const items = [
			{ step: 1, text: "first", completed: false },
			{ step: 2, text: "second", completed: false },
		];
		const count = markCompletedSteps("[DONE:1]", items);
		expect(count).toBe(1);
		expect(items[0]?.completed).toBe(true);
		expect(items[1]?.completed).toBe(false);
	});

	it("returns 0 when no new completions", () => {
		const items = [{ step: 1, text: "first", completed: true }];
		expect(markCompletedSteps("[DONE:1]", items)).toBe(0);
	});

	it("does not count already-completed steps", () => {
		const items = [
			{ step: 1, text: "first", completed: true },
			{ step: 2, text: "second", completed: false },
		];
		const count = markCompletedSteps("[DONE:1] [DONE:2]", items);
		expect(count).toBe(1);
	});
});
