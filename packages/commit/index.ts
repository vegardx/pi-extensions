import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createPr, editPr, findOpenPr, type PrMetadata, viewPr } from "./gh.js";
import {
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

const EXT_ID = "commit";

/**
 * The "we just sent the agent a message asking it to X — wait for the
 * result" sentinel used as the `content` payload. We send messages with
 * `display: false` so they don't clutter the UI; only the agent's reply
 * is user-visible.
 */
function agentMsg(content: string) {
	return {
		customType: EXT_ID,
		content,
		display: false as const,
		details: {},
	};
}

function buildPlanPrompt(
	guidance: string | undefined,
	diffSummary: string,
): string {
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
		"staged or committed. Finish the turn after writing the plan.",
	].join("\n");
}

function buildExecutePrompt(overrideInstructions: string | null): string {
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
		"verify. Stop after the last commit — do not push.",
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

/**
 * Pull the most recent assistant text from the session. Used for
 * extracting the PR title/body after the agent finishes.
 */
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

export default function (pi: ExtensionAPI) {
	function notify(
		ctx: ExtensionContext,
		msg: string,
		level: "info" | "warning" | "error" = "info",
	): void {
		if (ctx.hasUI) ctx.ui.notify(`commit: ${msg}`, level);
	}

	pi.registerCommand(EXT_ID, {
		description:
			"Analyze changes, propose a conventional-commit plan, execute, and optionally push + open/update a PR. " +
			"Auto-appends `Closes #N` when the branch has a `tracking-issue` git config (set by `/develop`'s park path).",
		handler: async (args, ctx) => {
			const guidance = args?.trim() ?? "";

			// ---- Step 1: preflight --------------------------------------
			if (!isGitRepo(ctx.cwd)) {
				notify(ctx, "not inside a git repository", "error");
				return;
			}
			if (!hasAnyChanges(ctx.cwd)) {
				notify(
					ctx,
					"no changes to commit (working tree + index are clean)",
					"info",
				);
				return;
			}
			const branch = currentBranch(ctx.cwd);
			if (!branch) {
				notify(
					ctx,
					"could not resolve current branch (detached HEAD?)",
					"error",
				);
				return;
			}
			if (!isSafeBranchName(branch)) {
				// We interpolate the branch name into `git config` keys below —
				// reject anything with shell metacharacters just in case.
				notify(
					ctx,
					`branch name "${branch}" contains unexpected characters — bailing`,
					"error",
				);
				return;
			}

			const defaultBranch = detectDefaultBranch(ctx.cwd);
			if (branch === defaultBranch) {
				const proceed = await ctx.ui.confirm(
					"Commit directly on the default branch?",
					`You're on \`${branch}\`, which is the default. Usually you'd branch first. ` +
						"Proceed anyway?",
				);
				if (!proceed) {
					notify(
						ctx,
						"aborted — create a feature branch first (`/develop <desc>`).",
						"warning",
					);
					return;
				}
			}

			// ---- Step 2: offer /review first ----------------------------
			const reviewChoice = await ctx.ui.select(
				"Run /review before committing?",
				["Run /review first (Recommended)", "Skip — commit now"],
			);
			if (!reviewChoice) {
				notify(ctx, "aborted", "info");
				return;
			}
			if (reviewChoice.startsWith("Run")) {
				notify(
					ctx,
					`type /review, walk the findings, then re-invoke /commit${guidance ? ` ${guidance}` : ""}`,
					"info",
				);
				return;
			}

			// ---- Step 3: ask agent for a commit plan --------------------
			const statusSnapshot = gitStatusPorcelain(ctx.cwd).trim();
			const summary = statusSnapshot
				? `Working tree snapshot at /commit time:\n\n\`\`\`\n${statusSnapshot}\n\`\`\``
				: "(Working tree was clean at snapshot time — unexpected; investigate.)";

			pi.sendMessage(
				agentMsg(buildPlanPrompt(guidance || undefined, summary)),
				{
					deliverAs: "followUp",
					triggerTurn: true,
				},
			);
			notify(ctx, "asking the agent for a commit plan…", "info");
			await ctx.waitForIdle();

			// ---- Step 4: execute / edit / cancel ------------------------
			const planText = lastAssistantText(ctx) ?? "";
			const planSummary = summarisePlan(planText);
			const executeChoice = await ctx.ui.select(
				`commit plan ready: ${planSummary}`,
				["Commit (Recommended)", "Edit plan before committing", "Cancel"],
			);
			if (!executeChoice || executeChoice.startsWith("Cancel")) {
				notify(ctx, "aborted — nothing committed", "info");
				return;
			}
			let override: string | null = null;
			if (executeChoice.startsWith("Edit")) {
				const edited = await ctx.ui.editor(
					"Revise the commit plan (the agent will execute this verbatim):",
					planText,
				);
				if (!edited || edited.trim().length === 0) {
					notify(ctx, "aborted — empty plan", "warning");
					return;
				}
				override = edited.trim();
			}

			// ---- Step 5: execute commits -------------------------------
			const headBefore = headSha(ctx.cwd);
			pi.sendMessage(agentMsg(buildExecutePrompt(override)), {
				deliverAs: "followUp",
				triggerTurn: true,
			});
			notify(ctx, "asking the agent to execute the commit plan…", "info");
			await ctx.waitForIdle();

			const headAfter = headSha(ctx.cwd);
			if (!headAfter || headBefore === headAfter) {
				notify(ctx, "no commits were made — aborting push/PR steps", "warning");
				return;
			}
			notify(
				ctx,
				`HEAD advanced: ${headBefore?.slice(0, 8)} → ${headAfter.slice(0, 8)}`,
				"info",
			);

			// ---- Step 6: push + PR --------------------------------------
			const pushChoice = await ctx.ui.select("Push and manage PR?", [
				"Push and manage PR (Recommended)",
				"Push only",
				"Don't push — keep commits local",
			]);
			if (!pushChoice || pushChoice.startsWith("Don't")) {
				notify(ctx, "commits stay local", "info");
				return;
			}

			const pushTarget = await resolvePushTarget(ctx, branch);
			if (!pushTarget) return; // user aborted inside, message already emitted

			const pushed = await doPush(ctx, pushTarget);
			if (!pushed) return;

			if (pushChoice.startsWith("Push only")) {
				notify(
					ctx,
					`pushed ${branch} → ${pushTarget.target}/${pushTarget.targetBranch}`,
					"info",
				);
				return;
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

			// Ask the agent to write the title / body.
			pi.sendMessage(
				agentMsg(buildPrPrompt(branch, trackingIssue, existingPr)),
				{ deliverAs: "followUp", triggerTurn: true },
			);
			notify(ctx, "asking the agent for the PR title and body…", "info");
			await ctx.waitForIdle();

			const prReply = lastAssistantText(ctx) ?? "";
			const parsed = parseTitleAndBody(prReply);
			if (!parsed) {
				notify(
					ctx,
					"agent did not emit TITLE/BODY sentinels — skipping PR step. Create the PR manually.",
					"warning",
				);
				return;
			}

			// Present preview + picker.
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
				return;
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
					return;
				}
				// Refresh metadata for the follow-up notice.
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
					return;
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
		},
	});

	// ---- Push routing helpers -----------------------------------------

	interface PushTarget {
		target: string;
		targetBranch: string;
	}

	/**
	 * Resolve the right `git push <remote> <refspec>` target by checking
	 * whether the branch already has an open PR and whether that PR is
	 * cross-repo (fork-based). Returns null when the user aborts inside
	 * an interactive prompt (message already emitted).
	 */
	async function resolvePushTarget(
		ctx: ExtensionCommandContext,
		branch: string,
	): Promise<PushTarget | null> {
		const prResult = findOpenPr(ctx.cwd, branch);
		const pr = prResult.pr;
		if (!pr?.isCrossRepository) {
			return { target: "origin", targetBranch: branch };
		}

		// Cross-repo — pushing to `origin` would create a stray upstream
		// branch and wouldn't update the PR. Handle fork routing.
		if (!pr.maintainerCanModify) {
			const choice = await ctx.ui.select(
				`PR #${pr.number} is cross-repo and maintainerCanModify is false`,
				["Output patch series (Recommended)", "Abort — keep commits local"],
			);
			if (!choice || choice.startsWith("Abort")) {
				notify(ctx, "aborted — commits stay local", "info");
				return null;
			}
			// Patch-series fallback: produce format-patch output inline so the
			// user can share it with the PR author.
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

		// Build a fork remote URL by swapping the path component of origin.
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
		ctx: ExtensionCommandContext,
		target: PushTarget,
	): Promise<boolean> {
		const remoteRef = `${target.target}/${target.targetBranch}`;

		// First push: no remote-tracking ref exists yet, so there is nothing
		// to drift from. Just push. Without this guard the merge-base /
		// is-ancestor probes below both silently fail on the unknown ref and
		// we fall through to the "remote has commits we don't have" prompt.
		if (!refExists(ctx.cwd, remoteRef)) {
			const r = pushRefspec(
				ctx.cwd,
				target.target,
				`HEAD:${target.targetBranch}`,
				false,
			);
			if (!r.ok) {
				notify(ctx, `git push failed: ${r.stderr.trim()}`, "error");
				return false;
			}
			return true;
		}

		// Head-drift detection.
		if (isAncestor(ctx.cwd, remoteRef)) {
			const r = pushRefspec(
				ctx.cwd,
				target.target,
				`HEAD:${target.targetBranch}`,
				false,
			);
			if (!r.ok) {
				notify(ctx, `git push failed: ${r.stderr.trim()}`, "error");
				return false;
			}
			return true;
		}

		// Remote moved. Compare trees to distinguish "author amended/rebased
		// to same content" from "real new upstream commits".
		const our = mergeBase(ctx.cwd, remoteRef, "HEAD");
		if (our && treesIdentical(ctx.cwd, our, remoteRef)) {
			// Trees match — replay our commits onto the new head.
			const rb = rebaseOnto(ctx.cwd, remoteRef, our);
			if (!rb.ok) {
				notify(ctx, `rebase --onto failed: ${rb.stderr.trim()}`, "error");
				return false;
			}
			notify(ctx, "rebased onto remote (trees matched)", "info");
			const r = pushRefspec(
				ctx.cwd,
				target.target,
				`HEAD:${target.targetBranch}`,
				false,
			);
			if (!r.ok) {
				notify(ctx, `git push failed: ${r.stderr.trim()}`, "error");
				return false;
			}
			return true;
		}

		// Real divergence — ask the user.
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
			const p = pushRefspec(
				ctx.cwd,
				target.target,
				`HEAD:${target.targetBranch}`,
				false,
			);
			if (!p.ok) {
				notify(
					ctx,
					`git push after rebase failed: ${p.stderr.trim()}`,
					"error",
				);
				return false;
			}
			return true;
		}
		// Force push — explicit consent collected above.
		const confirm = await ctx.ui.confirm(
			"Confirm force-push",
			`This will overwrite ${remoteRef} with your local commits. Destructive. Continue?`,
		);
		if (!confirm) {
			notify(ctx, "aborted", "info");
			return false;
		}
		const r = pushRefspec(
			ctx.cwd,
			target.target,
			`HEAD:${target.targetBranch}`,
			true,
		);
		if (!r.ok) {
			notify(ctx, `force-push failed: ${r.stderr.trim()}`, "error");
			return false;
		}
		return true;
	}
}

// ---- Inline spawn helper (re-exported from ./git.js would introduce a
// circular import indirection just for this one use; keep it local). ----

import { runCommand as _runCommand } from "./git.js";

function runCommandInline(cwd: string, cmd: string, args: readonly string[]) {
	return _runCommand(cmd, args, { cwd });
}

// Re-export pure helpers for test reach-through.
export {
	buildForkUrl,
	isSafeBranchName,
	isValidIssueNumber,
	parseTitleAndBody,
	summarisePlan,
};
