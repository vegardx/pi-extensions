/**
 * Pure /commit run — used by both `/commit`'s command handler and
 * `modes`' post-loop picker. The picker bypasses slash-command
 * dispatch (`pi.sendUserMessage("/cmd")` is hard-coded to skip slash
 * expansion in pi-coding-agent ≤ 0.73.0; see badlogic/pi-mono#2549/
 * #2994/#3673) and calls `runCommit(...)` directly.
 *
 * `ExtensionCommandContext.waitForIdle()` is unavailable when
 * `modes` invokes us from an `agent_end` handler, so this module
 * implements a local listener-based equivalent built on
 * `pi.on("agent_end")` + `ctx.isIdle()`. It works for the
 * command-handler caller too, so we use it uniformly.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createPr, editPr, findOpenPr, type PrMetadata, viewPr } from "./gh.js";
import {
	runCommand as _runCommand,
	addRemoteIdempotent,
	checkoutAndPull,
	currentBranch,
	detectDefaultBranch,
	fetchRef,
	gitStatusPorcelain,
	hasAnyChanges,
	headSha,
	isAncestor,
	isGitRepo,
	mergeBase,
	originUrl,
	pushRefspec,
	readTrackingIssue,
	rebaseOnto,
	refExists,
	treesIdentical,
	writeTrackingIssue,
} from "./git.js";
import {
	buildForkUrl,
	isSafeBranchName,
	isValidIssueNumber,
	parseTitleAndBody,
	summarisePlan,
} from "./helpers.js";

export const EXT_ID = "commit";

// ---- Local waitForIdle (decoupled from ExtensionCommandContext) --------
//
// We need to wait for the agent to finish a turn we just kicked off via
// `pi.sendMessage(..., { triggerTurn: true })`. `ExtensionCommandContext`
// offers `waitForIdle()` for this, but `modes`' post-loop picker
// runs from a plain `ExtensionContext` (no `waitForIdle`) inside its
// `runDetached` microtask. To stay agnostic we install a single
// `agent_end` listener on first call and queue resolvers behind it.
//
// Process-global state — only one listener is registered per `pi`.

const installedFor = new WeakSet<object>();
const idleResolvers = new WeakMap<object, Array<() => void>>();

function ensureIdleListener(pi: ExtensionAPI): void {
	if (installedFor.has(pi)) return;
	installedFor.add(pi);
	idleResolvers.set(pi, []);
	pi.on("agent_end", () => {
		// Wait one microtask so any post-agent_end state propagation
		// settles before we treat the session as idle.
		queueMicrotask(() => {
			const list = idleResolvers.get(pi) ?? [];
			idleResolvers.set(pi, []);
			for (const r of list) r();
		});
	});
}

function waitForIdle(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	ensureIdleListener(pi);
	if (ctx.isIdle()) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const list = idleResolvers.get(pi);
		if (!list) {
			// Defensive: ensureIdleListener just initialised this — should
			// always be present. Fall back to immediate resolve so we don't
			// hang forever in the impossible case.
			resolve();
			return;
		}
		list.push(resolve);
	});
}

// ---- Prompt builders ---------------------------------------------------

function agentMsg(content: string) {
	return {
		customType: EXT_ID,
		content,
		display: false as const,
		details: {},
	};
}

/**
 * Exported for unit tests. Internal API; the public surface is
 * `runCommit`.
 */
