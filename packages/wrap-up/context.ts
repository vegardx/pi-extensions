/**
 * Context gathering for /wrap-up.
 *
 * Everything here is synchronous and side-effect-free from the caller's
 * perspective: it reads the filesystem and spawns short-lived git/gh
 * processes, but never writes anything or mutates pi state.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

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
	/** The working directory of the session (project root). */
	sessionCwd: string;
	/** ISO date string at time of gathering, e.g. "2026-05-06". */
	date: string;
	/** pi session ID (always present). */
	sessionId: string;
	/** Absolute path to the session file, or null for ephemeral sessions. */
	sessionFile: string | null;
	/** Session name set via pi.setSessionName(), or null. */
	sessionName: string | null;
}

// ---------------------------------------------------------------------------
// Handover config
// ---------------------------------------------------------------------------

/**
 * Resolved configuration for where and how to write the handover file.
 * Built from `extensionConfig.wrap-up` settings before the agent turn fires.
 */
export interface HandoverConfig {
	/** Absolute directory path where handover files are written. */
	dir: string;
	/** Filename only, e.g. `handover-2026-05-06-abc12345.md`. */
	filename: string;
	/** Full absolute path = `dir/filename`. */
	fullPath: string;
	/** When true the agent writes the file immediately without asking. */
	autoSave: boolean;
}

/**
 * Default handover directory: `<agentDir>/handovers/`.
 * Anchored on `getAgentDir()` (honours PI_CODING_AGENT_DIR / XDG) so it
 * lands alongside the rest of pi's agent data instead of a hardcoded ~/.pi.
 */
export const DEFAULT_HANDOVER_DIR = join(getAgentDir(), "handovers");

/**
 * Resolve the handover directory from a raw configured value.
 * Expands a leading `~` to `homedir()`. Falls back to `DEFAULT_HANDOVER_DIR`
 * when `configured` is empty or undefined.
 */
export function resolveHandoverDir(configured?: string): string {
	if (!configured || configured.trim().length === 0)
		return DEFAULT_HANDOVER_DIR;
	return configured.trim().replace(/^~(?=\/|$)/, homedir());
}

/**
 * Build the handover filename from context.
 * Format: `handover-<date>-<sessionId-8>.md`
 * The 8-char session-ID prefix makes filenames unique per session per day
 * without embedding the full (long) session UUID.
 */
export function buildHandoverFilename(ctx: WrapUpContext): string {
	const shortId = ctx.sessionId.slice(0, 8);
	return `handover-${ctx.date}-${shortId}.md`;
}

/**
 * Combine dir resolution and filename generation into a single
 * `HandoverConfig` ready for the prompt builder and index.ts.
 */
export function resolveHandoverConfig(
	ctx: WrapUpContext,
	opts: { configuredDir?: string; autoSave: boolean },
): HandoverConfig {
	const dir = resolveHandoverDir(opts.configuredDir);
	const filename = buildHandoverFilename(ctx);
	return {
		dir,
		filename,
		fullPath: join(dir, filename),
		autoSave: opts.autoSave,
	};
}

/**
 * Gather all context needed for the wrap-up prompt. Synchronous.
 * Never throws — missing git/gh binaries produce null/empty fields.
 */
export function gatherContext(
	cwd: string,
	opts: { sessionId: string; sessionFile?: string; sessionName?: string } = {
		sessionId: "unknown",
	},
): WrapUpContext {
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
		sessionCwd: cwd,
		date: new Date().toISOString().slice(0, 10),
		sessionId: opts.sessionId,
		sessionFile: opts.sessionFile ?? null,
		sessionName: opts.sessionName ?? null,
	};
}
