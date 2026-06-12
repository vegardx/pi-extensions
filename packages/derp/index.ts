/**
 * pi-ext-derp
 *
 * Registers `/derp <text>` — a fire-and-forget GitHub bug reporter
 * that stays out of the active session.
 *
 * Uses the shared issue-filing pipeline from `_shared/issue-filer.ts`
 * for the redact → polish → redact → file orchestration.
 */

import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { defineExtension } from "@vegardx/pi-extensions-shared/define-extension.js";
import {
	getExtensionConfigNumber,
	getExtensionConfigString,
	getExtensionConfigStringArray,
	type RelevantSettings,
	readRelevantSettings,
} from "@vegardx/pi-extensions-shared/extension-settings.js";
import {
	fileIssue,
	type IssueFilingResult,
} from "@vegardx/pi-extensions-shared/issue-filer.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import {
	type RedactHit,
	redactFull,
} from "@vegardx/pi-extensions-shared/redact.js";
import { type DerpContext, gatherDerpContext } from "./context.js";
import { createIssue, writePendingReport } from "./gh.js";
import { polishReport } from "./polish.js";
import {
	applyTitlePrefix,
	buildFallbackIssue,
	type IssueDraft,
} from "./template.js";

const EXT_ID = "derp";

const TARGET_HOST = "github.com";
const TARGET_OWNER = "vegardx";
const TARGET_NAME = "pi-extensions";
const TARGET_REPO = `${TARGET_HOST}/${TARGET_OWNER}/${TARGET_NAME}`;

function getNumberConfig(
	settings: RelevantSettings,
	key: string,
	defaultValue: number,
): number {
	const raw = getExtensionConfigNumber(settings, EXT_ID, key, defaultValue);
	return raw > 0 ? raw : defaultValue;
}

export default defineExtension(
	{
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: `Fire-and-forget GitHub bug reporter. \`/derp <text>\` files an issue against ${TARGET_REPO} without interrupting the active session. Fails closed on any secret/internal-host hit — stashes to ~/.pi/agent/derp/pending/ for manual review.`,
		integratesWith: ["modes"],
		configSchema: [
			{
				key: "labels",
				type: "string[]",
				default: ["bug"],
				doc: "Labels applied to the created issue. Set to [] to skip. Unknown labels trigger one retry without --label.",
			},
			{
				key: "polish.timeoutMs",
				type: "number",
				default: 30000,
				doc: "Hard timeout for the polish subagent. On timeout, derp falls back to a deterministic template and still attempts to file (subject to redaction).",
			},
			{
				key: "polish.contextEntries",
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
			{
				key: "model",
				type: "string",
				fallbackChain:
					"extensionConfig.derp.model → backgroundModels.primary.fast → session model",
				doc: "Model for the polish subagent that turns your /derp text into a clean issue. Fast-tier background work — leave unset to use backgroundModels.primary.fast, then the session model.",
			},
		],
	},
	(pi: ExtensionAPI) => {
		pi.registerCommand(EXT_ID, {
			description: `Quietly file a GitHub issue at ${TARGET_REPO} about a pi/harness/repo problem without interrupting the current turn. Usage: \`/derp <free-form description>\`.`,
			handler: async (args, ctx) => {
				await runDerp(ctx, args ?? "");
			},
		});
	},
);

/**
 * Resolve the model to use for the polish subagent.
 */
export async function defaultResolvePolishModel(
	ctx: ExtensionContext,
): Promise<{ provider: string; id: string } | null> {
	const resolved = await resolveModel(ctx, { name: EXT_ID, tier: "fast" });
	if (!resolved) return null;
	return { provider: resolved.model.provider, id: resolved.model.id };
}

/**
 * Test seam: inject stubs for external dependencies.
 */
export interface RunDerpDeps {
	createIssue?: typeof createIssue;
	polish?: typeof polishReport;
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
	const recentEntryCount = getNumberConfig(
		settings,
		"polish.contextEntries",
		6,
	);
	const polishTimeoutMs = getNumberConfig(settings, "polish.timeoutMs", 30000);

	const entries = ctx.sessionManager.getEntries();
	const polishFn = deps.polish ?? polishReport;
	const resolvePolishModelFn =
		deps.resolvePolishModel ?? defaultResolvePolishModel;
	const polishModel = await resolvePolishModelFn(ctx);
	const pendingDir = deps.pendingDir;

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

	const result: IssueFilingResult = await fileIssue<DerpContext>({
		tag: EXT_ID,
		ctx,
		targetRepo: TARGET_REPO,
		targetHost: TARGET_HOST,
		labels,
		titlePrefix,
		pendingDir:
			pendingDir ?? `${process.env.HOME ?? "~"}/.pi/agent/derp/pending`,
		rawContext: rawCtx,
		scanContextForSecrets,
		buildFallbackIssue,
		applyTitlePrefix,
		polish: async (cleanedCtx) => {
			if (!polishModel) {
				ctx.ui.notify(
					"derp: no active session model — filing with deterministic template.",
					"warning",
				);
				return null;
			}
			ctx.ui.notify(`derp: polishing report for ${TARGET_REPO}…`, "info");
			return polishFn({
				ctx: cleanedCtx,
				provider: polishModel.provider,
				model: polishModel.id,
				cwd: ctx.cwd,
				timeoutMs: polishTimeoutMs,
			});
		},
		createIssue: (input, _runner, dir) => {
			const create = deps.createIssue ?? createIssue;
			return create(input, undefined, dir);
		},
		writePendingReport,
	});

	void result;
}

// ---------------------------------------------------------------------------
// Redaction wiring (domain-specific: knows DerpContext shape)
// ---------------------------------------------------------------------------

/**
 * Run `redactFull` over the user-visible text fields of `DerpContext`.
 */
export function scanContextForSecrets(ctx: DerpContext): {
	cleanedCtx: DerpContext;
	hits: RedactHit[];
} {
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
		crashReports: ctx.crashReports.map((r) => ({
			...r,
			error: {
				name: r.error.name,
				message: scrub(r.error.message),
				stack: r.error.stack === null ? null : scrub(r.error.stack),
			},
			recentEntries: r.recentEntries.map((e) => ({
				role: e.role,
				text: scrub(e.text),
			})),
		})),
	};
	return { cleanedCtx: cleaned, hits };
}
