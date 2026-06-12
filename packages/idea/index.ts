/**
 * pi-ext-idea
 *
 * Registers `/idea <text>` — a low-friction GitHub issue capture
 * targeting cwd's `origin` remote, mirroring `/derp` but for
 * feature ideas/improvement notes rather than bug reports.
 *
 * Uses the shared issue-filing pipeline from `_shared/issue-filer.ts`
 * for the redact → polish → redact → file orchestration.
 */

import { dirname, join } from "node:path";
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
	defaultPendingDir,
	createIssue as sharedCreateIssue,
	writePendingReport as sharedWritePendingReport,
} from "@vegardx/pi-extensions-shared/gh-issue.js";
import {
	fileIssue,
	type IssueFilingResult,
} from "@vegardx/pi-extensions-shared/issue-filer.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { polishReport as sharedPolish } from "@vegardx/pi-extensions-shared/polish-runner.js";
import {
	type RedactHit,
	redactFull,
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
	const raw = getExtensionConfigNumber(settings, EXT_ID, key, defaultValue);
	return raw > 0 ? raw : defaultValue;
}

export default defineExtension(
	{
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: `Low-friction GitHub idea/improvement capture. \`/idea <text>\` files an issue against the current repo's \`origin\` remote without interrupting the active session. Fails closed on any secret/internal-host hit — stashes to ~/.pi/agent/idea/pending/ for manual review.`,
		configSchema: [
			{
				key: "labels",
				type: "string[]",
				default: [],
				doc: "Labels applied to the created issue. Set to [] to skip. Unknown labels trigger one retry without --label.",
			},
			{
				key: "polish.timeoutMs",
				type: "number",
				default: 30000,
				doc: "Hard timeout for the polish subagent. On timeout, /idea falls back to a deterministic template and still attempts to file (subject to redaction).",
			},
			{
				key: "polish.contextEntries",
				type: "number",
				default: 6,
				doc: "How many most-recent session entries to include as context for the polish subagent.",
			},
			{
				key: "titlePrefix",
				type: "string",
				doc: "Optional prefix prepended to the polished/fallback title. Leave unset for no prefix.",
			},
			{
				key: "model",
				type: "string",
				fallbackChain:
					"extensionConfig.idea.model → backgroundModels.primary.fast → session model",
				doc: "Model for the polish subagent that turns your /idea text into a clean issue. Fast-tier background work — leave unset to use backgroundModels.primary.fast, then the session model.",
			},
		],
	},
	(pi: ExtensionAPI) => {
		pi.registerCommand(EXT_ID, {
			description:
				"Quietly file a GitHub idea/improvement issue against the current repo's origin without interrupting the current turn. Usage: `/idea <free-form description>`.",
			handler: async (args, ctx) => {
				await runIdea(ctx, args ?? "");
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
		"",
	);
	const recentEntryCount = getNumberConfig(
		settings,
		"polish.contextEntries",
		6,
	);
	const polishTimeoutMs = getNumberConfig(settings, "polish.timeoutMs", 30000);

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

	const result: IssueFilingResult = await fileIssue<IdeaContext>({
		tag: EXT_ID,
		ctx,
		targetRepo,
		targetHost,
		labels,
		titlePrefix,
		pendingDir,
		rawContext: rawCtx,
		scanContextForSecrets,
		buildFallbackIssue,
		applyTitlePrefix,
		polish: async (cleanedCtx) => {
			if (!polishModel) {
				ctx.ui.notify(
					"idea: no fast/active model — filing with deterministic template.",
					"warning",
				);
				return null;
			}
			ctx.ui.notify(`idea: polishing for ${targetRepo}…`, "info");
			return polishFn({
				tag: EXT_ID,
				task: buildPolishTask(cleanedCtx),
				systemPromptPath: SYSTEM_PROMPT_PATH,
				tools: POLISH_TOOLS,
				provider: polishModel.provider,
				model: polishModel.id,
				cwd: ctx.cwd,
				timeoutMs: polishTimeoutMs,
			});
		},
		createIssue: deps.createIssue ?? sharedCreateIssue,
		writePendingReport: sharedWritePendingReport,
	});

	// Pipeline handles all notifications internally
	void result;
}

// ---------------------------------------------------------------------------
// Redaction wiring (domain-specific: knows IdeaContext shape)
// ---------------------------------------------------------------------------

/**
 * Run `redactFull` over the user-visible text fields of
 * `IdeaContext`. Returns the cleaned context plus the combined hit
 * list.
 */
export function scanContextForSecrets(ctx: IdeaContext): {
	cleanedCtx: IdeaContext;
	hits: RedactHit[];
} {
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
