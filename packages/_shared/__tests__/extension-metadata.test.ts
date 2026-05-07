import {
	type ConfigKeySchema,
	clearDeclaredExtensions,
	declareExtension,
	getDeclaredExtension,
	getDeclaredExtensions,
	resolveEffectiveValue,
} from "../extension-metadata.js";

beforeEach(() => {
	clearDeclaredExtensions();
});

describe("declareExtension / getDeclaredExtensions", () => {
	it("registers and returns declarations sorted by name", () => {
		declareExtension({ name: "verify", path: "/p/verify/index.ts" });
		declareExtension({ name: "commit", path: "/p/commit/index.ts" });
		declareExtension({ name: "startup", path: "/p/startup/index.ts" });

		const names = getDeclaredExtensions().map((m) => m.name);
		expect(names).toEqual(["commit", "startup", "verify"]);
	});

	it("dedupes by name, last write wins", () => {
		declareExtension({
			name: "verify",
			path: "/p/verify/old.ts",
			doc: "first",
		});
		declareExtension({
			name: "verify",
			path: "/p/verify/index.ts",
			doc: "second",
		});

		const all = getDeclaredExtensions();
		expect(all).toHaveLength(1);
		expect(all[0]?.path).toBe("/p/verify/index.ts");
		expect(all[0]?.doc).toBe("second");
	});

	it("sorts configSchema entries by key for stable rendering", () => {
		declareExtension({
			name: "verify",
			path: "/p/verify/index.ts",
			configSchema: [
				{ key: "model", type: "string", doc: "m" },
				{ key: "maxParallel", type: "number", default: 15, doc: "p" },
			],
		});
		const stored = getDeclaredExtension("verify");
		expect(stored?.configSchema?.map((c) => c.key)).toEqual([
			"maxParallel",
			"model",
		]);
	});

	it("clearDeclaredExtensions empties the registry", () => {
		declareExtension({ name: "a", path: "/a.ts" });
		declareExtension({ name: "b", path: "/b.ts" });
		expect(getDeclaredExtensions()).toHaveLength(2);
		clearDeclaredExtensions();
		expect(getDeclaredExtensions()).toEqual([]);
	});

	it("getDeclaredExtension returns undefined for unknown names", () => {
		expect(getDeclaredExtension("nope")).toBeUndefined();
	});
});

describe("resolveEffectiveValue", () => {
	const schema: ConfigKeySchema = {
		key: "maxParallel",
		type: "number",
		default: 15,
		doc: "Max concurrent verifier subagents.",
	};

	it("returns the schema default when nothing is set in either layer", () => {
		const r = resolveEffectiveValue({
			extName: "verify",
			key: "maxParallel",
			schema,
			layered: { global: {}, project: {} },
		});
		expect(r).toEqual({ value: 15, source: "default", isOverride: false });
	});

	it("returns the global value when only global is set", () => {
		const r = resolveEffectiveValue({
			extName: "verify",
			key: "maxParallel",
			schema,
			layered: {
				global: { extensionConfig: { verify: { maxParallel: 4 } } },
				project: {},
			},
		});
		expect(r).toEqual({ value: 4, source: "global", isOverride: true });
	});

	it("project wins over global when both are set", () => {
		const r = resolveEffectiveValue({
			extName: "verify",
			key: "maxParallel",
			schema,
			layered: {
				global: { extensionConfig: { verify: { maxParallel: 4 } } },
				project: { extensionConfig: { verify: { maxParallel: 8 } } },
			},
		});
		expect(r).toEqual({ value: 8, source: "project", isOverride: true });
	});

	it("returns undefined when no default and nothing configured", () => {
		const noDefault: ConfigKeySchema = {
			key: "model",
			type: "string",
			doc: "Override model.",
		};
		const r = resolveEffectiveValue({
			extName: "verify",
			key: "model",
			schema: noDefault,
			layered: { global: {}, project: {} },
		});
		expect(r).toEqual({
			value: undefined,
			source: "default",
			isOverride: false,
		});
	});

	it("treats explicit null in settings as a user-supplied value", () => {
		const r = resolveEffectiveValue({
			extName: "verify",
			key: "model",
			schema: { key: "model", type: "string", doc: "x" },
			layered: {
				global: {},
				project: {
					extensionConfig: { verify: { model: null as unknown as string } },
				},
			},
		});
		expect(r.source).toBe("project");
		expect(r.isOverride).toBe(true);
		expect(r.value).toBeNull();
	});

	describe("dot-notation keys", () => {
		const nestedSchema: ConfigKeySchema = {
			key: "review.enable",
			type: "boolean",
			default: true,
			doc: "Enable auto-review.",
		};

		it("resolves a nested key from the project layer", () => {
			const r = resolveEffectiveValue({
				extName: "modes",
				key: "review.enable",
				schema: nestedSchema,
				layered: {
					global: {},
					project: {
						extensionConfig: { modes: { review: { enable: false } } },
					},
				},
			});
			expect(r).toEqual({
				value: false,
				source: "project",
				isOverride: true,
			});
		});

		it("resolves a nested key from the global layer when project is absent", () => {
			const r = resolveEffectiveValue({
				extName: "modes",
				key: "review.enable",
				schema: nestedSchema,
				layered: {
					global: {
						extensionConfig: { modes: { review: { enable: false } } },
					},
					project: {},
				},
			});
			expect(r).toEqual({
				value: false,
				source: "global",
				isOverride: true,
			});
		});

		it("falls back to schema default when the nested path is absent", () => {
			const r = resolveEffectiveValue({
				extName: "modes",
				key: "review.enable",
				schema: nestedSchema,
				layered: {
					global: {},
					project: { extensionConfig: { modes: {} } },
				},
			});
			expect(r).toEqual({
				value: true,
				source: "default",
				isOverride: false,
			});
		});

		it("falls back to schema default when an intermediate segment is missing", () => {
			const r = resolveEffectiveValue({
				extName: "modes",
				key: "review.enable",
				schema: nestedSchema,
				layered: {
					global: {},
					project: {},
				},
			});
			expect(r).toEqual({
				value: true,
				source: "default",
				isOverride: false,
			});
		});

		it("resolves a nested string[] value", () => {
			const arrSchema: ConfigKeySchema = {
				key: "review.agents",
				type: "string[]",
				default: ["code-reviewer", "security-analyst"],
				doc: "Reviewer roles.",
			};
			const r = resolveEffectiveValue({
				extName: "modes",
				key: "review.agents",
				schema: arrSchema,
				layered: {
					global: {},
					project: {
						extensionConfig: {
							modes: { review: { agents: ["architect"] } },
						},
					},
				},
			});
			expect(r).toEqual({
				value: ["architect"],
				source: "project",
				isOverride: true,
			});
		});
	});
});
