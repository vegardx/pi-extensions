/**
 * `gh issue create` wrapper for fire-and-forget issue filers
 * (`/derp`, `/idea`, …).
 *
 * Pure helpers (`buildIssueArgv`, `parseIssueUrl`,
 * `pendingFilePath`, `defaultPendingDir`) are tested in isolation;
 * the shell-out itself is exercised via a thin `GhRunner` seam
 * injected from the caller.
 *
 * Loss-proof: every failure path stashes the polished report under
 * `~/.pi/agent/<extId>/pending/` so the user's text is never
 * dropped.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface IssueDraft {
	title: string;
	body: string;
}

export interface IssueCreateInput {
	draft: IssueDraft;
	labels: readonly string[];
	cwd: string;
	/** Hostname used for the pending-file name and notify message. */
	host: string;
	/**
	 * Hard target for `gh -R`. Format `host/owner/repo`. Always
	 * passed — the caller decides whether to hardcode the repo
	 * (e.g. `/derp` always files at `vegardx/pi-extensions`) or
	 * detect cwd's origin (`/idea`).
	 */
	targetRepo: string;
}

export type IssueCreateOutcome =
	| { ok: true; url: string }
	| {
			ok: false;
			reason:
				| "auth"
				| "gh-missing"
				| "gh-failed"
				| "no-url-in-output"
				| "labels-rejected";
			detail: string;
			pendingPath?: string;
	  };

/**
 * Build the argv passed to `gh issue create`. Always includes `-R
 * <target>` so the issue lands in the configured target repo,
 * regardless of the cwd's origin.
 */
export function buildIssueArgv(opts: {
	title: string;
	labels: readonly string[];
	targetRepo: string;
}): string[] {
	const argv = [
		"issue",
		"create",
		"-R",
		opts.targetRepo,
		"--title",
		opts.title,
		"--body-file",
		"-",
	];
	for (const label of opts.labels) {
		if (!label) continue;
		argv.push("--label", label);
	}
	return argv;
}

/**
 * Pull the issue URL out of `gh issue create` stdout. gh prints the
 * URL on the last non-empty line of stdout on success.
 */
export function parseIssueUrl(stdout: string): string | null {
	const lines = stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line) continue;
		if (/^https?:\/\//.test(line)) return line;
	}
	return null;
}

/**
 * Detect the gh stderr signature for "label X not found in repo Y".
 * gh exits non-zero with a message like:
 *   could not add label: 'foo' not found
 * We retry once without `--label` rather than asking the user to
 * pick a different set.
 */
export function isUnknownLabelError(stderr: string): boolean {
	const s = stderr.toLowerCase();
	return s.includes("not found") && s.includes("label");
}

/** Detect the gh stderr signature for "not authenticated". */
export function isAuthError(stderr: string): boolean {
	const s = stderr.toLowerCase();
	return (
		s.includes("authentication") ||
		s.includes("not logged into") ||
		s.includes("gh auth login") ||
		s.includes("hostname required")
	);
}

// ---------------------------------------------------------------------------
// Pending-file fallback
// ---------------------------------------------------------------------------

/**
 * Default pending-report directory for an extension:
 * `~/.pi/agent/<extId>/pending/`.
 */
export function defaultPendingDir(extId: string): string {
	return join(homedir(), ".pi", "agent", extId, "pending");
}

/**
 * Where a pending report would live for a given timestamp. Filename
 * is `<timestamp>-<short-host>.md` so multiple reports on the same
 * day stay distinct without colliding.
 */
export function pendingFilePath(opts: {
	host: string;
	dir: string;
	at?: Date;
}): string {
	const at = opts.at ?? new Date();
	const ts = at.toISOString().replace(/[:.]/g, "-");
	const safeHost = opts.host.replace(/[^a-z0-9.-]/gi, "_");
	return join(opts.dir, `${ts}-${safeHost}.md`);
}

