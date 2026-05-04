import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseModelSpec, resolveModel } from "../model-resolver.js";

/**
 * Build a minimal `ExtensionContext` stand-in with just enough shape
 * for the resolver's needs. We keep the mocking surface deliberately
 * tiny — the resolver only touches `cwd`, `model`, and `modelRegistry`.
 */
function fakeCtx(opts: {
	cwd: string;
	model?: Model<Api>;
	models?: Record<string, Model<Api>>; // "provider/id" -> model
	authOk?: Record<string, boolean>; // "provider/id" -> true if has key
}): ExtensionContext {
	const models = opts.models ?? {};
	const authOk = opts.authOk ?? {};
	const registry = {
		find(provider: string, modelId: string) {
			return models[`${provider}/${modelId}`];
		},
		async getApiKeyAndHeaders(m: Model<Api>) {
			const key = `${m.provider}/${m.id}`;
			return authOk[key] !== false
				? { ok: true as const, apiKey: "test-key" }
				: { ok: false as const, error: "no key" };
		},
	};
	return {
		cwd: opts.cwd,
		model: opts.model,
		modelRegistry: registry as unknown as ExtensionContext["modelRegistry"],
	} as ExtensionContext;
}

function makeModel(provider: string, id: string): Model<Api> {
	return { provider, id } as unknown as Model<Api>;
}

function mkTempCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-ext-resolver-test-"));
}

function writeProjectSettings(cwd: string, body: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(body));
}

function withIsolatedAgentDir<T>(fn: () => T | Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-resolver-test-agent-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	return Promise.resolve(fn()).finally(() => {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	});
}

describe("parseModelSpec", () => {
	it("splits provider/id correctly", () => {
		expect(parseModelSpec("anthropic/claude-haiku")).toEqual({
			provider: "anthropic",
			modelId: "claude-haiku",
		});
	});

	it("returns null for specs missing a slash", () => {
		expect(parseModelSpec("claude-haiku")).toBeNull();
	});

	it("returns null for specs with empty provider or id", () => {
		expect(parseModelSpec("/claude-haiku")).toBeNull();
		expect(parseModelSpec("anthropic/")).toBeNull();
	});

	it("keeps slashes inside the model id", () => {
		expect(parseModelSpec("openrouter/meta-llama/llama-3")).toEqual({
			provider: "openrouter",
			modelId: "meta-llama/llama-3",
		});
	});
});

describe("resolveModel", () => {
	it("prefers an explicit opts.explicit value over everything", async () => {
		await withIsolatedAgentDir(async () => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { nitpick: { model: "a/b" } },
					backgroundModels: { fast: "c/d" },
				});
				const explicit = makeModel("e", "f");
				const ctx = fakeCtx({
					cwd,
					model: makeModel("session", "model"),
					models: {
						"a/b": makeModel("a", "b"),
						"c/d": makeModel("c", "d"),
						"e/f": explicit,
					},
				});
				const r = await resolveModel(ctx, {
					name: "nitpick",
					tier: "fast",
					explicit: "e/f",
				});
				expect(r?.model).toBe(explicit);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("uses extensionConfig.<name>.model when no explicit is given", async () => {
		await withIsolatedAgentDir(async () => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { nitpick: { model: "a/b" } },
					backgroundModels: { fast: "c/d" },
				});
				const ctx = fakeCtx({
					cwd,
					model: makeModel("session", "model"),
					models: {
						"a/b": makeModel("a", "b"),
						"c/d": makeModel("c", "d"),
					},
				});
				const r = await resolveModel(ctx, { name: "nitpick", tier: "fast" });
				expect(r?.model.provider).toBe("a");
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("falls through to backgroundModels.<tier> when no extension override", async () => {
		await withIsolatedAgentDir(async () => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					backgroundModels: { fast: "c/d" },
				});
				const ctx = fakeCtx({
					cwd,
					model: makeModel("session", "model"),
					models: {
						"c/d": makeModel("c", "d"),
						"session/model": makeModel("session", "model"),
					},
				});
				const r = await resolveModel(ctx, { name: "nitpick", tier: "fast" });
				expect(r?.model.provider).toBe("c");
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("falls through to ctx.model when nothing is configured", async () => {
		await withIsolatedAgentDir(async () => {
			const cwd = mkTempCwd();
			try {
				const sessionModel = makeModel("session", "model");
				const ctx = fakeCtx({
					cwd,
					model: sessionModel,
					models: { "session/model": sessionModel },
				});
				const r = await resolveModel(ctx, { name: "nitpick", tier: "fast" });
				expect(r?.model).toBe(sessionModel);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("returns null when nothing resolves and there is no ctx.model", async () => {
		await withIsolatedAgentDir(async () => {
			const cwd = mkTempCwd();
			try {
				const ctx = fakeCtx({ cwd });
				const r = await resolveModel(ctx, { name: "nitpick", tier: "fast" });
				expect(r).toBeNull();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("skips a configured model that the registry can't find", async () => {
		await withIsolatedAgentDir(async () => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { nitpick: { model: "unknown/model" } },
					backgroundModels: { fast: "c/d" },
				});
				const ctx = fakeCtx({
					cwd,
					model: makeModel("session", "model"),
					models: {
						"c/d": makeModel("c", "d"),
					},
				});
				const r = await resolveModel(ctx, { name: "nitpick", tier: "fast" });
				expect(r?.model.provider).toBe("c");
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("skips a configured model that has no API key", async () => {
		await withIsolatedAgentDir(async () => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { nitpick: { model: "a/b" } },
					backgroundModels: { fast: "c/d" },
				});
				const ctx = fakeCtx({
					cwd,
					model: makeModel("session", "model"),
					models: {
						"a/b": makeModel("a", "b"),
						"c/d": makeModel("c", "d"),
					},
					authOk: { "a/b": false }, // no key for the override
				});
				const r = await resolveModel(ctx, { name: "nitpick", tier: "fast" });
				expect(r?.model.provider).toBe("c");
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("returns null when every candidate and ctx.model have no auth", async () => {
		await withIsolatedAgentDir(async () => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { nitpick: { model: "a/b" } },
					backgroundModels: { fast: "c/d" },
				});
				const sessionModel = makeModel("session", "model");
				const ctx = fakeCtx({
					cwd,
					model: sessionModel,
					models: {
						"a/b": makeModel("a", "b"),
						"c/d": makeModel("c", "d"),
						"session/model": sessionModel,
					},
					authOk: {
						"a/b": false,
						"c/d": false,
						"session/model": false,
					},
				});
				const r = await resolveModel(ctx, { name: "nitpick", tier: "fast" });
				expect(r).toBeNull();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});
});
