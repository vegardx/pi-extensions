/**
 * pi-ext-idea
 *
 * Registers `/idea <text>` — a low-friction GitHub issue capture
 * targeting cwd's `origin` remote, mirroring `/derp` but for
 * feature ideas/improvement notes rather than bug reports.
 *
 * The handler runs entirely inside the slash-command callback. It
 * never calls `pi.sendMessage`, so the host session's current turn
 * is undisturbed:
 *
 *   1. Gather repo + session context. Bail with a warning if cwd
 *      isn't inside a git repo with an `origin` remote.
 *   2. Run the redactor over every captured field. If anything
 *      secret-shaped fires, stash to disk and bail (fail-closed).
 *   3. Polish title/body via a one-shot RPC subagent on the `fast`
 *      tier. Falls back to a deterministic template on any
 *      failure.
 *   4. Run the redactor over the polished title + body. Any hit →
 *      stash and bail.
 *   5. Shell out to `gh issue create -R <cwd-origin>` so the issue
 *      lands in the repo the user is currently working in.
 *   6. Notify the user with the issue URL or a recovery hint.
 *
 * Loss-proof: every failure stashes a (redacted) note under
 * `~/.pi/agent/idea/pending/` so the user can recover by hand.
 */

import { dirname, join } from "node:path";
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
import {
	defaultPendingDir,
	createIssue as sharedCreateIssue,
	writePendingReport as sharedWritePendingReport,
} from "@vegardx/pi-extensions-shared/gh-issue.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import {
	type PolishOutcome,
	polishReport as sharedPolish,
} from "@vegardx/pi-extensions-shared/polish-runner.js";
import {
	type RedactHit,
	redactFull,
	summariseHitKinds,
} from "@vegardx/pi-extensions-shared/redact.js";
import { gatherIdeaContext, type IdeaContext } from "./context.js";
import {
	applyTitlePrefix,
	buildFallbackIssue,
	buildPolishTask,
	type IssueDraft,
} from "./template.js";

const EXT_ID = "idea";
const PENDING_DIR = defaultPendingDir(EXT_ID);

const SYSTEM_PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"system-prompt.md",
);

const POLISH_TOOLS = ["read", "grep", "find", "ls"] as const;

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
		doc: `Low-friction GitHub idea/improvement capture. \`/idea <text>\` files an issue against the current repo's \`origin\` remote without interrupting the active session. Fails closed on any secret/internal-host hit \u2014 stashes to ~/.pi/agent/idea/pending/ for manual review.`,
		configSchema: [
			{
				key: "labels",
				type: "string[]",
				default: [],
				doc: "Labels applied to the created issue. Set to [] to skip. Unknown labels trigger one retry without --label.",
			},
			{
				key: "polishTimeoutMs",
				type: "number",
				default: 30000,
				doc: "Hard timeout for the polish subagent. On timeout, /idea falls back to a deterministic template and still attempts to file (subject to redaction).",
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
				default: "[idea] ",
				doc: 'Prefix prepended to the polished/fallback title. Set to "" to disable.',
			},
		],
	});

	pi.registerCommand(EXT_ID, {
		description:
			"Quietly file a GitHub idea/improvement issue against the current repo's origin without interrupting the current turn. Usage: `/idea <free-form description>`.",
		handler: async (args, ctx) => {
			await runIdea(ctx, args ?? "");
		},
	});
}

/**
 * Resolve the model to use for the polish subagent. Uses tier
 * `fast` so the user's preferred cheap/quick model is picked up
 * automatically via `backgroundModels.primary.fast` or the
 * per-extension override `extensionConfig.idea.model`.
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
 * Test seam: the production path uses the shared `createIssue` /
 * `polishReport`, but `__tests__/index.test.ts` injects stubs.
 */
