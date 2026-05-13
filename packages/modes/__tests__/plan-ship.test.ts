import { vi } from "vitest";
import type { ShellResult } from "../git.js";
import type { Phase, Plan } from "../plan/schema.js";
import { parsePrCreateOutput, renderPrBody, shipPhase } from "../plan/ship.js";

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

function ok(stdout = ""): ShellResult {
	return { ok: true, exitCode: 0, stdout, stderr: "" };
}

function fail(stderr = "boom"): ShellResult {
	return { ok: false, exitCode: 1, stdout: "", stderr };
}

describe("parsePrCreateOutput", () => {
	it("extracts pull number and url", () => {
		const out = "https://github.com/owner/repo/pull/42\n";
		expect(parsePrCreateOutput(out)).toEqual({
			number: 42,
			url: "https://github.com/owner/repo/pull/42",
		});
	});

	it("ignores leading log lines", () => {
		const out =
			"Creating pull request for feat/p-foo into main in owner/repo\n\n" +
			"https://github.com/owner/repo/pull/7";
		expect(parsePrCreateOutput(out)?.number).toBe(7);
	});

	it("returns null when no /pull/<n> match", () => {
		expect(parsePrCreateOutput("nothing useful here")).toBeNull();
	});
});

describe("renderPrBody", () => {
	it("renders goal, tasks, and issue refs", () => {
		const body = renderPrBody(
			makePlan({ parentIssueNumber: 100 }),
			makePhase({
				issueNumber: 101,
				tasks: [
					{
						id: "t-a",
						title: "Task A",
						body: "",
						done: true,
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "t-b",
						title: "Task B",
						body: "",
						done: false,
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
		);
		expect(body).toContain("## Goal");
		expect(body).toContain("Make it work");
		expect(body).toContain("- [x] Task A");
		expect(body).toContain("- [ ] Task B");
		expect(body).toContain("Closes #101");
		expect(body).toContain("Part of #100");
	});

	it("falls back when goal is empty", () => {
		const body = renderPrBody(makePlan(), makePhase({ goal: "" }));
		expect(body).toContain("_(no goal set)_");
	});

	it("renames Tasks section to 'What this phase ships' (deliverables only)", () => {
		const body = renderPrBody(
			makePlan(),
			makePhase({
				tasks: [
					{
						id: "t-1",
						title: "Ship me",
						body: "",
						done: true,
						kind: "deliverable",
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
		);
		expect(body).toContain("## What this phase ships");
		expect(body).toContain("- [x] Ship me");
		expect(body).not.toContain("## Tasks");
	});

	it("separates followUps, questions, manual into reviewer-facing sections", () => {
		const body = renderPrBody(
			makePlan(),
			makePhase({
				tasks: [
					{
						id: "d",
						title: "core change",
						body: "",
						done: true,
						kind: "deliverable",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "q",
						title: "Should we drop legacy v1?",
						body: "v1 plans haven't been written in 6 months.",
						done: false,
						kind: "question",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "f",
						title: "Index in-flight plans by branch",
						body: "",
						done: false,
						kind: "followUp",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "m",
						title: "Smoke-test on a v1 plan locally",
						body: "",
						done: false,
						kind: "manual",
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
		);
		expect(body).toContain("## What this phase ships");
		expect(body).toContain("- [x] core change");
		expect(body).toContain("## Reviewer follow-ups");
		expect(body).toContain("- [ ] Index in-flight plans by branch");
		expect(body).toContain("## Open questions");
		expect(body).toContain("- Should we drop legacy v1?");
		expect(body).toContain("v1 plans haven't been written in 6 months.");
		expect(body).toContain("## Manual verification");
		expect(body).toContain("- [ ] Smoke-test on a v1 plan locally");
		// Question shouldn't have a checkbox — it's not a checklist item.
		expect(body).not.toContain("- [ ] Should we drop legacy v1?");
	});

	it("omits non-deliverable sections when there are no such tasks", () => {
		const body = renderPrBody(
			makePlan(),
			makePhase({
				tasks: [
					{
						id: "d",
						title: "only deliverable",
						body: "",
						done: true,
						kind: "deliverable",
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
		);
		expect(body).not.toContain("## Reviewer follow-ups");
		expect(body).not.toContain("## Open questions");
		expect(body).not.toContain("## Manual verification");
	});
});

describe("shipPhase", () => {
	it("refuses on dirty tree without autoCommit", async () => {
		const r = await shipPhase(makePlan(), makePhase(), {
			isClean: () => false,
			run: () => ok(),
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("uncommitted changes");
	});

	it("commits, pushes, and opens PR on happy path with autoCommit", async () => {
		const calls: Array<{ cmd: string; args: readonly string[] }> = [];
		const run = vi.fn((cmd: string, args: readonly string[]): ShellResult => {
			calls.push({ cmd, args });
			if (cmd === "gh") {
				return ok("https://github.com/o/r/pull/55\n");
			}
			return ok();
		});
		const r = await shipPhase(makePlan(), makePhase(), {
			autoCommit: true,
			isClean: () => false,
			run,
		});
		expect(r).toEqual({
			ok: true,
			prNumber: 55,
			prUrl: "https://github.com/o/r/pull/55",
		});
		const sequence = calls.map(
			(c) => `${c.cmd} ${c.args.slice(0, 2).join(" ")}`,
		);
		expect(sequence).toEqual([
			"git add -A",
			"git commit -m",
			"git push -u",
			"gh pr create",
		]);
	});

	it("skips the commit step when tree is clean", async () => {
		const seen: string[] = [];
		const run = vi.fn((cmd: string, args: readonly string[]): ShellResult => {
			seen.push(`${cmd} ${args[0]}`);
			if (cmd === "gh") return ok("https://github.com/o/r/pull/1\n");
			return ok();
		});
		await shipPhase(makePlan(), makePhase(), {
			isClean: () => true,
			run,
		});
		expect(seen).not.toContain("git add");
		expect(seen).not.toContain("git commit");
		expect(seen).toContain("git push");
		expect(seen).toContain("gh pr");
	});

	it("propagates push failures", async () => {
		const run = vi.fn((cmd: string, args: readonly string[]): ShellResult => {
			if (cmd === "git" && args[0] === "push") return fail("rejected");
			return ok();
		});
		const r = await shipPhase(makePlan(), makePhase(), {
			isClean: () => true,
			run,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("git push failed");
		expect(r.error).toContain("rejected");
	});

	it("propagates gh pr create failures", async () => {
		const run = vi.fn((cmd: string, args: readonly string[]): ShellResult => {
			if (cmd === "gh" && args[0] === "pr") return fail("auth required");
			return ok();
		});
		const r = await shipPhase(makePlan(), makePhase(), {
			isClean: () => true,
			run,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("gh pr create failed");
	});

	it("reports unexpected stdout from gh", async () => {
		const run = vi.fn((cmd: string): ShellResult => {
			if (cmd === "gh") return ok("nothing useful");
			return ok();
		});
		const r = await shipPhase(makePlan(), makePhase(), {
			isClean: () => true,
			run,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("unexpected output");
	});

	it("uses phase.worktreePath as cwd for git commands", async () => {
		const phase = makePhase({ worktreePath: "/some/where" });
		const seenCwd = new Set<string>();
		const run = vi.fn(
			(
				cmd: string,
				_args: readonly string[],
				opts?: { cwd?: string },
			): ShellResult => {
				if (opts?.cwd) seenCwd.add(opts.cwd);
				if (cmd === "gh") return ok("https://github.com/o/r/pull/1\n");
				return ok();
			},
		);
		await shipPhase(makePlan(), phase, { isClean: () => true, run });
		expect(seenCwd).toEqual(new Set(["/some/where"]));
	});

	it("passes --draft through when set", async () => {
		const seenArgs: string[][] = [];
		const run = vi.fn((cmd: string, args: readonly string[]): ShellResult => {
			seenArgs.push([...args]);
			if (cmd === "gh") return ok("https://github.com/o/r/pull/1\n");
			return ok();
		});
		await shipPhase(makePlan(), makePhase(), {
			isClean: () => true,
			draft: true,
			run,
		});
		const ghCall = seenArgs.find((a) => a[0] === "pr");
		expect(ghCall).toContain("--draft");
	});
});
