/**
 * Tests for the FIFO, abort-aware counting semaphore gating delegate
 * executions.
 */

import { Semaphore, SemaphoreAbortedError } from "../semaphore.js";

async function settle(): Promise<void> {
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
}

describe("Semaphore", () => {
	it("admits up to limit, queues the rest, FIFO on release", async () => {
		const sem = new Semaphore();
		const r1 = await sem.acquire({ limit: 2 });
		const r2 = await sem.acquire({ limit: 2 });
		expect(sem.activeCount).toBe(2);

		const order: string[] = [];
		const p3 = sem.acquire({ limit: 2 }).then((r) => {
			order.push("third");
			return r;
		});
		const p4 = sem.acquire({ limit: 2 }).then((r) => {
			order.push("fourth");
			return r;
		});
		await settle();
		expect(order).toEqual([]);
		expect(sem.queuedCount).toBe(2);

		r1();
		const r3 = await p3;
		expect(order).toEqual(["third"]);

		r2();
		await p4;
		expect(order).toEqual(["third", "fourth"]);
		r3();
	});

	it("abort while queued rejects with SemaphoreAbortedError and frees the queue slot", async () => {
		const sem = new Semaphore();
		const release = await sem.acquire({ limit: 1 });
		const ac = new AbortController();
		const queued = sem.acquire({ limit: 1, signal: ac.signal });
		await settle();
		expect(sem.queuedCount).toBe(1);
		ac.abort();
		await expect(queued).rejects.toBeInstanceOf(SemaphoreAbortedError);
		expect(sem.queuedCount).toBe(0);
		// The held slot is unaffected; release still works.
		release();
		expect(sem.activeCount).toBe(0);
	});

	it("pre-aborted signal rejects without taking a slot", async () => {
		const sem = new Semaphore();
		const ac = new AbortController();
		ac.abort();
		await expect(
			sem.acquire({ limit: 5, signal: ac.signal }),
		).rejects.toBeInstanceOf(SemaphoreAbortedError);
		expect(sem.activeCount).toBe(0);
	});

	it("release is idempotent", async () => {
		const sem = new Semaphore();
		const release = await sem.acquire({ limit: 1 });
		release();
		release();
		expect(sem.activeCount).toBe(0);
	});

	it("non-finite or sub-1 limits mean uncapped", async () => {
		const sem = new Semaphore();
		const releases = await Promise.all([
			sem.acquire({ limit: 0 }),
			sem.acquire({ limit: Number.NaN }),
			sem.acquire({ limit: Number.POSITIVE_INFINITY }),
		]);
		expect(sem.activeCount).toBe(3);
		for (const r of releases) r();
	});

	it("an aborted waiter does not steal the wake from the next waiter", async () => {
		const sem = new Semaphore();
		const release = await sem.acquire({ limit: 1 });
		const ac = new AbortController();
		const doomed = sem.acquire({ limit: 1, signal: ac.signal });
		let survivorGot = false;
		const survivor = sem.acquire({ limit: 1 }).then((r) => {
			survivorGot = true;
			return r;
		});
		await settle();
		ac.abort();
		await expect(doomed).rejects.toBeInstanceOf(SemaphoreAbortedError);
		release();
		const r = await survivor;
		expect(survivorGot).toBe(true);
		r();
	});
});
