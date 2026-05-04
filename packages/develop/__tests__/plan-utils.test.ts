import {
	cleanStepText,
	extractDoneSteps,
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "../plan-utils.js";

describe("isSafeCommand", () => {
	it("accepts read-only exploration commands", () => {
		expect(isSafeCommand("ls -la")).toBe(true);
		expect(isSafeCommand("cat foo.ts")).toBe(true);
		expect(isSafeCommand("grep -r foo src/")).toBe(true);
		expect(isSafeCommand("rg bar packages/")).toBe(true);
		expect(isSafeCommand("find . -name '*.ts'")).toBe(true);
		expect(isSafeCommand("git status")).toBe(true);
		expect(isSafeCommand("git log --oneline -20")).toBe(true);
		expect(isSafeCommand("git diff HEAD")).toBe(true);
		expect(isSafeCommand("npm outdated")).toBe(true);
	});

	it("blocks destructive file operations", () => {
		expect(isSafeCommand("rm foo.ts")).toBe(false);
		expect(isSafeCommand("rm -rf build/")).toBe(false);
		expect(isSafeCommand("mv a b")).toBe(false);
		expect(isSafeCommand("cp a b")).toBe(false);
		expect(isSafeCommand("mkdir foo")).toBe(false);
		expect(isSafeCommand("touch foo")).toBe(false);
	});

	it("blocks destructive git operations", () => {
		expect(isSafeCommand("git add .")).toBe(false);
		expect(isSafeCommand("git commit -m 'x'")).toBe(false);
		expect(isSafeCommand("git push")).toBe(false);
		expect(isSafeCommand("git reset --hard HEAD")).toBe(false);
		expect(isSafeCommand("git checkout main")).toBe(false);
	});

	it("blocks package-install commands", () => {
		expect(isSafeCommand("npm install react")).toBe(false);
		expect(isSafeCommand("yarn add lodash")).toBe(false);
		expect(isSafeCommand("pip install numpy")).toBe(false);
		expect(isSafeCommand("brew install jq")).toBe(false);
	});

	it("blocks output redirection even with otherwise-safe commands", () => {
		expect(isSafeCommand("cat foo > bar")).toBe(false);
		expect(isSafeCommand("ls >> log.txt")).toBe(false);
	});

	it("blocks sudo and process killers", () => {
		expect(isSafeCommand("sudo ls")).toBe(false);
		expect(isSafeCommand("kill -9 123")).toBe(false);
		expect(isSafeCommand("pkill node")).toBe(false);
	});

	it("blocks interactive editors", () => {
		expect(isSafeCommand("vim foo")).toBe(false);
		expect(isSafeCommand("nano bar")).toBe(false);
		expect(isSafeCommand("code .")).toBe(false);
	});

	it("blocks unrecognised commands (default-deny for anything not on the allowlist)", () => {
		// Unknown command — no safe-pattern match, not destructive, still blocked.
		expect(isSafeCommand("unknowntool --do-stuff")).toBe(false);
		expect(isSafeCommand("./my-script.sh")).toBe(false);
	});
});

describe("cleanStepText", () => {
	it("strips markdown emphasis and inline code", () => {
		// `Add` is stripped as a leading imperative verb too.
		expect(cleanStepText("**Add** the `payload` parser")).toBe(
			"Payload parser",
		);
	});

	it("strips leading imperative verb + optional 'the'", () => {
		expect(cleanStepText("Create the new parser module")).toBe(
			"New parser module",
		);
		// Without 'the', only the verb is stripped.
		expect(cleanStepText("Create a new parser module")).toBe(
			"A new parser module",
		);
	});

	it("caps length at 60 chars with ellipsis", () => {
		const long = "Add ".repeat(30);
		const result = cleanStepText(long);
		expect(result.length).toBeLessThanOrEqual(60);
		expect(result.endsWith("...")).toBe(true);
	});

	it("collapses runs of whitespace", () => {
		// 'Something' is not in the verb list, so nothing is stripped;
		// only whitespace is collapsed and the first letter capitalized.
		expect(cleanStepText("something    like\n\tthis")).toBe(
			"Something like this",
		);
	});
});

describe("extractTodoItems", () => {
	it("parses a basic numbered plan", () => {
		const msg = [
			"Here's my plan.",
			"",
			"Plan:",
			"1. Add the webhook route",
			"2. Wire up the refund handler",
			"3. Add tests",
			"",
			"Risks: network retries.",
		].join("\n");
		const items = extractTodoItems(msg);
		expect(items).toHaveLength(3);
		// `Add the ` is stripped as a leading imperative + 'the'.
		expect(items[0]?.text).toBe("Webhook route");
		// `Wire` is not in the verb list; whole text kept, first letter capitalized.
		expect(items[1]?.text).toBe("Wire up the refund handler");
		// `Add ` is stripped; `tests` stays as-is until the final capitalize.
		expect(items[2]?.text).toBe("Tests");
		expect(items.every((i) => !i.completed)).toBe(true);
		expect(items.map((i) => i.step)).toEqual([1, 2, 3]);
	});

	it("accepts bolded and heading-style Plan headers", () => {
		expect(
			extractTodoItems(
				"**Plan:**\n1. Add the webhook route\n2. Wire up the refund handler",
			),
		).toHaveLength(2);
		expect(
			extractTodoItems(
				"## Plan:\n1. Add the webhook route\n2. Wire up the refund handler",
			),
		).toHaveLength(2);
	});

	it("accepts `1)` style numbering", () => {
		expect(
			extractTodoItems("Plan:\n1) First step text\n2) Second step text"),
		).toHaveLength(2);
	});

	it("returns empty when no Plan header is present", () => {
		expect(
			extractTodoItems("Here's what we'll do:\n1. Step one\n2. Step two"),
		).toEqual([]);
	});

	it("drops lines that look like code / paths / bullets, not steps", () => {
		const msg = [
			"Plan:",
			"1. `git checkout -b feat/foo`",
			"2. /usr/local/bin/foo is the tool",
			"3. - bullet item, not a step",
			"4. Add the actual step we care about",
		].join("\n");
		const items = extractTodoItems(msg);
		expect(items).toHaveLength(1);
		expect(items[0]?.text).toContain("Actual step");
		// Renumbered to start at 1.
		expect(items[0]?.step).toBe(1);
	});

	it("is not fooled by numbered lists elsewhere in the document", () => {
		const msg = [
			"Context about the codebase:",
			"1. It has webhooks",
			"2. It has refunds",
			"",
			"Plan:",
			"1. Add the route",
			"2. Add tests",
		].join("\n");
		expect(extractTodoItems(msg)).toHaveLength(2);
	});
});

describe("extractDoneSteps", () => {
	it("pulls every [DONE:n] marker out of text", () => {
		expect(
			extractDoneSteps(
				"Finished the route [DONE:1]. Moving on to tests [DONE:2].",
			),
		).toEqual([1, 2]);
	});

	it("dedupes repeated markers", () => {
		expect(extractDoneSteps("[DONE:3] then [DONE:3] again")).toEqual([3]);
	});

	it("sorts ascending", () => {
		expect(extractDoneSteps("[DONE:5] then [DONE:2] then [DONE:3]")).toEqual([
			2, 3, 5,
		]);
	});

	it("ignores markers that aren't integers or that are <= 0", () => {
		expect(extractDoneSteps("[DONE:0] or [DONE:-1] or [DONE:1.5]")).toEqual([]);
	});

	it("returns [] for text without markers", () => {
		expect(extractDoneSteps("Nothing done here yet.")).toEqual([]);
	});
});

describe("markCompletedSteps", () => {
	function items(): TodoItem[] {
		return [
			{ step: 1, text: "a", completed: false },
			{ step: 2, text: "b", completed: false },
			{ step: 3, text: "c", completed: false },
		];
	}

	it("marks matched steps complete and returns the newly-completed count", () => {
		const ts = items();
		expect(markCompletedSteps("Done: [DONE:1] [DONE:3]", ts)).toBe(2);
		expect(ts.map((i) => i.completed)).toEqual([true, false, true]);
	});

	it("returns 0 when the same marker is seen again (idempotent)", () => {
		const ts = items();
		markCompletedSteps("[DONE:2]", ts);
		expect(markCompletedSteps("[DONE:2]", ts)).toBe(0);
		expect(ts[1]?.completed).toBe(true);
	});

	it("ignores [DONE:n] for steps outside the plan", () => {
		const ts = items();
		expect(markCompletedSteps("[DONE:99] [DONE:2]", ts)).toBe(1);
		expect(ts.map((i) => i.completed)).toEqual([false, true, false]);
	});
});
