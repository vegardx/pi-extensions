import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getDeclaredExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import caffeinateExt from "pi-ext-caffeinate";
import derpExt from "pi-ext-derp";
import editorExt from "pi-ext-editor";
import ideaExt from "pi-ext-idea";
import modesExt from "pi-ext-modes";
import startupExt from "pi-ext-startup";
import webfetchExt from "pi-ext-webfetch";
import wrapUpExt from "pi-ext-wrap-up";

// Every declared extension whose schema we contract-check. Invoking the
// default export runs `declareExtension` (registering configSchema) before
// the enabled check, so disabling each via env registers metadata without
// running the factory body — caffeinate in particular must not actually
// spawn a keep-awake subprocess here.
const EXTENSIONS: Array<[string, (pi: ExtensionAPI) => unknown]> = [
	["startup", startupExt],
	["modes", modesExt],
	["caffeinate", caffeinateExt],
	["editor", editorExt],
	["wrap-up", wrapUpExt],
	["webfetch", webfetchExt],
	["derp", derpExt],
	["idea", ideaExt],
];

const VALID_TYPES = new Set([
	"string",
	"string[]",
	"number",
	"boolean",
	"enum",
]);

function isModelKey(key: string): boolean {
	return key === "model" || key.endsWith(".model");
}

beforeAll(() => {
	const saved: Record<string, string | undefined> = {};
	for (const [name] of EXTENSIONS) {
		const envVar = `PI_EXT_${name.replace(/-/g, "_").toUpperCase()}`;
		saved[envVar] = process.env[envVar];
		process.env[envVar] = "off";
	}
	for (const [, ext] of EXTENSIONS) ext({} as ExtensionAPI);
	for (const [envVar, prev] of Object.entries(saved)) {
		if (prev === undefined) delete process.env[envVar];
		else process.env[envVar] = prev;
	}
});

describe.each(
	EXTENSIONS.map(([name]) => name),
)("configSchema contract: %s", (name) => {
	const schema = () => getDeclaredExtension(name)?.configSchema ?? [];

	it("registered its metadata", () => {
		expect(getDeclaredExtension(name)).toBeDefined();
	});

	it("every knob has a valid type, a unique key, and a non-empty doc", () => {
		const keys = new Set<string>();
		for (const k of schema()) {
			expect(VALID_TYPES.has(k.type), `${name}.${k.key} type ${k.type}`).toBe(
				true,
			);
			expect(k.key.length, `${name} has an empty key`).toBeGreaterThan(0);
			expect(keys.has(k.key), `${name}.${k.key} duplicated`).toBe(false);
			keys.add(k.key);
			expect(
				typeof k.doc === "string" && k.doc.trim().length > 0,
				`${name}.${k.key} doc`,
			).toBe(true);
		}
	});

	it("enum knobs declare non-empty enumValues; non-enum knobs don't", () => {
		for (const k of schema()) {
			if (k.type === "enum") {
				expect(
					(k.enumValues?.length ?? 0) > 0,
					`${name}.${k.key} enum needs enumValues`,
				).toBe(true);
			}
		}
	});

	it("model knobs use a fallbackChain and no literal default; other knobs declare a default", () => {
		for (const k of schema()) {
			if (isModelKey(k.key)) {
				expect(
					typeof k.fallbackChain === "string" && k.fallbackChain.length > 0,
					`${name}.${k.key} model key needs fallbackChain`,
				).toBe(true);
				expect(
					k.default,
					`${name}.${k.key} model key must not pin a literal default`,
				).toBeUndefined();
			} else {
				expect(
					k.default,
					`${name}.${k.key} needs a literal default`,
				).toBeDefined();
			}
		}
	});
});