export function buildPlanPrompt(
	guidance: string | undefined,
	diffSummary: string,
	mode?: string,
): string {
	const finishLine =
		mode === "auto"
			? "Yield back to the extension; it will confirm the plan and sequence /ship and the next phase."
			: "Finish the turn after writing the plan.";
	return [
		"You are in the `/commit` flow. Analyze the current working tree and",
		"propose a commit plan. Read `skills/gh/SKILL.md` if you need any",
		"GitHub conventions; otherwise just look at the diff.",
		"",
		"Gather context yourself — the diff is NOT included here so you can",
		"use read-only bash freely:",
		"",
		"```bash",
		"git status --short",
		"git diff --stat",
		"git diff",
		"git diff --cached",
		"```",
		"",
		diffSummary,
		"",
		"Produce a plan with either:",
		"",
		"- **One commit** when all changes serve the same purpose. Conventional",
		"  commit format: `type(scope): short subject`. Subject ≤ 72 chars.",
		"  Include a body only when the change needs explanation.",
		"- **Multiple commits** when changes span unrelated concerns. Order them",
		"  meaningfully. For each: which files go in, the commit message, and",
		"  the staging commands (`git add <explicit paths>` — never `git add -A`",
		"  or `git add .` because that would stage everything, including .env).",
		"",
		"Valid types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`,",
		"`style`, `perf`, `ci`, `build`.",
		"",
		guidance
			? `User guidance: ${guidance} (use as the starting point, adjust for conventional format if needed).`
			: "The user didn't provide guidance — derive everything from the diff.",
		"",
		"Output the plan as readable markdown. Do NOT commit anything yet —",
		"the extension will ask for explicit confirmation before anything is",
		`staged or committed. ${finishLine}`,
	].join("\n");
}

/**
 * Exported for unit tests. Internal API; the public surface is
 * `runCommit`.
 */
export function buildExecutePrompt(
	overrideInstructions: string | null,
	mode?: string,
): string {
	const afterCommitLine =
		mode === "auto"
			? "Yield back to the extension; it will sequence /ship and the next phase."
			: "Stop after the last commit — do not push.";
	if (overrideInstructions) {
		return [
			"User edited the commit plan. Execute the plan below exactly as",
			"written — run `git add <explicit paths>` and `git commit -m '...'`",
			"for each commit in order. Do not make additional commits beyond",
			"what's specified.",
			"",
			"---",
			"",
			overrideInstructions,
		].join("\n");
	}
	return [
		"Execute the commit plan you just proposed. For each commit in order:",
		"",
		"1. `git add <explicit paths>` (never `git add -A`, `git add -u`, or",
		"   `git add .` — they can stage .env and other excluded files).",
		"2. `git commit -m '<subject>'` with the conventional-commit message",
		"   from your plan. Multi-line bodies: pass additional `-m` args or",
		"   write the message to a temp file and use `-F`.",
		"",
		"After every commit, run `git log -1 --oneline` so the user can",
		`verify. ${afterCommitLine}`,
	].join("\n");
}

function buildPrPrompt(
	branch: string,
	trackingIssue: string | null,
	existing: PrMetadata | null,
): string {
	const parts = [
		"Write the pull-request title and body for this branch. Gather the",
		"context yourself:",
		"",
		"```bash",
		`git log --reverse --no-merges origin/${"$default"}..HEAD --format='%s%n%b%n---'`,
		"git diff --stat origin/" + "$default" + "..HEAD",
		"```",
		"",
		"Replace `$default` with the default branch name (usually `main` or",
		"`master`; check `git symbolic-ref refs/remotes/origin/HEAD`).",
		"",
		"## PR writing rules",
		"",
		"- Describe what the diff does now — not alternatives, prior",
		"  iterations, or discarded approaches.",
		"- Plain factual language. No filler words like *critical*, *crucial*,",
		"  *essential*, *significant*, *comprehensive*, *robust*, *elegant*.",
		"- Title follows conventional-commit style matching the commit(s).",
		"- Body: brief summary paragraph, then optional bullet list of",
		"  concrete changes. Keep it short.",
	];
	if (trackingIssue) {
		parts.push(
			"",
			`- **Tracking issue**: this branch has \`branch.${branch}.tracking-issue\` set`,
			`  to #${trackingIssue}. End the body with \`Closes #${trackingIssue}\` on its`,
			"  own line so GitHub auto-closes the issue when the PR merges.",
		);
	}
	if (existing) {
		parts.push(
			"",
			`**Existing PR**: #${existing.number} — "${existing.title}".`,
			"Regenerate the title and body from scratch based on the current",
			"commits on the branch; the user will decide whether to overwrite",
			"the existing metadata.",
		);
	}
	parts.push(
		"",
		"## Output format",
		"",
		"Wrap your output in these exact sentinels so the extension can",
		"parse it. No other content between them:",
		"",
		"```",
		"---TITLE---",
		"short one-line title",
		"---BODY---",
		"multi-line markdown body",
		"---END---",
		"```",
		"",
		"Free-form commentary around the sentinels is fine; the extension",
		"only reads what's between them. Finish the turn after emitting them.",
	);
	return parts.join("\n");
}

