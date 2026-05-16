import type { RawFinding } from "../../findings.js";
import type { ScannerSpec } from "../types.js";

/** Parse `knip --reporter json` stdout. */
export function parseKnipOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`knip output is not valid JSON: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const obj = parsed as Record<string, unknown>;
	const findings: RawFinding[] = [];

	if (Array.isArray(obj.files)) {
		for (const f of obj.files as unknown[]) {
			if (typeof f !== "string") continue;
			findings.push({
				severity: "NOTE",
				file: f,
				title: "unused file",
				description: `knip: ${f} has no imports and is not an entry point.`,
				suggestedAction: "Remove or add as an entry point.",
			});
		}
	}

	if (Array.isArray(obj.issues)) {
		for (const item of obj.issues as unknown[]) {
			if (!item || typeof item !== "object") continue;
			const it = item as Record<string, unknown>;
			const file = typeof it.file === "string" ? it.file : null;
			if (!file || !Array.isArray(it.issues)) continue;
			for (const issue of it.issues as unknown[]) {
				if (!issue || typeof issue !== "object") continue;
				const iss = issue as Record<string, unknown>;
				const type = typeof iss.type === "string" ? iss.type : "unknown";
				const name = typeof iss.name === "string" ? iss.name : "(unnamed)";
				const line = typeof iss.line === "number" ? iss.line : undefined;
				findings.push({
					severity: "NOTE",
					file,
					line,
					title: `unused ${type}: ${name}`,
					description: `knip: ${type} "${name}" in ${file} is unused.`,
					suggestedAction: `Remove or re-export "${name}".`,
				});
			}
		}
	}
	return findings;
}

export const knipSpec: ScannerSpec = {
	id: "knip",
	languages: ["typescript", "javascript"],
	lane: "code-simplifier",
	defaultEnabled: false,
	budgetMs: 60_000,
	binary: "knip",
	buildArgs: () => ["--reporter", "json"],
	parse: parseKnipOutput,
};
