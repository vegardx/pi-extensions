/**
 * Tests for SharedOverviewService — the session/cwd-scoped codebase
 * overview cache injected into clean explore children.
 *
 * The production builder spawns a subagent; tests inject a fake builder
 * via the `build` option so no process is launched.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SharedOverviewService } from "../plan/shared-overview-service.js";

const ctx = (cwd: string) => ({ cwd }) as unknown as ExtensionContext;

describe("SharedOverviewService", () => {
	it("builds once and caches the overview for the same cwd", async () => {
		const build = vi.fn(async () => "overview text");
		const svc = new SharedOverviewService({ build, waitMs: 1000 });

		expect(await svc.get(ctx("/repo"))).toBe("overview text");
		expect(await svc.get(ctx("/repo"))).toBe("overview text");
		expect(build).toHaveBeenCalledOnce();
	});

	it("rebuilds when the cwd changes", async () => {
		const build = vi.fn(async (c: ExtensionContext) => `overview:${c.cwd}`);
		const svc = new SharedOverviewService({ build, waitMs: 1000 });

		expect(await svc.get(ctx("/a"))).toBe("overview:/a");
		expect(await svc.get(ctx("/b"))).toBe("overview:/b");
		expect(build).toHaveBeenCalledTimes(2);
	});

	it("reset() clears the cached overview", async () => {
		const build = vi.fn(async () => "overview");
		const svc = new SharedOverviewService({ build, waitMs: 1000 });

		await svc.get(ctx("/repo"));
		svc.reset();
		await svc.get(ctx("/repo"));
		expect(build).toHaveBeenCalledTimes(2);
	});

	it("returns null when the build wait elapses, without blocking", async () => {
		let resolveBuild: (v: string | null) => void = () => {};
		const build = vi.fn(
			() =>
				new Promise<string | null>((resolve) => {
					resolveBuild = resolve;
				}),
		);
		const svc = new SharedOverviewService({ build, waitMs: 10 });

		// First get races the slow build against the short wait → null.
		expect(await svc.get(ctx("/repo"))).toBeNull();

		// When the build finally resolves, a later get sees the cached value.
		resolveBuild("late overview");
		await new Promise((r) => setImmediate(r));
		expect(await svc.get(ctx("/repo"))).toBe("late overview");
	});

	it("cools down after a failed build before retrying", async () => {
		const build = vi.fn(async () => null);
		const svc = new SharedOverviewService({ build, waitMs: 1000 });

		expect(await svc.get(ctx("/repo"))).toBeNull();
		// Within the cooldown window, no second build attempt is made.
		expect(await svc.get(ctx("/repo"))).toBeNull();
		expect(build).toHaveBeenCalledOnce();
	});
});