// ---- Helpers -----------------------------------------------------------

function lastAssistantText(ctx: ExtensionContext): string | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type !== "message") continue;
		const msg = (e as { message?: { role?: string; content?: unknown } })
			.message;
		if (msg?.role !== "assistant") continue;
		const content = msg.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const block of content) {
				if (
					block &&
					typeof block === "object" &&
					(block as { type?: string }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string"
				) {
					parts.push((block as { text: string }).text);
				}
			}
			if (parts.length > 0) return parts.join("\n\n");
		}
	}
	return null;
}

function notify(
	ctx: ExtensionContext,
	msg: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(`commit: ${msg}`, level);
}

function runCommandInline(cwd: string, cmd: string, args: readonly string[]) {
	return _runCommand(cmd, args, { cwd });
}

// ---- Push routing ------------------------------------------------------

interface PushTarget {
	target: string;
	targetBranch: string;
}

async function resolvePushTarget(
	ctx: ExtensionContext,
	branch: string,
	nonInteractive = false,
): Promise<PushTarget | null> {
	const prResult = findOpenPr(ctx.cwd, branch);
	const pr = prResult.pr;
	if (!pr?.isCrossRepository) {
		return { target: "origin", targetBranch: branch };
	}

	if (!pr.maintainerCanModify) {
		if (nonInteractive) {
			notify(
				ctx,
				`PR #${pr.number} is cross-repo with maintainerCanModify=false — refusing non-interactive push (would need to format-patch or abort)`,
				"error",
			);
			return null;
		}
		const choice = await ctx.ui.select(
			`PR #${pr.number} is cross-repo and maintainerCanModify is false`,
			["Output patch series (Recommended)", "Abort — keep commits local"],
		);
		if (!choice || choice.startsWith("Abort")) {
			notify(ctx, "aborted — commits stay local", "info");
			return null;
		}
		const defaultBranch = detectDefaultBranch(ctx.cwd) ?? pr.baseRefName;
		const base =
			mergeBase(ctx.cwd, `origin/${defaultBranch}`, "HEAD") ??
			`origin/${defaultBranch}`;
		const r = runCommandInline(ctx.cwd, "git", [
			"format-patch",
			`${base}..HEAD`,
		]);
		if (r.ok) {
			notify(
				ctx,
				`patches written: ${r.stdout.trim().split("\n").join(", ")} — share with the PR author`,
				"info",
			);
		} else {
			notify(ctx, `git format-patch failed: ${r.stderr.trim()}`, "warning");
		}
		return null;
	}

	const origin = originUrl(ctx.cwd);
	if (!origin) {
		notify(ctx, "no origin remote — can't derive fork URL", "error");
		return null;
	}
	const forkUrl = buildForkUrl(origin, pr.headRepositoryNameWithOwner);
	if (!forkUrl) {
		notify(
			ctx,
			`couldn't derive fork URL from origin "${origin}" — ask the user to add it manually`,
			"error",
		);
		return null;
	}
	const forkRemote = pr.headRepositoryOwnerLogin;
	addRemoteIdempotent(ctx.cwd, forkRemote, forkUrl);
	const fetched = fetchRef(ctx.cwd, forkRemote, pr.headRefName);
	if (!fetched.ok) {
		notify(
			ctx,
			`git fetch ${forkRemote} ${pr.headRefName} failed: ${fetched.stderr.trim()}`,
			"error",
		);
		return null;
	}
	notify(
		ctx,
		`routing push to fork: ${forkRemote} → ${pr.headRefName}`,
		"info",
	);
	return { target: forkRemote, targetBranch: pr.headRefName };
}

