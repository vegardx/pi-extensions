/**
 * The review extension registers the `reviewer` delegate target at
 * factory time (no /review command, no other registrations).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	__setDefineExtensionCwd,
	__setDefineExtensionEnv,
	clearDefineExtensionState,
} from "@vegardx/pi-extensions-shared/define-extension.js";
import {
	clearDelegateTargets,
	getDelegateTarget,
} from "@vegardx/pi-extensions-shared/delegate-registry.js";
import { clearDeclaredExtensions } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import reviewExtension from "../index.js";

function makeMockPi(): { pi: ExtensionAPI; registrations: string[] } {
	const registrations: string[] = [];
	const record =
		(method: string) =>
		(..._args: unknown[]) => {
			registrations.push(method);
		};
	const pi = {
		on: record("on"),
		registerCommand: record("registerCommand"),
		registerTool: record("registerTool"),
		registerShortcut: record("registerShortcut"),
		registerFlag: record("registerFlag"),
		registerMessageRenderer: record("registerMessageRenderer"),
		getCommands: () => [],
	} as unknown as ExtensionAPI;
	return { pi, registrations };
}

describe("review extension factory", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-review-target-"));
		__setDefineExtensionCwd(cwd);
		__setDefineExtensionEnv({ PI_EXT_REVIEW: "on" });
		clearDefineExtensionState();
		clearDeclaredExtensions();
		clearDelegateTargets();
	});

	afterEach(() => {
		__setDefineExtensionCwd(undefined);
		__setDefineExtensionEnv(undefined);
		clearDelegateTargets();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("registers the reviewer delegate target and no command", async () => {
		const { pi, registrations } = makeMockPi();
		await reviewExtension(pi);
		const target = getDelegateTarget("reviewer");
		expect(target).toBeDefined();
		expect(target?.paramsSchema).toBeDefined();
		// dependsOn:["subagent"] routes register* through the deferred
		// proxy, but the factory registers no commands/tools at all.
		expect(registrations.filter((r) => r !== "on")).toEqual([]);
	});

	it("reviewer target aborts cleanly outside a git repo", async () => {
		const { pi } = makeMockPi();
		await reviewExtension(pi);
		const target = getDelegateTarget("reviewer");
		const out = await target?.execute({
			message: "review this",
			ctx: { cwd, hasUI: false } as ExtensionContext,
		});
		expect(out?.text).toContain("not inside a git repository");
		expect((out?.details as { ran: boolean }).ran).toBe(false);
	});

	it("does not register when env-disabled", async () => {
		__setDefineExtensionEnv({ PI_EXT_REVIEW: "off" });
		const { pi } = makeMockPi();
		await reviewExtension(pi);
		expect(getDelegateTarget("reviewer")).toBeUndefined();
	});
});
