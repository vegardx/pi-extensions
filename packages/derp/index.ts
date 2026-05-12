/**
 * pi-ext-derp
 *
 * Registers `/derp <text>` — a fire-and-forget GitHub bug reporter
 * that stays out of the active session.
 *
 * The handler runs entirely inside the slash-command callback. It
 * never calls `pi.sendMessage`, so the host session's current turn
 * is undisturbed:
 *
 *   1. Gather repo + session context.
 *   2. Run the redactor over every captured field. If anything
 *      secret-shaped fires, stash to disk and bail (fail-closed).
 *   3. Polish title/body via a one-shot RPC subagent on the active
 *      session model. Falls back to a deterministic template on
 *      any failure.
 *   4. Run the redactor over the polished title + body. Any hit →
 *      stash and bail.
 *   5. Shell out to `gh issue create -R vegardx/pi-extensions` so
 *      the issue always lands in this repo, regardless of cwd.
 *   6. Notify the user with the issue URL or a recovery hint.
 *
 * Loss-proof: every failure stashes a (redacted) report under
 * `~/.pi/agent/derp/pending/` so the user can recover by hand.
 */

import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import {
	getExtensionConfigString,
	getExtensionConfigStringArray,
	type RelevantSettings,
	readRelevantSettings,
} from "@vegardx/pi-extensions-shared/extension-settings.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { type DerpContext, gatherDerpContext } from "./context.js";
import { createIssue, writePendingReport } from "./gh.js";
import { polishReport } from "./polish.js";
import { type RedactHit, redactFull, summariseHitKinds } from "./redact.js";
import {
	applyTitlePrefix,
	buildFallbackIssue,
	type IssueDraft,
} from "./template.js";

const EXT_ID = "derp";

/**
 * Issues are always filed against this repo, regardless of cwd. A
 * future iteration may add per-call routing (e.g. file harness bugs
 * upstream against `badlogic/pi-mono`); for now, hard-coded.
 */
const TARGET_HOST = "github.com";
const TARGET_OWNER = "vegardx";
const TARGET_NAME = "pi-extensions";
const TARGET_REPO = `${TARGET_HOST}/${TARGET_OWNER}/${TARGET_NAME}`;

function getNumberConfig(
	settings: RelevantSettings,
	key: string,
	defaultValue: number,
): number {
	const raw = settings.extensionConfig?.[EXT_ID]?.[key];
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0
		? raw
		: defaultValue;
}

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: `Fire-and-forget GitHub bug reporter. \`/derp <text>\` files an issue against ${TARGET_REPO} without interrupting the active session. Fails closed on any secret/internal-host hit \u2014 stashes to ~/.pi/agent/derp/pending/ for manual review.`,
		configSchema: [
			{
				key: "labels",
				type: "string[]",
				default: ["bug"],
				doc: "Labels applied to the created issue. Set to [] to skip. Unknown labels trigger one retry without --label.",
			},
			{
				key: "polishTimeoutMs",
				type: "number",
				default: 30000,
				doc: "Hard timeout for the polish subagent. On timeout, derp falls back to a deterministic template and still attempts to file (subject to redaction).",
			},
			{
				key: "recentEntries",
				type: "number",
				default: 6,
				doc: "How many tail entries from the current session to feed into the polish subagent.",
			},
			{
				key: "titlePrefix",
				type: "string",
				default: "[derp] ",
				doc: 'Prefix prepended to the polished/fallback title. Set to "" to disable.',
			},
		],
	});

	pi.registerCommand(EXT_ID, {
		description: `Quietly file a GitHub issue at ${TARGET_REPO} about a pi/harness/repo problem without interrupting the current turn. Usage: \`/derp <free-form description>\`.`,
		handler: async (args, ctx) => {
			await runDerp(ctx, args ?? "");
		},
	});
}

/**
 * Resolve the model to use for the polish subagent. Uses tier `fast`
 * so the user's preferred cheap/quick model is picked up automatically
 * via `backgroundModels.primary.fast` or the per-extension override
 * `extensionConfig.derp.model`. Falls back to the active session model.
 *
 * Exported so tests can call it directly.
 */