async function doPush(
	ctx: ExtensionContext,
	target: PushTarget,
	nonInteractive = false,
): Promise<boolean> {
	const remoteRef = `${target.target}/${target.targetBranch}`;

	const doStandardPush = () =>
		tryPush(ctx, target, { errorLabel: "git push failed" });

	if (!refExists(ctx.cwd, remoteRef)) {
		return doStandardPush();
	}
	if (isAncestor(ctx.cwd, remoteRef)) {
		return doStandardPush();
	}

	const our = mergeBase(ctx.cwd, remoteRef, "HEAD");
	if (our && treesIdentical(ctx.cwd, our, remoteRef)) {
		const rb = rebaseOnto(ctx.cwd, remoteRef, our);
		if (!rb.ok) {
			notify(ctx, `rebase --onto failed: ${rb.stderr.trim()}`, "error");
			return false;
		}
		notify(ctx, "rebased onto remote (trees matched)", "info");
		return doStandardPush();
	}

	if (nonInteractive) {
		notify(
			ctx,
			`remote ${remoteRef} has commits we don't have — refusing non-interactive push (rebase / force-push need a human)`,
			"error",
		);
		return false;
	}

	const choice = await ctx.ui.select(
		`Remote ${remoteRef} has commits we don't have. Rebase may conflict.`,
		[
			"Rebase onto remote (Recommended)",
			"Force-push (overwrite remote — destructive)",
			"Abort",
		],
	);
	if (!choice || choice.startsWith("Abort")) {
		notify(ctx, "aborted — commits stay local", "info");
		return false;
	}
	if (choice.startsWith("Rebase")) {
		const r = runCommandInline(ctx.cwd, "git", ["rebase", remoteRef]);
		if (!r.ok) {
			notify(
				ctx,
				`rebase conflicts — resolve manually, then re-run /commit. git status: ${r.stderr.trim()}`,
				"error",
			);
			return false;
		}
		return tryPush(ctx, target, {
			errorLabel: "git push after rebase failed",
		});
	}
	const confirm = await ctx.ui.confirm(
		"Confirm force-push",
		`This will overwrite ${remoteRef} with your local commits. Destructive. Continue?`,
	);
	if (!confirm) {
		notify(ctx, "aborted", "info");
		return false;
	}
	return tryPush(ctx, target, {
		force: true,
		errorLabel: "force-push failed",
	});
}

function tryPush(
	ctx: ExtensionContext,
	target: PushTarget,
	opts: { force?: boolean; errorLabel: string },
): boolean {
	const r = pushRefspec(
		ctx.cwd,
		target.target,
		`HEAD:${target.targetBranch}`,
		opts.force ?? false,
	);
	if (!r.ok) {
		notify(ctx, `${opts.errorLabel}: ${r.stderr.trim()}`, "error");
		return false;
	}
	return true;
}

// ---- Public entry point -------------------------------------------------

export interface RunCommitOptions {
	ctx: ExtensionCommandContext | ExtensionContext;
	pi: ExtensionAPI;
	/** Free-form guidance (typically the slash-command argument). */
	guidance?: string;
	/**
	 * Skip the "Run /review before committing?" picker (Step 2 of the
	 * workflow). Set by callers that just ran /review themselves —
	 * e.g. /review's chainToCommit — so the user isn't asked again.
	 * Defaults to false.
	 */
	skipReviewOffer?: boolean;
	/**
	 * Run the full commit pipeline without prompting the user. Used by
	 * the modes auto-loop, which drives commit→ship→next-phase without
	 * user input. Behaviour:
	 *
	 *   - Skip /review.
	 *   - Refuse to commit on the default branch (no safe default).
	 *   - Execute the agent-generated commit plan as-is (no edit step).
	 *   - Push the branch (`-u origin` on fresh branches), then return.
	 *   - Do NOT open or update a PR (that's /ship's job).
	 *   - Do NOT prompt for tracking-issue linkage.
	 *   - Bail on cross-repo PRs and on diverged-remote situations
	 *     rather than guessing (rebase / force-push are interactive
	 *     decisions).
	 *
	 * Throws if any `ctx.ui.*` would otherwise be invoked. Defaults
	 * to false.
	 */
	nonInteractive?: boolean;
	/**
	 * Current pi mode (`"auto"` | `"ask"` | `"hack"` | `"plan"`).
	 * When `"auto"`, prompt wording instructs the agent to yield back to
	 * the extension after committing rather than stopping and waiting for
	 * user input — the extension sequences /ship and the next phase.
	 * Defaults to `"hack"` (interactive, no pipeline).
	 */
	mode?: string;
}

