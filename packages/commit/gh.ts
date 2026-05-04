import { runCommand, type ShellResult } from "./git.js";

/**
 * Minimal subset of PR metadata needed for `/commit`'s push and update
 * flows. Fetched via `gh pr view --json`.
 */
export interface PrMetadata {
	number: number;
	title: string;
	body: string;
	state: string;
	baseRefName: string;
	headRefName: string;
	isCrossRepository: boolean;
	maintainerCanModify: boolean;
	headRepositoryNameWithOwner: string;
	headRepositoryOwnerLogin: string;
}

function parsePrMetadata(raw: string): PrMetadata | null {
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		const head = (obj.headRepository ?? {}) as { nameWithOwner?: string };
		const owner = (obj.headRepositoryOwner ?? {}) as { login?: string };
		return {
			number: Number(obj.number),
			title: String(obj.title ?? ""),
			body: String(obj.body ?? ""),
			state: String(obj.state ?? ""),
			baseRefName: String(obj.baseRefName ?? ""),
			headRefName: String(obj.headRefName ?? ""),
			isCrossRepository: Boolean(obj.isCrossRepository),
			maintainerCanModify: Boolean(obj.maintainerCanModify),
			headRepositoryNameWithOwner: String(head.nameWithOwner ?? ""),
			headRepositoryOwnerLogin: String(owner.login ?? ""),
		};
	} catch {
		return null;
	}
}

const PR_FIELDS = [
	"number",
	"title",
	"body",
	"state",
	"baseRefName",
	"headRefName",
	"isCrossRepository",
	"maintainerCanModify",
	"headRepository",
	"headRepositoryOwner",
].join(",");

/**
 * Find an open PR whose head is `branch`. Returns null when none exists,
 * or when `gh` itself fails (e.g. not authed). Distinguishes `gh` failure
 * from "no PR" via `error`.
 */
export function findOpenPr(
	cwd: string,
	branch: string,
): { pr: PrMetadata | null; error?: string } {
	const r = runCommand(
		"gh",
		[
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			PR_FIELDS,
			"--limit",
			"1",
		],
		{ cwd },
	);
	if (!r.ok)
		return { pr: null, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
	const trimmed = r.stdout.trim();
	if (!trimmed) return { pr: null };
	let arr: unknown;
	try {
		arr = JSON.parse(trimmed);
	} catch {
		return {
			pr: null,
			error: `gh pr list: unparseable JSON: ${trimmed.slice(0, 200)}`,
		};
	}
	if (!Array.isArray(arr) || arr.length === 0) return { pr: null };
	const parsed = parsePrMetadata(JSON.stringify(arr[0]));
	if (!parsed) return { pr: null, error: "gh pr list: unexpected shape" };
	return { pr: parsed };
}

/** `gh pr view <N> --json ...`. Used to refresh metadata after a push. */
export function viewPr(
	cwd: string,
	number: number,
): { pr: PrMetadata | null; error?: string } {
	const r = runCommand(
		"gh",
		["pr", "view", String(number), "--json", PR_FIELDS],
		{ cwd },
	);
	if (!r.ok)
		return { pr: null, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
	const pr = parsePrMetadata(r.stdout);
	return pr ? { pr } : { pr: null, error: "parse failure" };
}

/**
 * Create a PR. Uses `--body-file -` on stdin so multi-line / backtick
 * bodies survive without shell escaping hassles. Returns the URL of the
 * created PR (stdout of `gh pr create` is the URL on success).
 */
export function createPr(
	cwd: string,
	title: string,
	body: string,
): { url: string | null; error?: string } {
	const r = runCommand(
		"gh",
		["pr", "create", "--title", title, "--body-file", "-"],
		{ cwd, stdin: body },
	);
	if (!r.ok)
		return { url: null, error: r.stderr.trim() || `gh exit ${r.exitCode}` };
	const url = r.stdout.trim().match(/https?:\/\/\S+/)?.[0] ?? null;
	return { url };
}

export function editPr(
	cwd: string,
	number: number,
	title: string,
	body: string,
): ShellResult {
	return runCommand(
		"gh",
		["pr", "edit", String(number), "--title", title, "--body-file", "-"],
		{ cwd, stdin: body },
	);
}
