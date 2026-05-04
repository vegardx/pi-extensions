/**
 * Pure helpers for /review. Scope parsing + diff/file enumeration are split
 * into a pure part (argument → ReviewScope) and an I/O part (ReviewScope →
 * actual diff and file list). Both are tested.
 */

export type ReviewMode =
	| "working" // unstaged + staged combined (default when no args)
	| "staged" // `--staged`: index only
	| "branch" // `--branch`: full branch vs. default
	| "all" // `--all`: whole codebase, no diff
	| "file"; // one or more explicit paths

export interface ReviewScope {
	mode: ReviewMode;
	/** File paths for `mode === "file"`; empty otherwise. */
	paths: readonly string[];
}

const MODE_FLAGS: ReadonlyMap<string, ReviewMode> = new Map([
	["--staged", "staged"],
	["--branch", "branch"],
	["--all", "all"],
]);

/**
 * Parse the raw argument string into a ReviewScope. Unknown `--foo` flags
 * throw; positional arguments become `mode: "file"`. The parser is total:
 * anything that doesn't throw is a valid scope.
 *
 * Note: the `--deps` flag from earlier designs is gone — dependency-checker
 * now always runs. On diff scopes it only reports findings tied to
 * manifest/lockfile lines in the diff; on `--all` it covers everything.
 */
export function parseScope(args: string | undefined): ReviewScope {
	const tokens = (args ?? "")
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0);

	let mode: ReviewMode | null = null;
	const paths: string[] = [];

	for (const tok of tokens) {
		const modeForFlag = MODE_FLAGS.get(tok);
		if (modeForFlag !== undefined) {
			if (mode && mode !== modeForFlag) {
				throw new Error(
					`/review: conflicting scope flags — got both --${mode} and ${tok}`,
				);
			}
			mode = modeForFlag;
			continue;
		}
		if (tok.startsWith("--")) {
			throw new Error(`/review: unknown flag ${tok}`);
		}
		if (mode && mode !== "file") {
			throw new Error(
				`/review: cannot combine a scope flag (--${mode}) with explicit paths`,
			);
		}
		mode = "file";
		paths.push(tok);
	}

	if (!mode) mode = "working";

	return { mode, paths };
}
