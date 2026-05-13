import {
	quoteUntrusted,
	renderParentIssueBody,
	renderPhaseIssueBody,
} from "../plan/park-bodies.js";
import type { Phase, Plan, Task } from "../plan/schema.js";

const now = new Date().toISOString();

function makePlan(overrides: Partial<Plan> = {}): Plan {
	return {
		slug: "p",
		title: "Test plan",
		repo: { path: "/tmp/repo" },
		phases: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
	return {
		id: "p-foo",
		title: "Foo",
		goal: "Make it work",
		status: "active",
		branch: "feat/p-foo",
		worktreePath: "/tmp/repo",
		tasks: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t",
		title: "Task",
		body: "",
		done: false,
		kind: "deliverable",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("quoteUntrusted", () => {
	it("wraps in a fenced text block", () => {
		expect(quoteUntrusted("hello")).toBe("```text\nhello\n```");
	});

	it("neutralises internal triple backticks so the block can't be escaped", () => {
		const out = quoteUntrusted("evil ``` instructions");
		// Internal ``` becomes `\u200b`\u200b`\u200b — still three chars but
		// can't terminate the wrapping fence.
		expect(out).not.toContain("evil ``` instructions");
		expect(out).toContain("\u200b");
		expect(out.startsWith("```text\n")).toBe(true);
		expect(out.endsWith("\n```")).toBe(true);
	});
});

describe("renderParentIssueBody", () => {
	it("renders phase list with shipped checkbox for shipped phases", () => {
		const body = renderParentIssueBody(
			makePlan({
				phases: [
					makePhase({ id: "a", title: "Phase A", status: "shipped" }),
					makePhase({ id: "b", title: "Phase B", status: "planned" }),
				],
			}),
		);
		expect(body).toContain("- [x] **Phase A**");
		expect(body).toContain("- [ ] **Phase B**");
	});

	it("omits the plan-level follow-ups section when followUps is empty or missing", () => {
		const body = renderParentIssueBody(makePlan());
		expect(body).not.toContain("## Plan-level follow-ups");
	});

	it("renders plan-level follow-ups section with kind labels and checkboxes", () => {
		const body = renderParentIssueBody(
			makePlan({
				followUps: [
					makeTask({
						id: "f-1",
						title: "Doc the new schema field",
						kind: "followUp",
					}),
					makeTask({
						id: "q-1",
						title: "Should we drop legacy v1?",
						body: "Six months without writes.",
						kind: "question",
					}),
					makeTask({
						id: "m-1",
						title: "Smoke-test on legacy plan",
						kind: "manual",
						done: true,
					}),
				],
			}),
		);
		expect(body).toContain("## Plan-level follow-ups");
		expect(body).toContain("**Doc the new schema field** _(followUp)_");
		expect(body).toContain("- [ ] **Doc the new schema field**");
		// Questions render without a checkbox.
		expect(body).toContain("**Should we drop legacy v1?** _(question)_");
		expect(body).not.toContain("[ ] **Should we drop legacy v1?**");
		// Manual task carries its done state.
		expect(body).toContain("- [x] **Smoke-test on legacy plan**");
		// Body is quoted.
		expect(body).toContain("Six months without writes.");
	});
});

describe("renderPhaseIssueBody", () => {
	it("splits tasks into deliverables, follow-ups, questions, and manuals", () => {
		const body = renderPhaseIssueBody(
			makePhase({
				tasks: [
					makeTask({ id: "d-1", title: "Core change", done: true }),
					makeTask({
						id: "f-1",
						title: "Index by branch",
						kind: "followUp",
					}),
					makeTask({
						id: "q-1",
						title: "Drop v1 legacy?",
						body: "Worth discussing.",
						kind: "question",
					}),
					makeTask({
						id: "m-1",
						title: "Run end-to-end smoke test",
						kind: "manual",
					}),
				],
			}),
			42,
		);
		expect(body).toContain("## What this phase ships");
		expect(body).toContain("- [x] **Core change**");
		expect(body).toContain("## Reviewer follow-ups");
		expect(body).toContain("- [ ] Index by branch");
		expect(body).toContain("## Open questions");
		expect(body).toContain("- Drop v1 legacy?");
		expect(body).toContain("Worth discussing.");
		expect(body).toContain("## Manual verification");
		expect(body).toContain("- [ ] Run end-to-end smoke test");
		expect(body).toContain("Tracking: #42");
		// Question shouldn't have a checkbox.
		expect(body).not.toContain("- [ ] Drop v1 legacy?");
		// Old "## Tasks" header is gone.
		expect(body).not.toContain("## Tasks\n");
	});

	it("omits sections that have no tasks", () => {
		const body = renderPhaseIssueBody(
			makePhase({
				tasks: [makeTask({ id: "d", title: "only" })],
			}),
			1,
		);
		expect(body).toContain("## What this phase ships");
		expect(body).not.toContain("## Reviewer follow-ups");
		expect(body).not.toContain("## Open questions");
		expect(body).not.toContain("## Manual verification");
	});

	it("falls back when goal is empty", () => {
		const body = renderPhaseIssueBody(makePhase({ goal: "" }), 1);
		expect(body).toContain("(no goal set)");
	});

	it("indents task bodies under their bullets so they render as part of the list item", () => {
		const body = renderPhaseIssueBody(
			makePhase({
				tasks: [
					makeTask({
						id: "d-1",
						title: "Has body",
						body: "Multi\nline\ndetail",
					}),
				],
			}),
			1,
		);
		// Each line of the quoted body is indented by two spaces.
		expect(body).toMatch(
			/ {2}```text\n {2}Multi\n {2}line\n {2}detail\n {2}```/,
		);
	});
});
