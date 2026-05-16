import type { RawFinding } from "../../findings.js";
import type { ScannerSpec } from "../types.js";

/** Parse `biome check --reporter json` stdout. */
export function parseBiomeOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`biome output is not valid JSON: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const obj = parsed as Record<string, unknown>;
	if (!Array.isArray(obj.diagnostics)) return [];
	const findings: RawFinding[] = [];
	for (const d of obj.diagnostics as unknown[]) {
		if (!d || typeof d !== "object") continue;
		const diag = d as Record<string, unknown>;
		const category = typeof diag.category === "string" ? diag.category : "lint";
		const msgObj = diag.message as Record<string, unknown> | undefined;
		const msg =
			typeof diag.description === "string"
				? diag.description
				: typeof msgObj?.content === "string"
					? msgObj.content
					: "";
		if (!msg) continue;
		const sev = typeof diag.severity === "string" ? diag.severity : "";
		const severity =
			sev === "error" || sev === "fatal"
				? ("CRITICAL" as const)
				: ("IMPORTANT" as const);
		const loc = diag.location as Record<string, unknown> | undefined;
		const pathObj = loc?.path as Record<string, unknown> | undefined;
		const file = typeof pathObj?.file === "string" ? pathObj.file : null;
		if (!file) continue;
		const span = loc?.span as Record<string, unknown> | undefined;
		const startObj = span?.start as Record<string, unknown> | undefined;
		const line = typeof startObj?.line === "number" ? startObj.line : undefined;
		findings.push({
			severity,
			file,
			line,
			title: `biome: ${category} — ${msg.slice(0, 80)}`,
			description: `Biome lint (${category}): ${msg}`,
			suggestedAction: "",
		});
	}
	return findings;
}

export const biomeSpec: ScannerSpec = {
	id: "biome",
	languages: ["typescript", "javascript"],
	lane: "code-reviewer",
	defaultEnabled: true,
	budgetMs: 15_000,
	binary: "biome",
	buildArgs: () => ["check", "--reporter", "json", "."],
	parse: parseBiomeOutput,
};
