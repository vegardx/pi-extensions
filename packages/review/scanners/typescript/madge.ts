import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RawFinding } from "../../findings.js";
import type { ScannerSpec } from "../types.js";

/**
 * Parse `madge --circular --json <path>` stdout.
 *
 * Output shape: an array of arrays, where each inner array is one
 * cycle in DFS traversal order WITHOUT the closing repeat:
 *   `[["a", "b", "c"]]` ⇒ `a → b → c → a`
 *
 * Empty result (no cycles): `[]`. Madge exits non-zero (`1`) when
 * cycles are found, but we read findings from the JSON, not the exit
 * code — the registry forwards non-empty stdout to us regardless.
 */
export function parseMadgeOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`madge output is not valid JSON: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
	if (!Array.isArray(parsed)) return [];
	const findings: RawFinding[] = [];

	for (const cycle of parsed as unknown[]) {
		if (!Array.isArray(cycle)) continue;
		const files = (cycle as unknown[]).filter(
			(x): x is string => typeof x === "string" && x.length > 0,
		);
		if (files.length < 2) continue;

		const head = files[0];
		if (!head) continue;
		const closed = `${files.join(" → ")} → ${head}`;
		findings.push({
			severity: "IMPORTANT",
			file: head,
			title: `madge: circular dependency in ${head} (cycle of ${files.length})`,
			description: `Cycle: ${closed}`,
			suggestedAction:
				"Break the cycle by extracting a shared module or inverting a dependency.",
		});
	}

	return findings;
}

/**
 * madge is typically a devDep — probe via `node_modules/.bin/madge`.
 * Default-disabled: not every project installs it, and circular-dep
 * findings can be noisy in legacy codebases. 166c may flip this to
 * `enable: "auto"` based on madge being in `node_modules`.
 */
export const madgeSpec: ScannerSpec = {
	id: "madge",
	languages: ["typescript", "javascript"],
	lane: "code-simplifier",
	defaultEnabled: false,
	budgetMs: 30_000,
	binary: "madge",
	buildArgs: () => ["--circular", "--json", "."],
	detectAuto: (cwd) => existsSync(join(cwd, "node_modules", ".bin", "madge")),
	parse: parseMadgeOutput,
};
