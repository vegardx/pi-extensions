import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RawFinding } from "../../findings.js";
import type { ScannerSpec } from "../types.js";

/** Parse `tsc --noEmit --pretty false` stderr/stdout text output. */
export function parseTscOutput(raw: string): RawFinding[] {
	const findings: RawFinding[] = [];
	const seen = new Set<string>();
	for (const m of raw.matchAll(
		/^(.+?)\((\d+),\d+\): (error|warning) (TS\d+): (.+)$/gm,
	)) {
		const [, file, lineStr, kind, code, msg] = m;
		if (!file || !lineStr || !kind || !code || !msg) continue;
		const line = Number(lineStr);
		const severity =
			kind === "error" ? ("CRITICAL" as const) : ("IMPORTANT" as const);
		const key = `${file}:${line}:${code}`;
		if (seen.has(key)) continue;
		seen.add(key);
		findings.push({
			severity,
			file: file.trim(),
			line,
			title: `${code}: ${msg.trim().slice(0, 80)}`,
			description: `TypeScript compiler: ${msg.trim()}`,
			suggestedAction: "",
		});
	}
	return findings;
}

export const tscSpec: ScannerSpec = {
	id: "tsc",
	languages: ["typescript"],
	lane: "code-reviewer",
	defaultEnabled: true,
	budgetMs: 30_000,
	binary: "tsc",
	buildArgs: () => ["--noEmit", "--pretty", "false"],
	detectAuto: (cwd) => existsSync(join(cwd, "tsconfig.json")),
	parse: parseTscOutput,
};
