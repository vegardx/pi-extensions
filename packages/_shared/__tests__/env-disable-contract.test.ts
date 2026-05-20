/**
 * End-to-end check that every retrofitted extension respects the
 * wrapper's env-var kill switch.
 *
 * Loads each real extension's factory with `PI_EXT_<NAME>=off` set,
 * invokes it with a mock `ExtensionAPI`, and asserts:
 *
 *   1. No `register*` calls landed on the mock pi (nothing got wired
 *      into the host).
 *   2. The metadata registry records `loadState: "disabled-by-env"`
 *      and `enabled: false` so `/extensions` can render it correctly.
 *
 * This is the regression test for the bisect workflow — if env
 * override breaks for one extension (e.g. someone wraps the factory
 * back in a plain `function` and forgets `defineExtension`), this
 * test fails for that one package without affecting the others.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	__setDefineExtensionCwd,
	__setDefineExtensionEnv,
	clearDefineExtensionState,
} from "../define-extension.js";
import {
	clearDeclaredExtensions,
	getDeclaredExtension,
} from "../extension-metadata.js";

const PACKAGES = [
	"caffeinate",
	"commit",
	"derp",
	"editor",
	"exa",
	"idea",
	"modes",
	"prompt-suggestion",
	"review",
	"startup",
	"triage",
	"webfetch",
	"wrap-up",
] as const;

function envVar(name: string): string {
	return `PI_EXT_${name.replace(/-/g, "_").toUpperCase()}`;
}

function makeMockPi(): {
	pi: ExtensionAPI;
	registrations: string[];
} {
	const registrations: string[] = [];
	const record =
		(method: string) =>
		(...args: unknown[]) => {
			registrations.push(method);
			void args;
		};
	const pi = {
		on: record("on"),
		registerCommand: record("registerCommand"),
		registerTool: record("registerTool"),
		registerShortcut: record("registerShortcut"),
		registerFlag: record("registerFlag"),
		registerMessageRenderer: record("registerMessageRenderer"),
		registerProvider: record("registerProvider"),
		unregisterProvider: () => {},
		getCommands: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	return { pi, registrations };
}

describe("env-disable contract — every extension", () => {
	let cwd: string;
	let agentDir: string;
	let prevAgentDir: string | undefined;

	beforeAll(() => {
		// Force the wrapper to never see any pre-existing project /
		// global settings.json — the env override is what gets tested.
		agentDir = mkdtempSync(join(tmpdir(), "pi-ext-env-agent-"));
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-ext-env-cwd-"));
		__setDefineExtensionCwd(cwd);
		clearDefineExtensionState();
		clearDeclaredExtensions();
	});

	afterEach(() => {
		__setDefineExtensionCwd(undefined);
		__setDefineExtensionEnv(undefined);
		rmSync(cwd, { recursive: true, force: true });
	});

	for (const name of PACKAGES) {
		it(`${name}: registers nothing when ${envVar(name)}=off`, async () => {
			__setDefineExtensionEnv({ [envVar(name)]: "off" });
			const mod = (await import(`../../${name}/index.ts`)) as {
				default: (pi: ExtensionAPI) => void | Promise<void>;
			};
			const { pi, registrations } = makeMockPi();
			await mod.default(pi);

			const declared = getDeclaredExtension(name);
			expect(
				declared,
				`${name} did not call declareExtension via defineExtension`,
			).toBeDefined();
			expect(declared?.enabled).toBe(false);
			expect(declared?.enabledSource).toBe("env");
			expect(declared?.loadState).toBe("disabled-by-env");
			expect(
				registrations,
				`${name} registered ${registrations.length} handler(s) while env-disabled: ${registrations.join(", ")}`,
			).toEqual([]);
		});
	}

	if (prevAgentDir !== undefined) {
		// Vitest cleanup hook (afterAll equivalent inline at module scope
		// would race with describe's setup); instead reset agent dir on
		// process exit so other test files inherit a clean env.
		process.on("exit", () => {
			process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		});
	}
});
