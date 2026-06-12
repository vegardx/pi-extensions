/**
 * Shared issue-filing pipeline for extensions that follow the
 * gather → redact → polish → redact → file → bail pattern.
 *
 * Both `/derp` and `/idea` implement identical orchestration logic
 * with different context types and target-repo strategies. This
 * module provides the shared skeleton so each extension only defines
 * the domain-specific parts (context shape, template, scan logic).
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
	IssueCreateInput,
	IssueCreateOutcome,
} from "@vegardx/pi-extensions-shared/gh-issue.js";
import type { PolishOutcome } from "@vegardx/pi-extensions-shared/polish-runner.js";
import type { RedactHit } from "@vegardx/pi-extensions-shared/redact.js";
import {
	redactFull,
	summariseHitKinds,
} from "@vegardx/pi-extensions-shared/redact.js";

// ---- Types ----------------------------------------------------------------

export interface IssueDraft {
	title: string;
	body: string;
}

/** The result of scanning a context object for secrets. */
export interface ContextScanResult<T> {
	cleanedCtx: T;
	hits: RedactHit[];
}

/** Configuration for a single issue-filing invocation. */
export interface IssueFilingConfig<TContext> {
	/** Extension name for notifications (e.g. "derp", "idea"). */
	tag: string;
	/** The pi extension context for UI notifications and cwd. */
	ctx: ExtensionContext;
	/** Target repository slug (e.g. "github.com/owner/repo"). */
	targetRepo: string;
	/** Target host (e.g. "github.com"). */
	targetHost: string;
	/** Labels to apply to the issue. */
	labels: string[];
	/** Title prefix (e.g. "[derp] "). */
	titlePrefix: string;
	/** Directory to stash pending reports on failure. */
	pendingDir: string;

	/** The raw gathered context before any redaction. */
	rawContext: TContext;

	/** Scan context fields for secrets. */
	scanContextForSecrets: (ctx: TContext) => ContextScanResult<TContext>;

	/** Build a fallback (deterministic) issue draft from context. */
	buildFallbackIssue: (ctx: TContext, titlePrefix: string) => IssueDraft;

	/** Apply title prefix to a polished title. */
	applyTitlePrefix: (title: string, prefix: string) => string;

	/**
	 * Polish the context into a draft. Returns null to skip polish
	 * (e.g. no model available).
	 */
	polish: (cleanedCtx: TContext) => Promise<PolishOutcome | null>;

	/** Create a GitHub issue. */
	createIssue: (
		input: IssueCreateInput,
		runner?: undefined,
		pendingDir?: string,
	) => IssueCreateOutcome;

	/** Write a pending report to disk. */
	writePendingReport: (draft: IssueDraft, host: string, dir: string) => string;
}

/** Result of the pipeline. */
export type IssueFilingResult =
	| { ok: true; url: string; polishSkipped: boolean }
	| { ok: false; reason: string };

// ---- Pipeline -------------------------------------------------------------

/**
 * Execute the full issue-filing pipeline:
 *
 * 1. Scan raw context for secrets (Layer-1 redaction)
 * 2. Polish context into a draft (or fall back to template)
 * 3. Scan polished output for secrets (Layer-2 redaction)
 * 4. File the issue via `gh issue create`
 * 5. On any redaction hit or filing failure → stash pending report
 */
