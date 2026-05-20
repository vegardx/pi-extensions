import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	__setDefineExtensionCwd,
	__setDefineExtensionEnv,
	clearDefineExtensionState,
	defineExtension,
} from "../define-extension.js";
import {
	clearDeclaredExtensions,
	getDeclaredExtension,
} from "../extension-metadata.js";

interface MockCall {
	method: string;
	args: unknown[];
}

type SessionHandler = (
	event: { sessionId: string; reason: string },
	ctx: { ui: { notify: (msg: string, level: string) => void } },
) => void;

interface MockPi {
	pi: ExtensionAPI;
	calls: MockCall[];
	notifies: { msg: string; level: string }[];
	fireSessionStart: () => void;
}

function makeMockPi(): MockPi {
	const calls: MockCall[] = [];
	const notifies: { msg: string; level: string }[] = [];
	const sessionHandlers: SessionHandler[] = [];

	const record =
		(method: string) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
		};

	const on = (event: string, handler: SessionHandler) => {
		calls.push({ method: "on", args: [event, handler] });
		if (event === "session_start") sessionHandlers.push(handler);
	};

	const pi = {
		on,
		registerCommand: record("registerCommand"),
		registerTool: record("registerTool"),
		registerShortcut: record("registerShortcut"),
		registerFlag: record("registerFlag"),
		registerMessageRenderer: record("registerMessageRenderer"),
		registerProvider: record("registerProvider"),
		unregisterProvider: record("unregisterProvider"),
		getCommands: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;

	const ctx = {
		ui: {
			notify: (msg: string, level: string) => {
				notifies.push({ msg, level });
			},
		},
	};

	return {
		pi,
		calls,
		notifies,
		fireSessionStart: () => {
			for (const h of sessionHandlers) {
				h({ sessionId: "s1", reason: "startup" }, ctx);
			}
		},
	};
}

function mkTempCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-ext-define-test-"));
}

function writeProjectSettings(cwd: string, body: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(body));
}

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-ext-define-test-agent-"));
	clearDeclaredExtensions();
	clearDefineExtensionState();
	__setDefineExtensionEnv({});
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	__setDefineExtensionEnv(undefined);
	__setDefineExtensionCwd(undefined);
});

