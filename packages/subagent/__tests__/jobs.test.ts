/**
 * Tests for the async delegate job path: submit → dispatch under the
 * shared semaphore → surface the capped result.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DelegateTarget } from "@vegardx/pi-extensions-shared/delegate-registry.js";
import { DelegateJobs, type SurfacedDelegateResult } from "../jobs.js";
import { Semaphore } from "../semaphore.js";

const ctx = { cwd: "/tmp" } as ExtensionContext;

async function settle(): Promise<void> {
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
}

function makeJobs() {
	const surfaced: SurfacedDelegateResult[] = [];
	const semaphore = new Semaphore();
	const jobs = new DelegateJobs({
		semaphore,
		surface: (r) => surfaced.push(r),
	});
	return { jobs, surfaced, semaphore };
}

function target(
	name: string,
	execute: DelegateTarget["execute"],
): DelegateTarget {
	return { name, description: `${name} target`, execute };
}

describe("DelegateJobs", () => {
	it("submit returns an id immediately; completion surfaces the result", async () => {
		const { jobs, surfaced } = makeJobs();
		let resolveExec: ((v: { text: string }) => void) | null = null;
		const { id } = jobs.submit({
			target: target(
				"researcher",
				() =>
					new Promise((res) => {
						resolveExec = res;
					}),
			),
			message: "q",
			limit: 10,
			capChars: 6000,
			ctx,
		});
		expect(id).toMatch(/^d\d+$/);
		expect(surfaced).toEqual([]);
		await settle();
		resolveExec!({ text: "the answer" });
		await settle();
		expect(surfaced).toEqual([
			{ jobId: id, to: "researcher", ok: true, text: "the answer" },
		]);
	});

	it("caps the surfaced text at the job's capChars", async () => {
		const { jobs, surfaced } = makeJobs();
		jobs.submit({
			target: target("researcher", async () => ({ text: "y".repeat(500) })),
			message: "q",
			limit: 10,
			capChars: 100,
			ctx,
		});
		await settle();
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]?.text.length).toBeLessThanOrEqual(100);
		expect(surfaced[0]?.text).toContain("truncated at 100 chars");
	});

	it("a failing target surfaces ok:false with the error text", async () => {
		const { jobs, surfaced, semaphore } = makeJobs();
		const { id } = jobs.submit({
			target: target("researcher", async () => {
				throw new Error("kaput");
			}),
			message: "q",
			limit: 10,
			capChars: 6000,
			ctx,
		});
		await settle();
		expect(surfaced).toEqual([
			{
				jobId: id,
				to: "researcher",
				ok: false,
				text: "[delegate researcher error] kaput",
			},
		]);
		expect(semaphore.activeCount).toBe(0);
	});

	it("caps the surfaced error text at the job's capChars", async () => {
		const { jobs, surfaced } = makeJobs();
		const { id } = jobs.submit({
			target: target("researcher", async () => {
				throw new Error("x".repeat(500));
			}),
			message: "q",
			limit: 10,
			capChars: 100,
			ctx,
		});
		await settle();
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]?.jobId).toBe(id);
		expect(surfaced[0]?.ok).toBe(false);
		expect(surfaced[0]?.text.length).toBeLessThanOrEqual(100);
		expect(surfaced[0]?.text).toContain("truncated at 100 chars");
	});

	it("passes message/params/timeout through to the target", async () => {
		const { jobs } = makeJobs();
		const seen: Record<string, unknown> = {};
		jobs.submit({
			target: target("researcher", async (args) => {
				Object.assign(seen, args);
				return { text: "ok" };
			}),
			message: "the question",
			params: { lens: "security" },
			timeoutMs: 5000,
			limit: 10,
			capChars: 6000,
			ctx,
		});
		await settle();
		expect(seen.message).toBe("the question");
		expect(seen.params).toEqual({ lens: "security" });
		expect(seen.timeoutMs).toBe(5000);
		expect(seen.ctx).toBe(ctx);
	});

	it("jobs queue behind the semaphore limit captured at submit", async () => {
		const { jobs, surfaced, semaphore } = makeJobs();
		const gates: Array<() => void> = [];
		const slow = target(
			"researcher",
			() =>
				new Promise((res) => {
					gates.push(() => res({ text: "done" }));
				}),
		);
		jobs.submit({ target: slow, message: "a", limit: 1, capChars: 99, ctx });
		jobs.submit({ target: slow, message: "b", limit: 1, capChars: 99, ctx });
		await settle();
		expect(gates).toHaveLength(1);
		expect(semaphore.queuedCount).toBe(1);
		gates[0]?.();
		await settle();
		expect(gates).toHaveLength(2);
		gates[1]?.();
		await settle();
		expect(surfaced).toHaveLength(2);
		await jobs.dispose();
	});

	it("dispose aborts in-flight jobs and they surface as failures", async () => {
		const { jobs, surfaced } = makeJobs();
		jobs.submit({
			target: target(
				"researcher",
				({ signal }) =>
					new Promise((_res, rej) => {
						signal?.addEventListener("abort", () => rej(new Error("aborted")));
					}),
			),
			message: "q",
			limit: 10,
			capChars: 6000,
			ctx,
		});
		await settle();
		await jobs.dispose();
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]?.ok).toBe(false);
	});
});
