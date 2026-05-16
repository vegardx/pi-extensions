/**
 * Git remote-origin parsing for cwd-origin issue filers (`/idea`).
 *
 * Pure helpers — no shell-out — so they're cheap to unit-test.
 * Use `readOriginUrl(cwd)` for the side-effecting bit.
 */

import { spawnSync } from "node:child_process";

export interface OriginInfo {
	/** Hostname extracted from the remote URL (e.g. `github.com`, `dnb.ghe.com`). */
	host: string;
	owner: string;
	repo: string;
	/** Convenience: `${host}/${owner}/${repo}`. */
	slug: string;
}

/**
 * Parse a git remote URL into host + owner + repo. Accepts both SSH
 * (`git@host:owner/repo.git`) and HTTPS (`https://host/owner/repo.git`)
 * forms, with or without the trailing `.git`.
 *
 * Returns `null` for anything that doesn't parse cleanly so callers
 * can short-circuit without try/catch noise.
 */
export function parseOriginUrl(raw: string): OriginInfo | null {
	const url = raw.trim();
	if (!url) return null;

	const sshMatch = url.match(
		/^(?:ssh:\/\/)?(?:[^@\s]+@)?([^:/\s]+)[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
	);
	const httpsMatch = url.match(
		/^https?:\/\/(?:[^@/\s]+@)?([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
	);

	const m = httpsMatch ?? sshMatch;
	if (!m) return null;
	const [, host, owner, repo] = m;
	if (!host || !owner || !repo) return null;
	if (host.includes(":") || host.includes("/")) return null;
	return { host, owner, repo, slug: `${host}/${owner}/${repo}` };
}

/**
 * Read `remote.origin.url` for the repo containing `cwd`. Returns
 * `null` when:
 *   - `git` isn't installed
 *   - cwd isn't inside a git repo
 *   - the repo has no `origin` remote
 *
 * Test seam: `runner` defaults to `spawnSync`; tests inject a stub.
 */
export type GitRunner = (
	argv: readonly string[],
	cwd: string,
) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: GitRunner = (argv, cwd) => {
	const r = spawnSync("git", argv as string[], {
		cwd,
		encoding: "utf8",
		shell: false,
		env: process.env,
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

export function readOriginUrl(
	cwd: string,
	runner: GitRunner = defaultRunner,
): string | null {
	const r = runner(["config", "--get", "remote.origin.url"], cwd);
	if (r.status !== 0) return null;
	const url = r.stdout.trim();
	return url || null;
}

/**
 * Convenience: read + parse in one call. Returns `null` when either
 * step fails.
 */
export function readOrigin(
	cwd: string,
	runner: GitRunner = defaultRunner,
): OriginInfo | null {
	const url = readOriginUrl(cwd, runner);
	if (!url) return null;
	return parseOriginUrl(url);
}