export async function defaultResolvePolishModel(
	ctx: ExtensionContext,
): Promise<{ provider: string; id: string } | null> {
	const resolved = await resolveModel(ctx, { name: EXT_ID, tier: "fast" });
	if (!resolved) return null;
	return { provider: resolved.model.provider, id: resolved.model.id };
}

/**
 * Test seam: the production path uses `createIssue` from `gh.ts`,
 * but `__tests__/index.test.ts` injects a stub.
 */
export interface RunDerpDeps {
	createIssue?: typeof createIssue;
	polish?: typeof polishReport;
	/**
	 * Override model resolution (e.g. return a fixed spec in tests
	 * without needing a real ModelRegistry).
	 */
	resolvePolishModel?: typeof defaultResolvePolishModel;
	pendingDir?: string;
}

export async function runDerp(
	ctx: ExtensionContext,
	args: string,
	deps: RunDerpDeps = {},
): Promise<void> {
	const settings = readRelevantSettings(ctx.cwd);

	const labels = getExtensionConfigStringArray(settings, EXT_ID, "labels", [
		"bug",
	]);
	const titlePrefix = getExtensionConfigString(
		settings,
		EXT_ID,
		"titlePrefix",
		"[derp] ",
	);
	const recentEntryCount = getNumberConfig(settings, "recentEntries", 6);
	const polishTimeoutMs = getNumberConfig(settings, "polishTimeoutMs", 30000);

	const entries = ctx.sessionManager.getEntries();
	const polishFn = deps.polish ?? polishReport;
	const resolvePolishModelFn =
		deps.resolvePolishModel ?? defaultResolvePolishModel;
	const polishModel = await resolvePolishModelFn(ctx);

	const gathered = gatherDerpContext({
		cwd: ctx.cwd,
		userText: args,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionName: ctx.sessionManager.getSessionName() ?? null,
		entries,
		recentEntryCount,
	});

	if (!gathered.ok) {
		ctx.ui.notify(gathered.detail, "warning");
		return;
	}

	const rawCtx = gathered.ctx;

	// ---- Layer-1 redaction: input scrub -----------------------------
	const inputScan = scanContextForSecrets(rawCtx);
	if (inputScan.hits.length > 0) {
		const pendingDraft = await buildPendingDraft({
			ctx,
			derpCtx: inputScan.cleanedCtx,
			polishModel,
			polishFn,
			polishTimeoutMs,
			titlePrefix,
		});
		bailOnRedaction({
			ctx,
			hits: inputScan.hits,
			where: "input",
			...pendingDraft,
			pendingDir: deps.pendingDir,
		});
		return;
	}
	const derpCtx = inputScan.cleanedCtx;

	// ---- Polish step ------------------------------------------------
	let draft: IssueDraft;
	let polishSkipped = false;

	if (!polishModel) {
		polishSkipped = true;
		ctx.ui.notify(
			"derp: no active session model — filing with deterministic template.",
			"warning",
		);
		draft = buildFallbackIssue(derpCtx, titlePrefix);
	} else {
		ctx.ui.notify(`derp: polishing report for ${TARGET_REPO}…`, "info");
		const polished = await polishFn({
			ctx: derpCtx,
			provider: polishModel.provider,
			model: polishModel.id,
			cwd: ctx.cwd,
			timeoutMs: polishTimeoutMs,
		});
		if (polished.ok) {
			draft = {
				title: applyTitlePrefix(polished.draft.title, titlePrefix),
				body: polished.draft.body,
			};
		} else {
			polishSkipped = true;
			ctx.ui.notify(
				`derp: polish failed (${polished.reason}) — filing with deterministic template.`,
				"warning",
			);
			draft = buildFallbackIssue(derpCtx, titlePrefix);
		}
	}

	// ---- Layer-2 redaction: output scrub ----------------------------
	const titleScan = redactFull(draft.title);
	const bodyScan = redactFull(draft.body);
	const outputHits = [...titleScan.hits, ...bodyScan.hits];
	if (outputHits.length > 0) {
		bailOnRedaction({
			ctx,
			hits: outputHits,
			where: "polish output",
			draft: { title: titleScan.text, body: bodyScan.text },
			wasPolished: false,
			pendingDir: deps.pendingDir,
		});
		return;
	}

	// ---- File the issue --------------------------------------------
	const create = deps.createIssue ?? createIssue;
	const result = create(
		{
			draft,
			labels,
			cwd: ctx.cwd,
			host: TARGET_HOST,
			targetRepo: TARGET_REPO,
		},
		undefined,
		deps.pendingDir,
	);

	if (result.ok) {
		const suffix = polishSkipped ? " (raw template)" : "";
		ctx.ui.notify(`derp: filed ${result.url}${suffix}`, "info");
		return;
	}

	if (result.reason === "labels-rejected") {
		ctx.ui.notify(`derp: ${result.detail}`, "warning");
		return;
	}

	const recovery = result.pendingPath
		? ` Saved report to ${result.pendingPath} — recover with \`gh issue create -R ${TARGET_REPO} --body-file ${result.pendingPath}\`.`
		: "";
	ctx.ui.notify(`derp: ${result.detail}.${recovery}`, "warning");
}

