/**
 * Tests for AsyncJobMailbox<TJob, TNote> — the generic FIFO/parallel
 * queue extracted from ExploreMailbox in #159a.
 */

import {
	AsyncJobMailbox,
	type BaseJob,
	type BaseNotification,
	type Dispatcher,
	type MailboxState,
} from "../async-job-mailbox.js";

interface TestJob extends BaseJob {
	question: string;
}

interface TestNote extends BaseNotification {
	severity?: "info" | "warning";
}

function makeMailbox(opts: {
	dispatch: Dispatcher<TestJob, TestNote>;
	maxConcurrent?: number;
	defaultWaitTimeoutMs?: number;
	onDispose?: () => void | Promise<void>;
}): AsyncJobMailbox<TestJob, TestNote> {
	return new AsyncJobMailbox<TestJob, TestNote>({
		kind: "test",
		dispatch: opts.dispatch,
		maxConcurrent: opts.maxConcurrent,
		defaultWaitTimeoutMs: opts.defaultWaitTimeoutMs,
		onDispose: opts.onDispose,
	});
}

function enqueueTestJob(
	mb: AsyncJobMailbox<TestJob, TestNote>,
	question: string,
): { id: string } {
	return mb.enqueue((id, enqueuedAt) => ({
		id,
		status: "queued",
		enqueuedAt,
		question,
	}));
}

