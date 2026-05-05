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
});
