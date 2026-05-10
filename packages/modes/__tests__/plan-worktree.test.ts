import type { Phase, Plan } from "../plan/schema.js";
import { worktreePath } from "../plan/worktree.js";

const now = new Date().toISOString();

function makePlan(repoPath: string): Plan {
	return {
		slug: "feat-work",
		title: "feat work",
		repo: { path: repoPath },
		phases: [],
		createdAt: now,
		updatedAt: now,
	};
}

const phase: Phase = {
	id: "p-add-validation",
	title: "Add validation",
	goal: "g",
	status: "active",
	branch: "feat/p-add-validation",
	tasks: [],
	createdAt: now,
	updatedAt: now,
};

describe("worktreePath", () => {
	it("scopes path by repo name, plan slug, phase id", () => {
		const plan = makePlan("/Users/me/src/example/repo-a");
		const path = worktreePath(plan, phase);
		expect(path).toBe(
			"/Users/me/src/example/worktrees/repo-a/feat-work/p-add-validation",
		);
	});

	it("strips trailing slash from repo path", () => {
		const plan = makePlan("/foo/bar/repo-a/");
		const path = worktreePath(plan, phase);
		// node:path/resolve strips trailing slash; result is the same as without
		expect(path).toBe("/foo/bar/worktrees/repo-a/feat-work/p-add-validation");
	});

	it("two repos with same parent and same plan slug get distinct paths", () => {
		const plan1 = worktreePath(makePlan("/parent/repo-a"), phase);
		const plan2 = worktreePath(makePlan("/parent/repo-b"), phase);
		expect(plan1).not.toBe(plan2);
		expect(plan1).toContain("repo-a");
		expect(plan2).toContain("repo-b");
	});
});
