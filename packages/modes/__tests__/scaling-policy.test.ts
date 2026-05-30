import { admit, freeSlots, hasRoom } from "../plan/scaling-policy.js";

describe("freeSlots", () => {
	it("returns slots remaining under a finite cap", () => {
		expect(freeSlots(0, 3)).toBe(3);
		expect(freeSlots(2, 3)).toBe(1);
		expect(freeSlots(3, 3)).toBe(0);
	});

	it("never goes negative when over cap", () => {
		expect(freeSlots(5, 3)).toBe(0);
	});

	it("is infinite for an infinite cap", () => {
		expect(freeSlots(100, Number.POSITIVE_INFINITY)).toBe(
			Number.POSITIVE_INFINITY,
		);
	});

	it("treats NaN / -Infinity / non-positive caps as zero capacity, not uncapped", () => {
		expect(freeSlots(0, Number.NaN)).toBe(0);
		expect(freeSlots(0, Number.NEGATIVE_INFINITY)).toBe(0);
		expect(freeSlots(0, -3)).toBe(0);
		expect(freeSlots(0, 0)).toBe(0);
	});
});

describe("hasRoom", () => {
	it("matches the explore child cap check (childInFlight < maxChildren)", () => {
		// maxChildren = parallelism - 1
		expect(hasRoom(0, 2)).toBe(true);
		expect(hasRoom(1, 2)).toBe(true);
		expect(hasRoom(2, 2)).toBe(false);
	});

	it("is false when cap is 0 (no children allowed)", () => {
		expect(hasRoom(0, 0)).toBe(false);
	});

	it("is always true under an infinite cap", () => {
		expect(hasRoom(999, Number.POSITIVE_INFINITY)).toBe(true);
	});
});

describe("admit — fleet fan-out case", () => {
	it("spawns up to the cap and queues the rest", () => {
		// workers.size=0, maxParallel=3, 5 ready heads → spawn 3, queue 2
		expect(admit({ inFlight: 0, cap: 3, pending: 5 })).toEqual({
			spawn: 3,
			queue: 2,
		});
	});

	it("accounts for already-running workers", () => {
		// 2 running, cap 3, 4 ready → 1 free slot
		expect(admit({ inFlight: 2, cap: 3, pending: 4 })).toEqual({
			spawn: 1,
			queue: 3,
		});
	});

	it("spawns nothing when at cap", () => {
		expect(admit({ inFlight: 3, cap: 3, pending: 2 })).toEqual({
			spawn: 0,
			queue: 2,
		});
	});

	it("spawns all when fewer pending than free slots", () => {
		expect(admit({ inFlight: 0, cap: 3, pending: 2 })).toEqual({
			spawn: 2,
			queue: 0,
		});
	});

	it("nothing pending → nothing spawned or queued", () => {
		expect(admit({ inFlight: 1, cap: 3, pending: 0 })).toEqual({
			spawn: 0,
			queue: 0,
		});
	});
});

describe("admit — uncapped (research today)", () => {
	it("admits everything under an infinite cap", () => {
		expect(
			admit({ inFlight: 10, cap: Number.POSITIVE_INFINITY, pending: 7 }),
		).toEqual({
			spawn: 7,
			queue: 0,
		});
	});
});