export interface RunCommitResult {
	ran: boolean;
	abortReason?:
		| "not-git"
		| "clean-tree"
		| "no-branch"
		| "unsafe-branch"
		| "user-cancelled"
		| "deferred-to-review"
		| "no-commits"
		| "agent-no-pr-output";
}

export async function runCommit(
	opts: RunCommitOptions,
): Promise<RunCommitResult> {
	const { ctx, pi } = opts;
	const nonInteractive = opts.nonInteractive === true;
	const mode = opts.mode;
	const guidance = (opts.guidance ?? "").trim();
	const idle = () => waitForIdle(pi, ctx);

	// ---- Step 1: preflight --------------------------------------
	if (!isGitRepo(ctx.cwd)) {
		notify(ctx, "not inside a git repository", "error");
		return { ran: false, abortReason: "not-git" };
	}
	if (!hasAnyChanges(ctx.cwd)) {
		notify(
			ctx,
			"no changes to commit (working tree + index are clean)",
			"info",
		);
		return { ran: false, abortReason: "clean-tree" };
	}
	const branch = currentBranch(ctx.cwd);
	if (!branch) {
		notify(ctx, "could not resolve current branch (detached HEAD?)", "error");
		return { ran: false, abortReason: "no-branch" };
	}
	if (!isSafeBranchName(branch)) {
		notify(
			ctx,
			`branch name "${branch}" contains unexpected characters — bailing`,
			"error",
		);
		return { ran: false, abortReason: "unsafe-branch" };
	}

	if (!ctx.hasUI && !nonInteractive) {
		notify(
			ctx,
			"/commit needs an interactive UI; run pi attached to a terminal",
			"error",
		);
		return { ran: false, abortReason: "user-cancelled" };
	}

	const defaultBranch = detectDefaultBranch(ctx.cwd);
	if (branch === defaultBranch) {
		if (nonInteractive) {
			notify(
				ctx,
				`refusing non-interactive commit on default branch \`${branch}\` — branch first`,
				"error",
			);
			return { ran: false, abortReason: "unsafe-branch" };
		}
		const proceed = await ctx.ui.confirm(
			"Commit directly on the default branch?",
			`You're on \`${branch}\`, which is the default. Usually you'd branch first. ` +
				"Proceed anyway?",
		);
		if (!proceed) {
			notify(
				ctx,
				"aborted — create a feature branch first (`/plan <desc>`).",
				"warning",
			);
			return { ran: false, abortReason: "user-cancelled" };
		}
	}

	// ---- Step 2: offer /review first ----------------------------
	if (opts.skipReviewOffer || nonInteractive) {
		if (!nonInteractive) notify(ctx, "skipping /review (just ran)", "info");
	} else {
		const reviewChoice = await ctx.ui.select("Run /review before committing?", [
			"Run /review first (Recommended)",
			"Skip — commit now",
		]);
		if (!reviewChoice) {
			notify(ctx, "aborted", "info");
			return { ran: false, abortReason: "user-cancelled" };
		}
		if (reviewChoice.startsWith("Run")) {
			// Run /review in-process by dynamic-importing its core module.
			// We don't dispatch a slash command — `pi.sendUserMessage("/cmd")`
			// is hard-coded to skip slash expansion in pi-coding-agent
			// ≤ 0.73.0 (see badlogic/pi-mono#2549/#2994/#3673), so a dispatch
			// would deliver `/review` as literal user text and the registered
			// handler would never run. Gate only on the extension command —
			// the standalone /skill:review path is a different UX (manual
			// invocation) and dispatching to it from here would be surprising.
			const hasReview = pi.getCommands().some((c) => c.name === "review");
			if (!hasReview) {
				notify(
					ctx,
					`/review extension not installed (install vegardx/pi-extensions to enable it). Skipping review; continuing to commit${
						guidance ? ` ${guidance}` : ""
					}`,
					"warning",
				);
			} else {
				notify(ctx, "running /review before committing…", "info");
				try {
					const mod = await import("pi-ext-review/core");
					await mod.runReview({ ctx, pi, arg: "" });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					notify(ctx, `review failed: ${msg}; continuing to commit`, "warning");
				}
			}
			// Fall through into the commit-plan step. Note: `runReview` may
			// have queued a fix-prompt to the agent and (when the post-review
			// /commit offer landed) registered its own follow-up listener.
			// Continuing here is still fine: we'll send our own commit-plan
			// prompt below, await idle until the agent finishes whichever
			// turn fires first, and proceed.
		}
	}

	// ---- Step 3: ask agent for a commit plan --------------------
	const statusSnapshot = gitStatusPorcelain(ctx.cwd).trim();
	const summary = statusSnapshot
		? `Working tree snapshot at /commit time:\n\n\`\`\`\n${statusSnapshot}\n\`\`\``
		: "(Working tree was clean at snapshot time — unexpected; investigate.)";

	pi.sendMessage(
		agentMsg(buildPlanPrompt(guidance || undefined, summary, mode)),
		{
			deliverAs: "followUp",
			triggerTurn: true,
		},
	);
	notify(ctx, "asking the agent for a commit plan…", "info");
	await idle();

	// ---- Step 4: execute / edit / cancel ------------------------
	const planText = lastAssistantText(ctx) ?? "";
	const planSummary = summarisePlan(planText);
	let override: string | null = null;
	if (!nonInteractive) {
		const executeChoice = await ctx.ui.select(
			`commit plan ready: ${planSummary}`,
			["Commit (Recommended)", "Edit plan before committing", "Cancel"],
		);
		if (!executeChoice || executeChoice.startsWith("Cancel")) {
			notify(ctx, "aborted — nothing committed", "info");
			return { ran: false, abortReason: "user-cancelled" };
		}
		if (executeChoice.startsWith("Edit")) {
			const edited = await ctx.ui.editor(
				"Revise the commit plan (the agent will execute this verbatim):",
				planText,
			);
			if (!edited || edited.trim().length === 0) {
				notify(ctx, "aborted — empty plan", "warning");
				return { ran: false, abortReason: "user-cancelled" };
			}
			override = edited.trim();
		}
	} else {
		notify(ctx, `commit plan: ${planSummary}`, "info");
	}

	// ---- Step 5: execute commits -------------------------------
	const headBefore = headSha(ctx.cwd);
	pi.sendMessage(agentMsg(buildExecutePrompt(override, mode)), {
		deliverAs: "followUp",
		triggerTurn: true,
	});
	notify(ctx, "asking the agent to execute the commit plan…", "info");
	await idle();

	const headAfter = headSha(ctx.cwd);
	if (!headAfter || headBefore === headAfter) {
		notify(ctx, "no commits were made — aborting push/PR steps", "warning");
		return { ran: false, abortReason: "no-commits" };
	}
	notify(
		ctx,
		`HEAD advanced: ${headBefore?.slice(0, 8)} → ${headAfter.slice(0, 8)}`,
		"info",
	);

	// ---- Step 6: push + PR --------------------------------------
	// In non-interactive mode we always push, never manage the PR
	// (that's /ship's job). The auto-loop relies on this: commit
	// here, then /ship pushes again (idempotent fast-forward) and
	// opens the PR.
	let pushChoice: string | null;
	if (nonInteractive) {
		pushChoice = "Push only";
	} else {
		pushChoice =
			(await ctx.ui.select("Push and manage PR?", [
				"Push and manage PR (Recommended)",
				"Push only",
				"Don't push — keep commits local",
			])) ?? null;
	}
	if (!pushChoice || pushChoice.startsWith("Don't")) {
		notify(ctx, "commits stay local", "info");
		return { ran: true };
	}

	const pushTarget = await resolvePushTarget(ctx, branch, nonInteractive);
	if (!pushTarget) return { ran: true };

	const pushed = await doPush(ctx, pushTarget, nonInteractive);
	if (!pushed) return { ran: true };

	if (pushChoice.startsWith("Push only")) {
		notify(
			ctx,
			`pushed ${branch} → ${pushTarget.target}/${pushTarget.targetBranch}`,
			"info",
		);
		return { ran: true };
	}

	// ---- Step 7: tracking issue + PR create/update -------------
	let trackingIssue = readTrackingIssue(ctx.cwd, branch);
	if (!trackingIssue) {
		const addIssue = await ctx.ui.select(
			`No tracking issue linked to ${branch}`,
			["Skip (Recommended)", "Link to an issue number"],
		);
		if (addIssue?.startsWith("Link")) {
			const raw = await ctx.ui.input(
				"Issue number (digits only, optional '#' prefix):",
				"",
			);
			if (raw) {
				const cleaned = raw.trim().replace(/^#/, "");
				if (isValidIssueNumber(cleaned)) {
					const w = writeTrackingIssue(ctx.cwd, branch, cleaned);
					if (w.ok) {
						trackingIssue = cleaned;
						notify(ctx, `linked ${branch} to issue #${cleaned}`, "info");
					} else {
						notify(
							ctx,
							`could not persist tracking issue: ${w.stderr.trim()}`,
							"warning",
						);
					}
				} else {
					notify(
						ctx,
						`"${raw}" doesn't look like an issue number — skipping`,
						"warning",
					);
				}
			}
		}
	}

	const existingPrResult = findOpenPr(ctx.cwd, pushTarget.targetBranch);
	if (existingPrResult.error) {
		notify(
			ctx,
			`gh pr list warning: ${existingPrResult.error.split("\n")[0]}`,
			"warning",
		);
	}
	const existingPr = existingPrResult.pr;

	pi.sendMessage(agentMsg(buildPrPrompt(branch, trackingIssue, existingPr)), {
		deliverAs: "followUp",
		triggerTurn: true,
	});
	notify(ctx, "asking the agent for the PR title and body…", "info");
	await idle();

	const prReply = lastAssistantText(ctx) ?? "";
	const parsed = parseTitleAndBody(prReply);
	if (!parsed) {
		notify(
			ctx,
			"agent did not emit TITLE/BODY sentinels — skipping PR step. Create the PR manually.",
			"warning",
		);
		return { ran: true, abortReason: "agent-no-pr-output" };
	}

	const action = existingPr ? "Update" : "Create";
	const previewChoice = await ctx.ui.select(
		`${action} PR: "${parsed.title.slice(0, 70)}"`,
		[
			`${action} PR (Recommended)`,
			"Edit title and/or body first",
			"Skip — don't touch the PR",
		],
	);
	if (!previewChoice || previewChoice.startsWith("Skip")) {
		notify(ctx, "PR not modified", "info");
		return { ran: true };
	}

	let finalTitle = parsed.title;
	let finalBody = parsed.body;
	if (previewChoice.startsWith("Edit")) {
		const t = await ctx.ui.input("PR title:", parsed.title);
		if (t !== undefined) finalTitle = t;
		const b = await ctx.ui.editor("PR body:", parsed.body);
		if (b !== undefined) finalBody = b;
	}

	if (existingPr) {
		const r = editPr(ctx.cwd, existingPr.number, finalTitle, finalBody);
		if (!r.ok) {
			notify(ctx, `gh pr edit failed: ${r.stderr.trim()}`, "error");
			return { ran: true };
		}
		const refreshed = viewPr(ctx.cwd, existingPr.number);
		notify(
			ctx,
			`updated PR #${existingPr.number}${refreshed.pr ? ` — ${refreshed.pr.title}` : ""}`,
			"info",
		);
	} else {
		const created = createPr(ctx.cwd, finalTitle, finalBody);
		if (!created.url) {
			notify(
				ctx,
				`gh pr create failed: ${created.error ?? "unknown error"}`,
				"error",
			);
			return { ran: true };
		}
		notify(ctx, `created PR: ${created.url}`, "info");
	}

	// ---- Step 8: offer return-to-default -----------------------
	const returnChoice = await ctx.ui.select(
		`Return to ${defaultBranch ?? "default"}?`,
		[
			"Stay on this branch (Recommended)",
			`Checkout + pull ${defaultBranch ?? "default"}`,
		],
	);
	if (returnChoice?.startsWith("Checkout") && defaultBranch) {
		const r = checkoutAndPull(ctx.cwd, defaultBranch);
		if (r.ok) {
			notify(ctx, `on ${defaultBranch}, up to date`, "info");
		} else {
			notify(ctx, r.message, "warning");
		}
	}

	return { ran: true };
}