export async function fileIssue<TContext>(
	config: IssueFilingConfig<TContext>,
): Promise<IssueFilingResult> {
	const {
		tag,
		ctx,
		targetRepo,
		targetHost,
		labels,
		titlePrefix,
		pendingDir,
		rawContext,
		scanContextForSecrets,
		buildFallbackIssue,
		applyTitlePrefix,
		polish,
		createIssue,
		writePendingReport,
	} = config;

	// ---- Layer-1 redaction: input scrub -----------------------------
	const inputScan = scanContextForSecrets(rawContext);
	if (inputScan.hits.length > 0) {
		// Still try to produce a readable pending draft via polish
		let pendingDraft: IssueDraft;
		let wasPolished = false;
		const polishAttempt = await polish(inputScan.cleanedCtx);
		if (polishAttempt?.ok) {
			const ts = redactFull(polishAttempt.draft.title);
			const bs = redactFull(polishAttempt.draft.body);
			if (ts.hits.length === 0 && bs.hits.length === 0) {
				pendingDraft = {
					title: applyTitlePrefix(ts.text, titlePrefix),
					body: bs.text,
				};
				wasPolished = true;
			} else {
				pendingDraft = buildFallbackIssue(inputScan.cleanedCtx, titlePrefix);
			}
		} else {
			pendingDraft = buildFallbackIssue(inputScan.cleanedCtx, titlePrefix);
		}
		bailOnRedaction({
			ctx,
			tag,
			hits: inputScan.hits,
			where: "input",
			targetRepo,
			targetHost,
			pendingDir,
			draft: pendingDraft,
			wasPolished,
			writePendingReport,
		});
		return { ok: false, reason: "input-redaction" };
	}
	const cleanedCtx = inputScan.cleanedCtx;

	// ---- Polish step ------------------------------------------------
	let draft: IssueDraft;
	let polishSkipped = false;

	const polishResult = await polish(cleanedCtx);
	if (polishResult === null) {
		// Caller's polish callback already handled notification
		polishSkipped = true;
		draft = buildFallbackIssue(cleanedCtx, titlePrefix);
	} else if (polishResult.ok) {
		draft = {
			title: applyTitlePrefix(polishResult.draft.title, titlePrefix),
			body: polishResult.draft.body,
		};
	} else {
		polishSkipped = true;
		ctx.ui.notify(
			`${tag}: polish failed (${polishResult.reason}) — filing with deterministic template.`,
			"warning",
		);
		draft = buildFallbackIssue(cleanedCtx, titlePrefix);
	}

	// ---- Layer-2 redaction: output scrub ----------------------------
	const titleScan = redactFull(draft.title);
	const bodyScan = redactFull(draft.body);
	const outputHits = [...titleScan.hits, ...bodyScan.hits];
	if (outputHits.length > 0) {
		bailOnRedaction({
			ctx,
			tag,
			hits: outputHits,
			where: "polish output",
			targetRepo,
			targetHost,
			pendingDir,
			draft: { title: titleScan.text, body: bodyScan.text },
			wasPolished: false,
			writePendingReport,
		});
		return { ok: false, reason: "output-redaction" };
	}

	// ---- File the issue --------------------------------------------
	const result = createIssue(
		{ draft, labels, cwd: ctx.cwd, host: targetHost, targetRepo },
		undefined,
		pendingDir,
	);

	if (result.ok) {
		const suffix = polishSkipped ? " (raw template)" : "";
		ctx.ui.notify(`${tag}: filed ${result.url}${suffix}`, "info");
		return { ok: true, url: result.url, polishSkipped };
	}

	if (result.reason === "labels-rejected") {
		ctx.ui.notify(`${tag}: ${result.detail}`, "warning");
		return { ok: false, reason: "labels-rejected" };
	}

	const recovery = result.pendingPath
		? ` Saved report to ${result.pendingPath} — recover with \`gh issue create -R ${targetRepo} --body-file ${result.pendingPath}\`.`
		: "";
	ctx.ui.notify(`${tag}: ${result.detail}.${recovery}`, "warning");
	return { ok: false, reason: result.reason ?? "create-failed" };
}

// ---- Helpers --------------------------------------------------------------

function bailOnRedaction(args: {
	ctx: ExtensionContext;
	tag: string;
	hits: RedactHit[];
	where: string;
	draft: IssueDraft;
	wasPolished: boolean;
	targetRepo: string;
	targetHost: string;
	pendingDir: string;
	writePendingReport: (draft: IssueDraft, host: string, dir: string) => string;
}): void {
	const kinds = summariseHitKinds(args.hits).join(", ");
	const path = args.writePendingReport(
		args.draft,
		args.targetHost,
		args.pendingDir,
	);
	const qualifier = args.wasPolished ? "(polished)" : "(raw)";
	args.ctx.ui.notify(
		`${args.tag}: ${args.where} contained secret-shaped content (${kinds}) — not filing ${qualifier}. Review at ${path}; if safe, run \`gh issue create -R ${args.targetRepo} --body-file ${path}\`.`,
		"warning",
	);
}
