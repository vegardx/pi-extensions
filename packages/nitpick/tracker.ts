import { createHash } from "node:crypto";
import { basename, extname } from "node:path";

/** Minimum number of changed lines before we bother sending to the reviewer. */
export const MIN_CHANGED_LINES = 3;

/** Maximum file size we're willing to send to the reviewer (bytes). */
export const MAX_FILE_BYTES = 200 * 1024;

/** Directory segments we never review. */
const EXCLUDED_DIR_SEGMENTS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"coverage",
	".next",
	".nuxt",
	".turbo",
	".cache",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".mypy_cache",
	".pytest_cache",
]);

/** Filenames we never review. */
const EXCLUDED_BASENAMES: ReadonlySet<string> = new Set([
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"Cargo.lock",
	"poetry.lock",
	"Pipfile.lock",
	"composer.lock",
	"Gemfile.lock",
	"go.sum",
]);

/** Extensions we never review (binary or generated). */
const EXCLUDED_EXTENSIONS: ReadonlySet<string> = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".svg",
	".pdf",
	".zip",
	".gz",
	".tar",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".map",
	".min.js",
	".min.css",
]);

/**
 * Decide whether a path is eligible for review. Pure function — no IO.
 * Exposed so both the extension and the test suite can agree on the rules.
 */
export function shouldReview(absPath: string): boolean {
	const segments = absPath.split(/[\\/]/);
	for (const seg of segments) {
		if (EXCLUDED_DIR_SEGMENTS.has(seg)) return false;
	}
	const base = basename(absPath);
	if (EXCLUDED_BASENAMES.has(base)) return false;
	// Handle multi-suffix cases like ".min.js" explicitly.
	for (const ext of EXCLUDED_EXTENSIONS) {
		if (base.endsWith(ext)) return false;
	}
	const ext = extname(base).toLowerCase();
	if (EXCLUDED_EXTENSIONS.has(ext)) return false;
	return true;
}

/** Count non-context lines in a unified diff (additions and deletions). */
export function countChangedLines(diff: string): number {
	let n = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+") || line.startsWith("-")) n++;
	}
	return n;
}

/** Stable content hash for de-duping reviews of identical text. */
export function hashContent(content: string): string {
	return createHash("sha1").update(content).digest("hex");
}

/**
 * True if the reviewer returned any actionable findings. The reviewer emits
 * one of two sentinels when there is nothing to flag:
 *
 *  - "No simplifications suggested."            (new, session-scoped reviewer)
 *  - "No simplifications suggested for <file>." (legacy, per-file reviewer)
 *
 * We accept both so the helper keeps working if either prompt is in play.
 */
export function reviewHasFindings(review: string | undefined): boolean {
	if (!review) return false;
	const trimmed = review.trim();
	if (trimmed.length === 0) return false;
	if (/^No simplifications suggested\.?$/i.test(trimmed)) return false;
	if (/^No simplifications suggested for .+\.$/i.test(trimmed)) return false;
	return true;
}
