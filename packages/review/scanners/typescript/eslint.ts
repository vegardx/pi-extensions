import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RawFinding } from "../../findings.js";
import type { ScannerSpec } from "../types.js";

/** Parse `eslint --format json` stdout. */
export function parseEslintOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`eslint output is not valid JSON: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
	if (!Array.isArray(parsed)) return [];
	const findings: RawFinding[] = [];
	for (const fileResult of parsed) {
		if (!fileResult || typeof fileResult !== "object") continue;
		const fr = fileResult as Record<string, unknown>;
		const file = typeof fr.filePath === "string" ? fr.filePath : null;
		if (!file || !Array.isArray(fr.messages)) continue;
		for (const msg of fr.messages as unknown[]) {
			if (!msg || typeof msg !== "object") continue;
			const m = msg as Record<string, unknown>;
			const text = typeof m.message === "string" ? m.message : "";
			if (!text) continue;
			const rule = typeof m.ruleId === "string" ? m.ruleId : "unknown";
			const severity =
				m.severity === 2 ? ("CRITICAL" as const) : ("IMPORTANT" as const);
			const line = typeof m.line === "number" ? m.line : undefined;
			findings.push({
				severity,
				file,
				line,
				title: `eslint(${rule}): ${text.slice(0, 80)}`,
				description: `ESLint rule ${rule}: ${text}`,
				suggestedAction: "",
			});
		}
	}
	return findings;
}

/** Detect ESLint flat-config or legacy `.eslintrc.*`. */
function detectEslint(cwd: string): boolean {
	const names = [
		"eslint.config.js",
		"eslint.config.mjs",
		"eslint.config.cjs",
		"eslint.config.ts",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.json",
		".eslintrc.yaml",
		".eslintrc.yml",
		".eslintrc",
	];
	return names.some((n) => existsSync(join(cwd, n)));
}

export const eslintSpec: ScannerSpec = {
	id: "eslint",
	languages: ["typescript", "javascript"],
	lane: "code-reviewer",
	defaultEnabled: false,
	budgetMs: 30_000,
	binary: "eslint",
	buildArgs: () => ["--format", "json", "."],
	detectAuto: detectEslint,
	parse: parseEslintOutput,
};
