/**
 * Tests for FleetManager and its helpers.
 *
 * Strategy: stub the worker factory so no real subagent is spawned.
 * We feed plan snapshots through `loadPlan` via a temp plans root.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chainIdFor,
	FleetManager,
	fleetWouldBeTrivial,
	unclaimedChainHeads,
} from "../plan/fleet-manager.js";
import type { Plan } from "../plan/schema.js";
import { _setPlansRootForTests } from "../plan/storage.js";
import type {
	WorkerMailbox,
	WorkerMailboxDeps,
	WorkerOptions,
} from "../plan/worker-mailbox.js";
import type { WorkerNotification } from "../plan/worker-protocol.js";

const CTX = { cwd: "/repo", hasUI: false } as never;

function chainPlan(
	phases: Array<{ id: string; status: string; deps?: string[] }>,
): Plan {
	return {
		slug: "fleet-test",
		title: "t",
		summary: "",
		phases: phases.map((p, i) => ({
			id: p.id,
			title: p.id,
			goal: "",
			status: p.status as never,
			tasks: [],
			updatedAt: new Date(2026, 0, 1, 0, i).toISOString(),
			...(p.deps !== undefined ? { dependsOn: p.deps } : {}),
		})) as never,
		updatedAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		repo: { path: "/repo" },
		schemaVersion: 2,
	} as Plan;
}

function writePlan(root: string, slug: string, plan: Plan): void {
	const dir = join(root, slug);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2));
}

interface FakeMailbox extends WorkerMailbox {
	emit(notification: WorkerNotification): void;
	finish(): void;
}

function makeFakeMailbox(opts: WorkerOptions): FakeMailbox {
	const listeners = new Set<(e: WorkerNotification) => void>();
	const endHandlers = new Set<() => void>();
	const state = {
		chainId: opts.chainId,
		status: "running" as const,
		chainHeadId: opts.chainHeadId,
		lastEvent: null,
		lastToolSummary: null,
		error: null,
	};
	const fake: FakeMailbox = {
		// biome-ignore lint/suspicious/noExplicitAny: test stub of class instance
		...({} as any),
		getState: () => ({ ...state }),
		onEvent(listener: (e: WorkerNotification) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onEnd(handler: () => void): () => void {
			endHandlers.add(handler);
			return () => endHandlers.delete(handler);
		},
		start: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn().mockResolvedValue(undefined),
		emit(n: WorkerNotification) {
			for (const l of listeners) l(n);
		},
		finish() {
			for (const h of endHandlers) h();
		},
	} as unknown as FakeMailbox;
	return fake;
}

let plansRoot: string;

beforeEach(() => {
	plansRoot = mkdtempSync(join(tmpdir(), "fleet-test-"));
	_setPlansRootForTests(plansRoot);
});

afterEach(() => {
	rmSync(plansRoot, { recursive: true, force: true });
});

describe("chainIdFor", () => {
	it("returns the phase id for a root phase (no parent)", () => {
		const plan = chainPlan([{ id: "root", status: "planned" }]);
		expect(chainIdFor(plan, plan.phases[0]!)).toBe("root");
	});

	it("walks up dependsOn to the root for a deep chain", () => {
		const plan = chainPlan([
			{ id: "a", status: "shipped" },
			{ id: "b", status: "shipped", deps: ["a"] },
			{ id: "c", status: "planned", deps: ["b"] },
		]);
		expect(chainIdFor(plan, plan.phases[2]!)).toBe("a");
	});

	it("treats sibling chains under the same parent as one chain", () => {
		const plan = chainPlan([
			{ id: "root", status: "shipped" },
			{ id: "x", status: "planned", deps: ["root"] },
			{ id: "y", status: "planned", deps: ["root"] },
		]);
		expect(chainIdFor(plan, plan.phases[1]!)).toBe("root");
		expect(chainIdFor(plan, plan.phases[2]!)).toBe("root");
	});

	it("is bounded against hand-edited cycles", () => {
		const plan = chainPlan([
			{ id: "a", status: "planned", deps: ["b"] },
			{ id: "b", status: "planned", deps: ["a"] },
		]);
		expect(() => chainIdFor(plan, plan.phases[0]!)).not.toThrow();
	});
});

describe("unclaimedChainHeads", () => {
	it("returns one entry per ready chain", () => {
		const plan = chainPlan([
			{ id: "a", status: "planned", deps: [] },
			{ id: "b", status: "planned", deps: [] },
		]);
		const heads = unclaimedChainHeads(plan, "self");
		expect(heads.map((h) => h.phaseId).sort()).toEqual(["a", "b"]);
	});

	it("dedups siblings that share a chain root", () => {
		const plan = chainPlan([
			{ id: "root", status: "shipped" },
			{ id: "x", status: "planned", deps: ["root"] },
			{ id: "y", status: "planned", deps: ["root"] },
		]);
		const heads = unclaimedChainHeads(plan, "self");
		expect(heads).toHaveLength(1);
	});

	it("filters out occupied phases (claim by another session)", () => {
		const plan = chainPlan([
			{ id: "a", status: "planned", deps: [] },
			{ id: "b", status: "planned", deps: [] },
		]);
		plan.phases[0]!.driverSessionId = "other-session";
		plan.phases[0]!.driverSessionFile = "/tmp/never-exists.jsonl";
		plan.phases[0]!.driverClaimedAt = new Date().toISOString();
		const heads = unclaimedChainHeads(plan, "self");
		// "a" filtered (occupied by other) — stale check uses session-file
		// existence; the file doesn't exist, so it's stale, not occupied.
		// To force "occupied", point at a real file.
		const realFile = join(plansRoot, "live.jsonl");
		writeFileSync(realFile, "");
		plan.phases[0]!.driverSessionFile = realFile;
		plan.phases[0]!.driverClaimedAt = new Date().toISOString();
		const heads2 = unclaimedChainHeads(plan, "self");
		expect(heads2.find((h) => h.phaseId === "a")).toBeUndefined();
		expect(heads.map((h) => h.phaseId)).toContain("b");
	});
});

describe("fleetWouldBeTrivial", () => {
	it("is true when only one chain is ready", () => {
		const plan = chainPlan([{ id: "a", status: "planned" }]);
		expect(fleetWouldBeTrivial(plan, "self")).toBe(true);
	});

	it("is false when two or more independent chains are ready", () => {
		const plan = chainPlan([
			{ id: "a", status: "planned", deps: [] },
			{ id: "b", status: "planned", deps: [] },
		]);
		expect(fleetWouldBeTrivial(plan, "self")).toBe(false);
	});

	it("is true when no chains are ready", () => {
		const plan = chainPlan([{ id: "a", status: "in-review" }]);
		expect(fleetWouldBeTrivial(plan, "self")).toBe(true);
	});
});

describe("FleetManager", () => {
	function deps(): WorkerMailboxDeps {
		return {
			spawnAgent: vi.fn(),
			readPlan: vi.fn().mockReturnValue(null),
		};
	}

	it("spawns one worker per independent chain up to maxParallel", async () => {
		const plan = chainPlan([
			{ id: "a", status: "planned", deps: [] },
			{ id: "b", status: "planned", deps: [] },
			{ id: "c", status: "planned", deps: [] },
		]);
		writePlan(plansRoot, "fleet-test", plan);
		const created: FakeMailbox[] = [];
		const fleet = new FleetManager(CTX, {
			planSlug: "fleet-test",
			selfSessionId: "self",
			maxParallel: 2,
			workerDeps: deps(),
			workerFactory: (_ctx, opts) => {
				const mb = makeFakeMailbox(opts);
				created.push(mb);
				return mb;
			},
		});
		const startPromise = fleet.start();
		// Allow refresh + spawnWorker microtasks to settle.
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		expect(created).toHaveLength(2);
		const snap = fleet.getSnapshot();
		expect(snap.workers).toHaveLength(2);
		expect(snap.queued).toHaveLength(1);
		// Tear down to release start()'s promise.
		await fleet.dispose();
		await startPromise;
	});

	it("fans out into newly-unblocked chains when a worker ships", async () => {
		const planV1 = chainPlan([
			{ id: "a", status: "planned", deps: [] },
			{ id: "b", status: "planned", deps: [] },
		]);
		writePlan(plansRoot, "fleet-test", planV1);
		const created: FakeMailbox[] = [];
		const fleet = new FleetManager(CTX, {
			planSlug: "fleet-test",
			selfSessionId: "self",
			maxParallel: 1,
			workerDeps: deps(),
			workerFactory: (_ctx, opts) => {
				const mb = makeFakeMailbox(opts);
				created.push(mb);
				return mb;
			},
		});
		const startPromise = fleet.start();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		expect(created).toHaveLength(1);
		// Simulate worker A finishing.
		const planV2 = chainPlan([
			{ id: "a", status: "shipped", deps: [] },
			{ id: "b", status: "planned", deps: [] },
		]);
		writePlan(plansRoot, "fleet-test", planV2);
		created[0]!.finish();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		// New worker spawned for b.
		expect(created).toHaveLength(2);
		expect(created[1]!.getState().chainId).toBe("b");
		await fleet.dispose();
		await startPromise;
	});

	it("completes when all workers end and no ready chains remain", async () => {
		const planV1 = chainPlan([{ id: "a", status: "planned" }]);
		writePlan(plansRoot, "fleet-test", planV1);
		const created: FakeMailbox[] = [];
		const fleet = new FleetManager(CTX, {
			planSlug: "fleet-test",
			selfSessionId: "self",
			workerDeps: deps(),
			workerFactory: (_ctx, opts) => {
				const mb = makeFakeMailbox(opts);
				created.push(mb);
				return mb;
			},
		});
		const startPromise = fleet.start();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		// Ship a, then end.
		const planV2 = chainPlan([{ id: "a", status: "shipped" }]);
		writePlan(plansRoot, "fleet-test", planV2);
		created[0]!.finish();
		await startPromise;
		expect(fleet.getSnapshot().complete).toBe(true);
	});

	it("returns immediately if no chains are ready", async () => {
		const plan = chainPlan([{ id: "a", status: "shipped" }]);
		writePlan(plansRoot, "fleet-test", plan);
		const fleet = new FleetManager(CTX, {
			planSlug: "fleet-test",
			selfSessionId: "self",
			workerDeps: deps(),
			workerFactory: (_ctx, opts) => makeFakeMailbox(opts),
		});
		await fleet.start();
		expect(fleet.getSnapshot().complete).toBe(true);
	});
});