/**
 * Write `draft` to a file under `dir` so the user can recover it by
 * running `gh issue create --body-file <path>` after fixing
 * whatever blocked the original attempt.
 *
 * The file is `# <title>` followed by the body, so it's also
 * readable as-is.
 */
export function writePendingReport(
	draft: IssueDraft,
	host: string,
	dir: string,
): string {
	const path = pendingFilePath({ host, dir });
	mkdirSync(dir, { recursive: true });
	const content = `# ${draft.title}\n\n${draft.body}\n`;
	writeFileSync(path, content, "utf8");
	return path;
}

// ---------------------------------------------------------------------------
// Shell runner
// ---------------------------------------------------------------------------

export interface GhRunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Seam for tests. Production passes `spawnSync` via `runGh`; tests
 * inject a stub that records the argv + stdin and returns canned
 * output.
 */
export type GhRunner = (
	argv: readonly string[],
	stdin: string,
	cwd: string,
) => GhRunResult;

export const runGh: GhRunner = (argv, stdin, cwd) => {
	const r = spawnSync("gh", argv as string[], {
		cwd,
		encoding: "utf8",
		shell: false,
		env: process.env,
		input: stdin,
	});
	if (r.error) {
		return {
			status: null,
			stdout: r.stdout ?? "",
			stderr:
				r.stderr ??
				(r.error instanceof Error ? r.error.message : String(r.error)),
		};
	}
	return {
		status: r.status ?? null,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Fire `gh issue create`, retry once without labels if gh rejects
 * them, and stash the report on any other failure. Never throws.
 *
 * `pendingDir` is required — callers compute it via
 * `defaultPendingDir(extId)` (or override). Keeping it explicit
 * removes the per-call temptation to forget about loss-proofing.
 */
export function createIssue(
	input: IssueCreateInput,
	runner: GhRunner = runGh,
	pendingDir: string = defaultPendingDir("misc"),
): IssueCreateOutcome {
	const argv = buildIssueArgv({
		title: input.draft.title,
		labels: input.labels,
		targetRepo: input.targetRepo,
	});
	const r = runner(argv, input.draft.body, input.cwd);

	if (r.status === 0) {
		const url = parseIssueUrl(r.stdout);
		if (!url) {
			const pendingPath = writePendingReport(
				input.draft,
				input.host,
				pendingDir,
			);
			return {
				ok: false,
				reason: "no-url-in-output",
				detail: `gh succeeded but no issue URL on stdout:\n${r.stdout.slice(0, 300)}`,
				pendingPath,
			};
		}
		return { ok: true, url };
	}

	if (input.labels.length > 0 && isUnknownLabelError(r.stderr)) {
		const retryArgv = buildIssueArgv({
			title: input.draft.title,
			labels: [],
			targetRepo: input.targetRepo,
		});
		const retry = runner(retryArgv, input.draft.body, input.cwd);
		if (retry.status === 0) {
			const url = parseIssueUrl(retry.stdout);
			if (url) {
				return {
					ok: false,
					reason: "labels-rejected",
					detail: `labels not found on repo (${input.labels.join(", ")}); filed issue without labels: ${url}`,
				};
			}
		}
	}

	if (r.status === null) {
		const pendingPath = writePendingReport(input.draft, input.host, pendingDir);
		return {
			ok: false,
			reason: "gh-missing",
			detail: `gh did not run: ${r.stderr || "unknown error"}`,
			pendingPath,
		};
	}

	if (isAuthError(r.stderr)) {
		const pendingPath = writePendingReport(input.draft, input.host, pendingDir);
		return {
			ok: false,
			reason: "auth",
			detail: `not logged in to ${input.host} — run \`gh auth login -h ${input.host}\``,
			pendingPath,
		};
	}

	const pendingPath = writePendingReport(input.draft, input.host, pendingDir);
	return {
		ok: false,
		reason: "gh-failed",
		detail: `gh issue create failed (exit ${r.status}): ${r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300) || "(no output)"}`,
		pendingPath,
	};
}