export interface RunIdeaDeps {
	createIssue?: typeof sharedCreateIssue;
	polish?: typeof sharedPolish;
	resolvePolishModel?: typeof defaultResolvePolishModel;
	pendingDir?: string;
	gitRunner?: Parameters<typeof gatherIdeaContext>[0]["gitRunner"];
}

export async function runIdea(
	ctx: ExtensionContext,
	args: string,
	deps: RunIdeaDeps = {},
): Promise<void> {
	const settings = readRelevantSettings(ctx.cwd);

	const labels = getExtensionConfigStringArray(settings, EXT_ID, "labels", []);
	const titlePrefix = getExtensionConfigString(
		settings,
		EXT_ID,
		"titlePrefix",
		"[idea] ",
	);
	const recentEntryCount = getNumberConfig(settings, "recentEntries", 6);
	const polishTimeoutMs = getNumberConfig(settings, "polishTimeoutMs", 30000);

	const entries = ctx.sessionManager.getEntries();
	const polishFn = deps.polish ?? sharedPolish;
	const resolvePolishModelFn =
		deps.resolvePolishModel ?? defaultResolvePolishModel;
	const polishModel = await resolvePolishModelFn(ctx);
	const pendingDir = deps.pendingDir ?? PENDING_DIR;

	const gathered = gatherIdeaContext({
		cwd: ctx.cwd,
		userText: args,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionName: ctx.sessionManager.getSessionName() ?? null,
		entries,
		recentEntryCount,
		gitRunner: deps.gitRunner,
	});

	if (!gathered.ok) {
		ctx.ui.notify(gathered.detail, "warning");
		return;
	}

	const rawCtx = gathered.ctx;
	const targetRepo = rawCtx.origin.slug;
	const targetHost = rawCtx.origin.host;

	// ---- Layer-1 redaction: input scrub -----------------------------
	const inputScan = scanContextForSecrets(rawCtx);
	if (inputScan.hits.length > 0) {
		const pendingDraft = await buildPendingDraft({
			ctx,
			ideaCtx: inputScan.cleanedCtx,
			polishModel,
			polishFn,
			polishTimeoutMs,
			titlePrefix,
		});
		bailOnRedaction({
			ctx,
			hits: inputScan.hits,
			where: "input",
			targetRepo,
			targetHost,
			pendingDir,
			...pendingDraft,
		});
		return;
	}
	const ideaCtx = inputScan.cleanedCtx;

	// ---- Polish step ------------------------------------------------
	let draft: IssueDraft;
	let polishSkipped = false;

	if (!polishModel) {
		polishSkipped = true;
		ctx.ui.notify(
			"idea: no fast/active model — filing with deterministic template.",
			"warning",
		);
		draft = buildFallbackIssue(ideaCtx, titlePrefix);
	} else {
		ctx.ui.notify(`idea: polishing for ${targetRepo}…`, "info");
		const polished = await polishFn({
			tag: EXT_ID,
			task: buildPolishTask(ideaCtx),
			systemPromptPath: SYSTEM_PROMPT_PATH,
			tools: POLISH_TOOLS,
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
				`idea: polish failed (${polished.reason}) — filing with deterministic template.`,
				"warning",
			);
			draft = buildFallbackIssue(ideaCtx, titlePrefix);
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
			targetRepo,
			targetHost,
			pendingDir,
			draft: { title: titleScan.text, body: bodyScan.text },
			wasPolished: false,
		});
		return;
	}

	// ---- File the issue --------------------------------------------
	const create = deps.createIssue ?? sharedCreateIssue;
	const result = create(
		{ draft, labels, cwd: ctx.cwd, host: targetHost, targetRepo },
		undefined,
		pendingDir,
	);

	if (result.ok) {
		const suffix = polishSkipped ? " (raw template)" : "";
		ctx.ui.notify(`idea: filed ${result.url}${suffix}`, "info");
		return;
	}

	if (result.reason === "labels-rejected") {
		ctx.ui.notify(`idea: ${result.detail}`, "warning");
		return;
	}

	const recovery = result.pendingPath
		? ` Saved note to ${result.pendingPath} — recover with \`gh issue create -R ${targetRepo} --body-file ${result.pendingPath}\`.`
		: "";
	ctx.ui.notify(`idea: ${result.detail}.${recovery}`, "warning");
}