describe("defineExtension — enabled resolution", () => {
	it("defaults to OFF when no setting is present", () => {
		const cwd = mkTempCwd();
		try {
			__setDefineExtensionCwd(cwd, agentDir);
			const factory = vi.fn();
			const wrapped = defineExtension(
				{ name: "demo", path: "/p/demo/index.ts" },
				factory,
			);
			const { pi } = makeMockPi();
			wrapped(pi);
			expect(factory).not.toHaveBeenCalled();
			const meta = getDeclaredExtension("demo");
			expect(meta?.enabled).toBe(false);
			expect(meta?.loadState).toBe("disabled-by-config");
			expect(meta?.enabledSource).toBe("default");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("loads the factory when project settings enable it", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: { demo: { enabled: true } },
			});
			__setDefineExtensionCwd(cwd, agentDir);
			const factory = vi.fn();
			defineExtension(
				{ name: "demo", path: "/p/demo/index.ts" },
				factory,
			)(makeMockPi().pi);
			expect(factory).toHaveBeenCalledTimes(1);
			expect(getDeclaredExtension("demo")?.enabledSource).toBe("project");
			expect(getDeclaredExtension("demo")?.loadState).toBe("loaded");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("loads when global settings enable it and project is silent", () => {
		const cwd = mkTempCwd();
		try {
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ extensionConfig: { demo: { enabled: true } } }),
			);
			__setDefineExtensionCwd(cwd, agentDir);
			const factory = vi.fn();
			defineExtension(
				{ name: "demo", path: "/p/demo/index.ts" },
				factory,
			)(makeMockPi().pi);
			expect(factory).toHaveBeenCalledTimes(1);
			expect(getDeclaredExtension("demo")?.enabledSource).toBe("global");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("project setting overrides global", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: { demo: { enabled: false } },
			});
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ extensionConfig: { demo: { enabled: true } } }),
			);
			__setDefineExtensionCwd(cwd, agentDir);
			const factory = vi.fn();
			defineExtension(
				{ name: "demo", path: "/p/demo/index.ts" },
				factory,
			)(makeMockPi().pi);
			expect(factory).not.toHaveBeenCalled();
			expect(getDeclaredExtension("demo")?.enabledSource).toBe("project");
			expect(getDeclaredExtension("demo")?.loadState).toBe(
				"disabled-by-config",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("env var overrides project and global", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: { demo: { enabled: true } },
			});
			__setDefineExtensionCwd(cwd, agentDir);
			__setDefineExtensionEnv({ PI_EXT_DEMO: "off" });
			const factory = vi.fn();
			defineExtension(
				{ name: "demo", path: "/p/demo/index.ts" },
				factory,
			)(makeMockPi().pi);
			expect(factory).not.toHaveBeenCalled();
			expect(getDeclaredExtension("demo")?.enabledSource).toBe("env");
			expect(getDeclaredExtension("demo")?.loadState).toBe("disabled-by-env");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("env var can force-enable a disabled extension", () => {
		const cwd = mkTempCwd();
		try {
			__setDefineExtensionCwd(cwd, agentDir);
			__setDefineExtensionEnv({ PI_EXT_DEMO: "1" });
			const factory = vi.fn();
			defineExtension(
				{ name: "demo", path: "/p/demo/index.ts" },
				factory,
			)(makeMockPi().pi);
			expect(factory).toHaveBeenCalledTimes(1);
			expect(getDeclaredExtension("demo")?.enabledSource).toBe("env");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("normalises kebab-case names to env var format", () => {
		const cwd = mkTempCwd();
		try {
			__setDefineExtensionCwd(cwd, agentDir);
			__setDefineExtensionEnv({ PI_EXT_PROMPT_SUGGESTION: "on" });
			const factory = vi.fn();
			defineExtension(
				{ name: "prompt-suggestion", path: "/p/x/index.ts" },
				factory,
			)(makeMockPi().pi);
			expect(factory).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("ignores garbage env values and falls back", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: { demo: { enabled: true } },
			});
			__setDefineExtensionCwd(cwd, agentDir);
			__setDefineExtensionEnv({ PI_EXT_DEMO: "maybe" });
			const factory = vi.fn();
			defineExtension(
				{ name: "demo", path: "/p/demo/index.ts" },
				factory,
			)(makeMockPi().pi);
			expect(factory).toHaveBeenCalledTimes(1);
			expect(getDeclaredExtension("demo")?.enabledSource).toBe("project");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("defineExtension — registration gating", () => {
	it("disabled extension does not register anything", () => {
		const cwd = mkTempCwd();
		try {
			__setDefineExtensionCwd(cwd, agentDir);
			const { pi, calls } = makeMockPi();
			defineExtension({ name: "demo", path: "/p/demo/index.ts" }, (api) => {
				api.registerCommand("demo", {
					description: "x",
					handler: () => {},
				} as never);
				api.on("session_start", () => {});
			})(pi);
			expect(calls).toHaveLength(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("enabled extension with no hard deps registers immediately", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: { demo: { enabled: true } },
			});
			__setDefineExtensionCwd(cwd, agentDir);
			const { pi, calls } = makeMockPi();
			defineExtension({ name: "demo", path: "/p/demo/index.ts" }, (api) => {
				api.registerCommand("demo", {
					description: "x",
					handler: () => {},
				} as never);
			})(pi);
			expect(calls.map((c) => c.method)).toEqual(["registerCommand"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("defineExtension — metadata propagation", () => {
	it("records dependsOn and integratesWith on the declaration", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: { demo: { enabled: true } },
			});
			__setDefineExtensionCwd(cwd, agentDir);
			defineExtension(
				{
					name: "demo",
					path: "/p/demo/index.ts",
					dependsOn: ["foo"],
					integratesWith: ["bar", "baz"],
				},
				() => {},
			)(makeMockPi().pi);
			const meta = getDeclaredExtension("demo");
			expect(meta?.dependsOn).toEqual(["foo"]);
			expect(meta?.integratesWith).toEqual(["bar", "baz"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("defineExtension — soft integratesWith notices", () => {
	it("info-notifies when an integratesWith dep is not installed", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: { commit: { enabled: true } },
			});
			__setDefineExtensionCwd(cwd, agentDir);
			const mock = makeMockPi();
			defineExtension(
				{
					name: "commit",
					path: "/p/commit/index.ts",
					integratesWith: ["review"],
				},
				() => {},
			)(mock.pi);
			mock.fireSessionStart();
			expect(mock.notifies).toEqual([
				{
					msg: "ℹ commit's review integration unavailable (review not installed)",
					level: "info",
				},
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("info-notifies when an integratesWith dep is disabled", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: {
					commit: { enabled: true },
					review: { enabled: false },
				},
			});
			__setDefineExtensionCwd(cwd, agentDir);
			const mock = makeMockPi();
			defineExtension({ name: "review", path: "/p/review/index.ts" }, () => {})(
				mock.pi,
			);
			defineExtension(
				{
					name: "commit",
					path: "/p/commit/index.ts",
					integratesWith: ["review"],
				},
				() => {},
			)(mock.pi);
			mock.fireSessionStart();
			expect(mock.notifies).toEqual([
				{
					msg: "ℹ commit's review integration unavailable (review currently disabled)",
					level: "info",
				},
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("emits no notice when integratesWith dep is loaded", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: {
					commit: { enabled: true },
					review: { enabled: true },
				},
			});
			__setDefineExtensionCwd(cwd, agentDir);
			const mock = makeMockPi();
			defineExtension({ name: "review", path: "/p/review/index.ts" }, () => {})(
				mock.pi,
			);
			defineExtension(
				{
					name: "commit",
					path: "/p/commit/index.ts",
					integratesWith: ["review"],
				},
				() => {},
			)(mock.pi);
			mock.fireSessionStart();
			expect(mock.notifies).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("defineExtension — strict dependsOn enforcement", () => {
	it("refuses to load when a hard dep is not installed", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: { app: { enabled: true } },
			});
			__setDefineExtensionCwd(cwd, agentDir);
			const mock = makeMockPi();
			const factory = vi.fn((api: ExtensionAPI) => {
				api.registerCommand("app", {
					description: "x",
					handler: () => {},
				} as never);
			});
			defineExtension(
				{
					name: "app",
					path: "/p/app/index.ts",
					dependsOn: ["core"],
				},
				factory,
			)(mock.pi);
			expect(factory).toHaveBeenCalledTimes(1);
			mock.fireSessionStart();
			expect(
				mock.calls.filter((c) => c.method === "registerCommand"),
			).toHaveLength(0);
			const meta = getDeclaredExtension("app");
			expect(meta?.loadState).toBe("disabled-by-missing-deps");
			expect(mock.notifies.find((n) => n.level === "error")?.msg).toContain(
				"app refused to load",
			);
			expect(mock.notifies.find((n) => n.level === "error")?.msg).toContain(
				"core (not installed)",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("refuses when hard dep is installed but disabled", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: {
					app: { enabled: true },
					core: { enabled: false },
				},
			});
			__setDefineExtensionCwd(cwd, agentDir);
			const mock = makeMockPi();
			defineExtension({ name: "core", path: "/p/core/index.ts" }, () => {})(
				mock.pi,
			);
			defineExtension(
				{
					name: "app",
					path: "/p/app/index.ts",
					dependsOn: ["core"],
				},
				(api) => {
					api.registerCommand("app", {
						description: "x",
						handler: () => {},
					} as never);
				},
			)(mock.pi);
			mock.fireSessionStart();
			expect(
				mock.calls.filter((c) => c.method === "registerCommand"),
			).toHaveLength(0);
			expect(mock.notifies.find((n) => n.level === "error")?.msg).toContain(
				"core (currently disabled)",
			);
			expect(getDeclaredExtension("app")?.loadState).toBe(
				"disabled-by-missing-deps",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("loads when hard dep is enabled — flushes deferred queue", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: {
					app: { enabled: true },
					core: { enabled: true },
				},
			});
			__setDefineExtensionCwd(cwd, agentDir);
			const mock = makeMockPi();
			defineExtension({ name: "core", path: "/p/core/index.ts" }, () => {})(
				mock.pi,
			);
			defineExtension(
				{
					name: "app",
					path: "/p/app/index.ts",
					dependsOn: ["core"],
				},
				(api) => {
					api.registerCommand("app", {
						description: "x",
						handler: () => {},
					} as never);
				},
			)(mock.pi);
			// Before session_start, the deferred call hasn't been replayed.
			expect(
				mock.calls.filter((c) => c.method === "registerCommand"),
			).toHaveLength(0);
			mock.fireSessionStart();
			expect(
				mock.calls.filter((c) => c.method === "registerCommand"),
			).toHaveLength(1);
			expect(getDeclaredExtension("app")?.loadState).toBe("loaded");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("a hard-dep extension's session_start listener fires (regression: PR #248 review)", () => {
		const cwd = mkTempCwd();
		try {
			writeProjectSettings(cwd, {
				extensionConfig: {
					app: { enabled: true },
					core: { enabled: true },
				},
			});
			__setDefineExtensionCwd(cwd, agentDir);
			const mock = makeMockPi();
			let sessionStartFired = false;
			defineExtension({ name: "core", path: "/p/core/index.ts" }, () => {})(
				mock.pi,
			);
			defineExtension(
				{
					name: "app",
					path: "/p/app/index.ts",
					dependsOn: ["core"],
				},
				(api) => {
					api.on("session_start", () => {
						sessionStartFired = true;
					});
				},
			)(mock.pi);
			mock.fireSessionStart();
			expect(sessionStartFired).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