// ---------------------------------------------------------------------------
// Redaction wiring
// ---------------------------------------------------------------------------

interface ContextScanResult {
	cleanedCtx: DerpContext;
	hits: RedactHit[];
}

/**
 * Run `redactFull` over every text-bearing field of `DerpContext`.
 * Returns the cleaned context plus the combined hit list. Scanned
 * fields: `userText`, `sessionName`, `recentEntries[].text`.
 */
export function scanContextForSecrets(ctx: DerpContext): ContextScanResult {
	const hits: RedactHit[] = [];
	const scrub = (text: string): string => {
		const r = redactFull(text);
		hits.push(...r.hits);
		return r.text;
	};

	const cleaned: DerpContext = {
		...ctx,
		userText: scrub(ctx.userText),
		sessionName: ctx.sessionName ? scrub(ctx.sessionName) : null,
		recentEntries: ctx.recentEntries.map((e) => ({
			role: e.role,
			text: scrub(e.text),
		})),
	};
	return { cleanedCtx: cleaned, hits };
}

/**
 * Attempt to polish `derpCtx` into a pending-file draft. If polish
 * succeeds and the output is clean, returns the polished draft;
 * otherwise falls back to the deterministic template. Used in the
 * Layer-1 redaction bail path so stashed reports are readable.
 */
async function buildPendingDraft(args: {
	ctx: ExtensionContext;
	derpCtx: DerpContext;
	polishModel: { provider: string; id: string } | null;
	polishFn: typeof polishReport;
	polishTimeoutMs: number;
	titlePrefix: string;
}): Promise<{ draft: IssueDraft; wasPolished: boolean }> {
	if (args.polishModel) {
		const attempt = await args.polishFn({
			ctx: args.derpCtx,
			provider: args.polishModel.provider,
			model: args.polishModel.id,
			cwd: args.ctx.cwd,
			timeoutMs: args.polishTimeoutMs,
		});
		if (attempt.ok) {
			const ts = redactFull(attempt.draft.title);
			const bs = redactFull(attempt.draft.body);
			// Only use the polished draft if it's also clean — if the LLM
			// managed to reproduce a secret from the cleaned context, fall
			// back to the raw template rather than stashing tainted content.
			if (ts.hits.length === 0 && bs.hits.length === 0) {
				return {
					draft: {
						title: applyTitlePrefix(ts.text, args.titlePrefix),
						body: bs.text,
					},
					wasPolished: true,
				};
			}
		}
	}
	return {
		draft: buildFallbackIssue(args.derpCtx, args.titlePrefix),
		wasPolished: false,
	};
}

function bailOnRedaction(args: {
	ctx: ExtensionContext;
	hits: RedactHit[];
	where: string;
	draft: IssueDraft;
	wasPolished: boolean;
	pendingDir?: string;
}): void {
	const kinds = summariseHitKinds(args.hits).join(", ");
	const path = writePendingReport(args.draft, TARGET_HOST, args.pendingDir);
	const qualifier = args.wasPolished ? "(polished)" : "(raw)";
	args.ctx.ui.notify(
		`derp: ${args.where} contained secret-shaped content (${kinds}) — not filing ${qualifier}. Review at ${path}; if safe, run \`gh issue create -R ${TARGET_REPO} --body-file ${path}\`.`,
		"warning",
	);
}