describe("AsyncJobMailbox", () => {
	describe("enqueue + check", () => {
		it("returns a generated id immediately and the job lands in queued state", () => {
			const dispatch = vi.fn().mockReturnValue(new Promise(() => {}));
			const mb = makeMailbox({ dispatch });
			const { id } = enqueueTestJob(mb, "what files exist?");
			expect(id).toMatch(/^t\d+$/);
			const state = mb.check({ drain: false });
			expect(state.tasks).toHaveLength(1);
			// Dispatcher hasn't called setRunning, so the queued status sticks
			// even though the dispatcher promise is in-flight.
			expect(state.tasks[0]?.status).toBe("queued");
		});

		it("derives the id prefix from the mailbox kind", () => {
			const mb = new AsyncJobMailbox<TestJob, TestNote>({
				kind: "research",
				dispatch: vi.fn().mockReturnValue(new Promise(() => {})),
			});
			const { id } = mb.enqueue((jid, enqueuedAt) => ({
				id: jid,
				status: "queued",
				enqueuedAt,
				question: "x",
			}));
			expect(id.startsWith("r")).toBe(true);
		});

		it("drains terminal jobs but keeps running ones across check() calls", async () => {
			let resolveOne: (value: { text: string }) => void = () => {};
			let firstSeen = false;
			const dispatch: Dispatcher<TestJob, TestNote> = async (handle) => {
				handle.setRunning();
				if (!firstSeen) {
					firstSeen = true;
					return { text: `done: ${handle.job.question}` };
				}
				return new Promise<{ text: string }>((res) => {
					resolveOne = res;
				});
			};
			const mb = makeMailbox({ dispatch, maxConcurrent: 2 });
			enqueueTestJob(mb, "first");
			enqueueTestJob(mb, "second");
			// Let the synchronous part of dispatch fire and the first
			// dispatcher resolve.
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			const drained = mb.check();
			// Both tasks come back in the snapshot — `first` terminal,
			// `second` still running.
			expect(drained.tasks).toHaveLength(2);
			const second = mb.check({ drain: false });
			// The terminal `first` is gone; only `second` remains.
			expect(second.tasks).toHaveLength(1);
			expect(second.tasks[0]?.status).toBe("running");

			// Resolve the second so the test can dispose cleanly.
			resolveOne({ text: "done: second" });
			await mb.dispose();
		});

		it("returns single-task snapshot without draining when an id is passed", async () => {
			const dispatch: Dispatcher<TestJob, TestNote> = async (handle) => {
				handle.setRunning();
				return { text: "done" };
			};
			const mb = makeMailbox({ dispatch });
			const { id } = enqueueTestJob(mb, "q");
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			const peeked = mb.check({ id });
			expect(peeked.tasks).toHaveLength(1);
			expect(peeked.tasks[0]?.status).toBe("done");
			// Peek did not drain.
			const all = mb.check({ drain: false });
			expect(all.tasks).toHaveLength(1);
		});
	});

	describe("FIFO ordering with maxConcurrent: 1", () => {
		it("dispatches queued jobs strictly one at a time", async () => {
			const order: string[] = [];
			const gates = new Map<string, () => void>();
			const dispatch: Dispatcher<TestJob, TestNote> = async (handle) => {
				handle.setRunning();
				order.push(`start:${handle.job.id}`);
				return new Promise<{ text: string }>((res) => {
					gates.set(handle.job.id, () => {
						order.push(`end:${handle.job.id}`);
						res({ text: "ok" });
					});
				});
			};
			const mb = makeMailbox({ dispatch, maxConcurrent: 1 });
			const { id: a } = enqueueTestJob(mb, "a");
			const { id: b } = enqueueTestJob(mb, "b");
			const { id: c } = enqueueTestJob(mb, "c");

			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			// Only one in-flight.
			expect(order).toEqual([`start:${a}`]);

			gates.get(a)?.();
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			expect(order).toEqual([`start:${a}`, `end:${a}`, `start:${b}`]);

			gates.get(b)?.();
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			// b ends, c starts — but c's gate didn't exist before now.
			gates.get(c)?.();
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			expect(order[order.length - 1]).toBe(`end:${c}`);
			await mb.dispose();
		});
	});

	describe("parallel dispatch with maxConcurrent: Infinity", () => {
		it("starts every queued job immediately", async () => {
			const started: string[] = [];
			const gates = new Map<string, () => void>();
			const dispatch: Dispatcher<TestJob, TestNote> = async (handle) => {
				handle.setRunning();
				started.push(handle.job.id);
				return new Promise<{ text: string }>((res) => {
					gates.set(handle.job.id, () => res({ text: "ok" }));
				});
			};
			const mb = makeMailbox({
				dispatch,
				maxConcurrent: Number.POSITIVE_INFINITY,
			});
			const a = enqueueTestJob(mb, "a").id;
			const b = enqueueTestJob(mb, "b").id;
			const c = enqueueTestJob(mb, "c").id;
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			expect(started.sort()).toEqual([a, b, c].sort());

			gates.get(a)?.();
			gates.get(b)?.();
			gates.get(c)?.();
			await mb.dispose();
		});
	});

	describe("wait", () => {
		it("resolves with the terminal snapshot when the job completes", async () => {
			let resolveDispatch: (v: { text: string }) => void = () => {};
			const dispatch: Dispatcher<TestJob, TestNote> = async (handle) => {
				handle.setRunning();
				return new Promise<{ text: string }>((res) => {
					resolveDispatch = res;
				});
			};
			const mb = makeMailbox({ dispatch });
			const { id } = enqueueTestJob(mb, "q");
			const waitP = mb.wait(id, 5_000);
			await new Promise((r) => setImmediate(r));
			resolveDispatch({ text: "answer" });
			const result = await waitP;
			expect(result.status).toBe("done");
			expect(result.text).toBe("answer");
		});

		it("returns synthetic terminal record on timeout without mutating the job", async () => {
			const dispatch: Dispatcher<TestJob, TestNote> = () =>
				new Promise(() => {});
			const mb = makeMailbox({ dispatch });
			const { id } = enqueueTestJob(mb, "q");
			const out = await mb.wait(id, 10);
			expect(out.status).toBe("timeout");
			expect(out.error).toContain("timed out");
			// Underlying job is still queued/running on the mailbox.
			const peek = mb.check({ id });
			expect(peek.tasks[0]?.status).not.toBe("timeout");
			await mb.dispose();
		});

		it("returns an error record for unknown ids", async () => {
			const mb = makeMailbox({ dispatch: vi.fn() });
			const out = await mb.wait("nope", 100);
			expect(out.status).toBe("error");
			expect(out.error).toContain("unknown");
		});

		it("settles promptly when the passed signal aborts, leaving the job running", async () => {
			const dispatch: Dispatcher<TestJob, TestNote> = () =>
				new Promise(() => {});
			const mb = makeMailbox({ dispatch });
			const { id } = enqueueTestJob(mb, "q");
			const ctrl = new AbortController();
			const waitP = mb.wait(id, 60_000, ctrl.signal);
			ctrl.abort();
			const out = await waitP;
			expect(out.status).toBe("error");
			expect(out.error).toContain("aborted");
			// The underlying dispatcher keeps running — abort only frees the waiter.
			expect(mb.check({ id }).tasks[0]?.status).not.toBe("error");
			await mb.dispose();
		});

		it("returns an aborted record when the signal is already aborted", async () => {
			const dispatch: Dispatcher<TestJob, TestNote> = () =>
				new Promise(() => {});
			const mb = makeMailbox({ dispatch });
			const { id } = enqueueTestJob(mb, "q");
			const out = await mb.wait(id, 60_000, AbortSignal.abort());
			expect(out.status).toBe("error");
			expect(out.error).toContain("aborted");
			await mb.dispose();
		});

		it("resolves every concurrent waiter on the same job", async () => {
			let resolveDispatch: (v: { text: string }) => void = () => {};
			const dispatch: Dispatcher<TestJob, TestNote> = async (handle) => {
				handle.setRunning();
				return new Promise<{ text: string }>((res) => {
					resolveDispatch = res;
				});
			};
			const mb = makeMailbox({ dispatch });
			const { id } = enqueueTestJob(mb, "q");
			const waits = [
				mb.wait(id, 5_000),
				mb.wait(id, 5_000),
				mb.wait(id, 5_000),
			];
			await new Promise((r) => setImmediate(r));
			resolveDispatch({ text: "answer" });
			const results = await Promise.all(waits);
			for (const r of results) {
				expect(r.status).toBe("done");
				expect(r.text).toBe("answer");
			}
		});

		it("resolves immediately when the job is already terminal", async () => {
			const dispatch: Dispatcher<TestJob, TestNote> = async (handle) => {
				handle.setRunning();
				return { text: "done already" };
			};
			const mb = makeMailbox({ dispatch });
			const { id } = enqueueTestJob(mb, "q");
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			const out = await mb.wait(id, 5_000);
			expect(out.status).toBe("done");
			expect(out.text).toBe("done already");
		});
	});

	describe("notify", () => {
		it("surfaces dispatcher notifications via check()", async () => {
			let resolveDispatch: (v: { text: string }) => void = () => {};
			const dispatch: Dispatcher<TestJob, TestNote> = async (handle) => {
				handle.setRunning();
				handle.notify({ text: "halfway", severity: "info" });
				return new Promise<{ text: string }>((res) => {
					resolveDispatch = res;
				});
			};
			const mb = makeMailbox({ dispatch });
			const { id } = enqueueTestJob(mb, "q");
			await new Promise((r) => setImmediate(r));
			const drain = mb.check();
			expect(drain.notifications).toHaveLength(1);
			expect(drain.notifications[0]?.text).toBe("halfway");
			expect(drain.notifications[0]?.severity).toBe("info");
			expect(drain.notifications[0]?.jobId).toBe(id);
			// drained — second check is empty.
			expect(mb.check().notifications).toHaveLength(0);
			resolveDispatch({ text: "done" });
			await mb.dispose();
		});
	});

	describe("onChange", () => {
		it("fires on every state mutation and stops after unsubscribe", async () => {
			const events: MailboxState<TestJob, TestNote>[] = [];
			const dispatch: Dispatcher<TestJob, TestNote> = async (handle) => {
				handle.setRunning();
				return { text: "ok" };
			};
			const mb = makeMailbox({ dispatch });
			const off = mb.onChange((s) => events.push(s));
			enqueueTestJob(mb, "q");
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			expect(events.length).toBeGreaterThan(1);
			const before = events.length;
			off();
			mb.check();
			expect(events.length).toBe(before);
		});
	});

	describe("dispose", () => {
		it("aborts in-flight dispatchers and rejects further enqueues", async () => {
			let aborted = false;
			const dispatch: Dispatcher<TestJob, TestNote> = (handle) => {
				return new Promise<{ text: string }>((_resolve, reject) => {
					handle.signal.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					});
				});
			};
			const onDispose = vi.fn();
			const mb = makeMailbox({ dispatch, onDispose });
			enqueueTestJob(mb, "q");
			await new Promise((r) => setImmediate(r));
			await mb.dispose();
			expect(aborted).toBe(true);
			expect(onDispose).toHaveBeenCalledTimes(1);
			expect(() => enqueueTestJob(mb, "x")).toThrow(/disposed/);
		});
	});

	describe("dispatcher errors", () => {
		it("surfaces thrown dispatcher errors as terminal error jobs", async () => {
			const dispatch: Dispatcher<TestJob, TestNote> = async () => {
				throw new Error("boom");
			};
			const mb = makeMailbox({ dispatch });
			const { id } = enqueueTestJob(mb, "q");
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			const peek = mb.check({ id });
			expect(peek.tasks[0]?.status).toBe("error");
			expect(peek.tasks[0]?.error).toBe("boom");
		});

		it("dispatch jobPatch is merged before the terminal text is written", async () => {
			interface Patched extends TestJob {
				model?: string;
			}
			const dispatch: Dispatcher<Patched, TestNote> = async (handle) => {
				handle.setRunning();
				return {
					text: "ok",
					jobPatch: { model: "claude-x" } as Partial<Patched>,
				};
			};
			const mb = new AsyncJobMailbox<Patched, TestNote>({
				kind: "test",
				dispatch,
			});
			const { id } = mb.enqueue((jid, enqueuedAt) => ({
				id: jid,
				status: "queued",
				enqueuedAt,
				question: "q",
			}));
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			const peek = mb.check({ id });
			expect(peek.tasks[0]?.text).toBe("ok");
			expect((peek.tasks[0] as Patched | undefined)?.model).toBe("claude-x");
		});
	});
});