// ---------------------------------------------------------------------------
// Redaction wiring
// ---------------------------------------------------------------------------

interface ContextScanResult {
	cleanedCtx: IdeaContext;
	hits: RedactHit[];
}

/**
 * Run `redactFull` over the user-visible text fields of
 * `IdeaContext`. Returns the cleaned context plus the combined hit
 * list.
 */
export function scanContextForSecrets(ctx: IdeaContext): ContextScanResult {
	const hits: RedactHit[] = [];
	const scrub = (text: string): string => {
		const r = redactFull(text);
		hits.push(...r.hits);
		return r.text;
	};

	const cleaned: IdeaContext = {
		...ctx,
		userText: scrub(ctx.userText),
		sessionName: ctx.sessionName ? scrub(ctx.sessionName) : null,
		origin: {
			...ctx.origin,
			// origin.slug is rendered in the polish task's Environment block.
			// For internal GHE/corp remotes the host can be a sensitive
			// internal hostname — scrub before passing to the subagent so the
			// fail-closed redaction check sees it.
			host: scrub(ctx.origin.host),
			owner: scrub(ctx.origin.owner),
			repo: scrub(ctx.origin.repo),
			slug: scrub(ctx.origin.slug),
		},
		recentEntries: ctx.recentEntries.map((e) => ({
			role: e.role,
			text: scrub(e.text),
		})),
	};
	return { cleanedCtx: cleaned, hits };
}

/**
 * Attempt to polish `ideaCtx` into a pending-file draft. If polish
 * succeeds and the output is clean, returns the polished draft;
 * otherwise falls back to the deterministic template. Used in the
 * Layer-1 redaction bail path so stashed notes are readable.
 */
async function buildPendingDraft(args: {
	ctx: ExtensionContext;
	ideaCtx: IdeaContext;
	polishModel: { provider: string; id: string } | null;
	polishFn: typeof sharedPolish;
	polishTimeoutMs: number;
	titlePrefix: string;
}): Promise<{ draft: IssueDraft; wasPolished: boolean }> {
	if (args.polishModel) {
		const attempt: PolishOutcome = await args.polishFn({
			tag: EXT_ID,
			task: buildPolishTask(args.ideaCtx),
			systemPromptPath: SYSTEM_PROMPT_PATH,
			tools: POLISH_TOOLS,
			provider: args.polishModel.provider,
			model: args.polishModel.id,
			cwd: args.ctx.cwd,
			timeoutMs: args.polishTimeoutMs,
		});
		if (attempt.ok) {
			const ts = redactFull(attempt.draft.title);
			const bs = redactFull(attempt.draft.body);
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
		draft: buildFallbackIssue(args.ideaCtx, args.titlePrefix),
		wasPolished: false,
	};
}

function bailOnRedaction(args: {
	ctx: ExtensionContext;
	hits: RedactHit[];
	where: string;
	draft: IssueDraft;
	wasPolished: boolean;
	targetRepo: string;
	targetHost: string;
	pendingDir: string;
}): void {
	const kinds = summariseHitKinds(args.hits).join(", ");
	const path = sharedWritePendingReport(
		args.draft,
		args.targetHost,
		args.pendingDir,
	);
	const qualifier = args.wasPolished ? "(polished)" : "(raw)";
	args.ctx.ui.notify(
		`idea: ${args.where} contained secret-shaped content (${kinds}) — not filing ${qualifier}. Review at ${path}; if safe, run \`gh issue create -R ${args.targetRepo} --body-file ${path}\`.`,
		"warning",
	);
}
