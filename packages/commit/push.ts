/**
 * Push routing for the commit extension.
 *
 * Handles cross-repo PRs, fork push targets, diverged-remote
 * detection, and interactive/non-interactive push flows.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { findOpenPr } from "./gh.js";
import {
	addRemoteIdempotent,
	detectDefaultBranch,
	fetchRef,
	isAncestor,
	mergeBase,
	originUrl,
	pushRefspec,
	rebaseOnto,
	refExists,
	runCommand,
	treesIdentical,
} from "./git.js";
import { buildForkUrl } from "./helpers.js";

// ---- Types ----------------------------------------------------------------

export interface PushTarget {
	target: string;
	targetBranch: string;
}

type NotifyFn = (
	ctx: ExtensionContext,
	msg: string,
	level?: "info" | "warning" | "error",
) => void;

// ---- Push routing ---------------------------------------------------------

export async function resolvePushTarget(
	ctx: ExtensionContext,
	branch: string,
	nonInteractive: boolean,
	notify: NotifyFn,
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
		const r = runCommand("git", ["format-patch", `${base}..HEAD`], {
			cwd: ctx.cwd,
		});
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

// ---- Push execution -------------------------------------------------------

export async function doPush(
	ctx: ExtensionContext,
	target: PushTarget,
	nonInteractive: boolean,
	notify: NotifyFn,
): Promise<boolean> {
	const remoteRef = `${target.target}/${target.targetBranch}`;

	const doStandardPush = () =>
		tryPush(ctx, target, { errorLabel: "git push failed" }, notify);

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
		const r = runCommand("git", ["rebase", remoteRef], { cwd: ctx.cwd });
		if (!r.ok) {
			notify(
				ctx,
				`rebase conflicts — resolve manually, then re-run /commit. git status: ${r.stderr.trim()}`,
				"error",
			);
			return false;
		}
		return tryPush(
			ctx,
			target,
			{ errorLabel: "git push after rebase failed" },
			notify,
		);
	}
	const confirm = await ctx.ui.confirm(
		"Confirm force-push",
		`This will overwrite ${remoteRef} with your local commits. Destructive. Continue?`,
	);
	if (!confirm) {
		notify(ctx, "aborted", "info");
		return false;
	}
	return tryPush(
		ctx,
		target,
		{ force: true, errorLabel: "force-push failed" },
		notify,
	);
}

export function tryPush(
	ctx: ExtensionContext,
	target: PushTarget,
	opts: { force?: boolean; errorLabel: string },
	notify: NotifyFn,
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
