/**
 * Context gathering for /wrap-up.
 *
 * Everything here is synchronous and side-effect-free from the caller's
 * perspective: it reads the filesystem and spawns short-lived git/gh
 * processes, but never writes anything or mutates pi state.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shell helper
// ---------------------------------------------------------------------------

function runCmd(cmd: string, args: readonly string[], cwd: string): string {
	const r = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		shell: false,
		env: process.env,
	});
	return (r.stdout ?? "").trim();
}

// ---------------------------------------------------------------------------
// Resource-signal detection
// ---------------------------------------------------------------------------

/**
 * A detected resource signal: a human-readable label and the relative path
 * that triggered it (for display in the prompt).
 */
export interface ResourceSignal {
	label: string;
	path: string;
}

/**
 * Check the project root for files/directories that indicate cost-incurring
 * cloud or infrastructure resources. Returns de-duplicated signals.
 *
 * Intentionally shallow — we only check well-known top-level paths so the
 * scan is instant and produces no false positives from nested dependencies.
 */
export function detectResources(cwd: string): ResourceSignal[] {
	const found: ResourceSignal[] = [];

	const check = (rel: string, label: string) => {
		if (existsSync(join(cwd, rel))) {
			found.push({ label, path: rel });
		}
	};

	// Infrastructure-as-code
	check("main.tf", "Terraform");
	check("terraform.tf", "Terraform");
	check("terraform", "Terraform");
	check("infra/main.tf", "Terraform");
	check("cdk.json", "AWS CDK");
	check("pulumi.yaml", "Pulumi");
	check("pulumi.yml", "Pulumi");

	// Containers
	check("Dockerfile", "Docker");
	check("docker-compose.yml", "Docker Compose");
	check("docker-compose.yaml", "Docker Compose");
	check("compose.yml", "Docker Compose");
	check("compose.yaml", "Docker Compose");

	// CI/CD & hosting
	check(".github/workflows", "GitHub Actions");
	check("fly.toml", "Fly.io");
	check(".fly", "Fly.io");
	check("vercel.json", "Vercel");
	check(".vercel", "Vercel");
	check("netlify.toml", "Netlify");
	check("railway.toml", "Railway");
	check("render.yaml", "Render");

	// Kubernetes
	check("k8s", "Kubernetes");
	check("kubernetes", "Kubernetes");
	check("helm", "Helm/Kubernetes");
	check("Chart.yaml", "Helm/Kubernetes");

	// De-duplicate by label (keep first match per label)
	const seen = new Set<string>();
	return found.filter((s) => {
		if (seen.has(s.label)) return false;
		seen.add(s.label);
		return true;
	});
}

// ---------------------------------------------------------------------------
// WrapUpContext
// ---------------------------------------------------------------------------

export interface WrapUpContext {
	/** Current git branch, or null if not a git repo / detached HEAD. */
	branch: string | null;
	/** `git log --oneline -15` output. */
	recentLog: string;
	/** `git status --short` output. */
	statusShort: string;
	/** `git diff --stat` (unstaged). */
	diffStat: string;
	/** `git diff --cached --stat` (staged). */
	stagedDiffStat: string;
	/** Upstream tracking branch, e.g. `origin/feat/foo`. Null if unset. */
	upstream: string | null;
	/** Remote origin URL (for deriving repo link). */
	remoteUrl: string | null;
	/** `gh pr view` JSON if gh is available and a PR exists for this branch. */
	prInfo: string | null;
	/** Cost-incurring resource signals found in the project. */
	resources: ResourceSignal[];
	/** ISO date string at time of gathering, e.g. "2026-05-06". */
	date: string;
}

/**
 * Gather all context needed for the wrap-up prompt. Synchronous.
 * Never throws — missing git/gh binaries produce null/empty fields.
 */
export function gatherContext(cwd: string): WrapUpContext {
	const git = (args: readonly string[]) => runCmd("git", args, cwd);

	const rawBranch = git(["branch", "--show-current"]);
	const branch = rawBranch.length > 0 ? rawBranch : null;

	const rawUpstream = git([
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{u}",
	]);
	const upstream =
		rawUpstream.length > 0 && !rawUpstream.startsWith("fatal")
			? rawUpstream
			: null;

	const rawRemote = git(["remote", "get-url", "origin"]);
	const remoteUrl =
		rawRemote.length > 0 && !rawRemote.startsWith("fatal") ? rawRemote : null;

	// gh pr view — best-effort, silent on failure
	let prInfo: string | null = null;
	if (branch) {
		const ghResult = spawnSync(
			"gh",
			["pr", "view", "--json", "number,title,url,state,isDraft"],
			{ cwd, encoding: "utf8", shell: false, env: process.env },
		);
		const out = (ghResult.stdout ?? "").trim();
		if (ghResult.status === 0 && out.length > 0) {
			prInfo = out;
		}
	}

	return {
		branch,
		recentLog: git(["log", "--oneline", "-15"]),
		statusShort: git(["status", "--short"]),
		diffStat: git(["diff", "--stat"]),
		stagedDiffStat: git(["diff", "--cached", "--stat"]),
		upstream,
		remoteUrl,
		prInfo,
		resources: detectResources(cwd),
		date: new Date().toISOString().slice(0, 10),
	};
}
