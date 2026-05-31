/**
 * modes — permission-mode cycle with integrated git workflow.
 *
 * Three modes cycled with Shift+Tab:
 *
 *   plan     — read-only tools, bash write guard, system prompt injection.
 *              Use plan_step to build and track the plan.
 *   ask      — all tools; confirm before every edit/write/mutating bash.
 *   auto     — all tools; no confirmation. Fully autonomous.
 *
 * Commands:
 *   /plan [desc]      sync to default branch, enter plan mode
 *   /implement [desc] sync + derive branch + git checkout -b + auto mode
 *   /park             gh issue create from plan text, exit plan mode
 *   /modes-status     show current mode, phase, branch, and step progress
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionManager,
	Theme,
} from "@mariozechner/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import type { OverlayHandle, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { setActiveMode } from "@vegardx/pi-extensions-shared/active-mode.js";
import { defineExtension } from "@vegardx/pi-extensions-shared/define-extension.js";
import { readRelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { classifyBashCommand } from "./bash-classifier.js";
import { installCrashHandler, type SessionAccessor } from "./crash-report.js";
import { composeFooterLine, type FooterRightCandidate } from "./footer.js";
import {
	checkoutBranch,
	createBranch,
	currentBranch,
	detectDefaultBranch,
	isGitRepo,
	pullFastForwardAsync,
	pushBranchAsync,
	runCommand,
	runCommandAsync,
	workingTreeClean,
} from "./git.js";
import {
	deriveBranchNameWithModel,
	descriptionFromLastAssistant,
	scanForSecrets,
} from "./helpers.js";
import {
	diagnoseAgentEndCompletion,
	diagnoseCommitAbort,
	diagnoseResumeAfterCompaction,
} from "./plan/auto-loop-gates.js";
import {
	awaitCompaction,
	buildPhaseEndSummaryPreamble,
	buildPhaseSliceCompactionResult,
	computeCarryForwardSummaryChars,
	computeContextBuckets,
	DEFAULT_COMPACTION_TIMEOUT_MS,
	DEFAULT_PHASE_TOKENS,
	DEFAULT_SUMMARY_TOKENS,
	DEFAULT_WORKING_TOKENS,
	findLatestCompactionSummary,
	planSummaryContent,
	type SummariseFn,
	shouldCompactMidPhase,
} from "./plan/compaction.js";
import {
	buildCompletionPrompt,
	decideFromCompletionChoice,
	NEW_PLAN_STALE_MESSAGE,
} from "./plan/completion.js";
import { findConnectionError } from "./plan/connection-error.js";
import {
	DEFAULT_DELEGATE_MAX_CHARS,
	DEFAULT_DELEGATE_MAX_CONCURRENT,
	DEFAULT_RESEARCH_TIMEOUT_MS,
	DelegateAgents,
	type ResearchOutcome,
} from "./plan/delegate-tools.js";
import {
	claimPhase,
	evaluateClaim,
	releasePhase,
} from "./plan/driver-claim.js";
import {
	DEFAULT_PARALLELISM,
	DEFAULT_QUEUE_DEPTH_THRESHOLD,
	defaultMailboxDeps as defaultExploreMailboxDeps,
	ExploreMailbox,
	type ExploreNotification,
	type ExploreTask,
	exploreWidgetShouldHide,
	sanitiseParallelism,
	sanitiseQueueDepthThreshold,
} from "./plan/explore-mailbox.js";
import { FleetManager, fleetWouldBeTrivial } from "./plan/fleet-manager.js";
import type { PhaseDriverBadge } from "./plan/panel.js";
import { PlanPanelComponent } from "./plan/panel.js";
import {
	renderParentIssueBody,
	renderPhaseIssueBody,
} from "./plan/park-bodies.js";
import {
	classifyImplementContext,
	type ImplementContext,
	planPickerView,
	shouldFirePicker,
	shouldOfferShiftTabPicker,
	snapshotPlanStructure,
} from "./plan/picker.js";
import {
	type PrSweepResult,
	pickFirstWithFeedback,
	runEndOfPlanPrSweep,
	summarisePrSweep,
} from "./plan/pr-sweep.js";
import {
	abandonNonTerminalPhases,
	blockedReason,
	chainHead,
	effectiveDependsOn,
	effectivePhaseKind,
	effectiveTaskKind,
	type ImplementBranchPlan,
	isPhaseReady,
	matchPhaseId,
	type Plan,
	type Phase as PlanPhase,
	planImplementBranch,
	readyPhases,
	repoNameFromPath,
	slugify,
	type Task,
	TERMINAL_STATUSES,
	WORKTREE_STATUSES,
} from "./plan/schema.js";
import { type ScrutinyFinding, scrutinizePlan } from "./plan/scrutinize.js";
import { PLAN_SEED_CUSTOM_TYPE, seedPlanDoc } from "./plan/seed.js";
import { SharedOverviewService } from "./plan/shared-overview-service.js";
import {
	probeOpenPrForBranch,
	probePrByNumber,
	shipPhase,
} from "./plan/ship.js";
import {
	STEERING_CLASSIFIER,
	shouldInjectSteeringClassifier,
} from "./plan/steering.js";
import {
	deletePlan,
	loadPlan,
	planExists,
	savePlan,
	withPlanLock,
} from "./plan/storage.js";
import { aggregateAssistantUsage, fromAiUsage } from "./plan/token-usage.js";
import { registerPlanTools } from "./plan/tools.js";
import {
	buildTransitionOptions,
	decideFromChoice,
	type TransitionDecision,
} from "./plan/transition.js";
import { isWorker } from "./plan/worker-protocol.js";
import {
	createWorktree,
	effectiveWorktreePath,
	removeWorktree,
	worktreeExists,
	worktreePath,
} from "./plan/worktree.js";
import type { AgentRow } from "./sidebar/agents.js";
import type { SidebarEnv } from "./sidebar/info.js";
import { loadNotes, saveNotes } from "./sidebar/notes-store.js";
import { SidebarComponent } from "./sidebar/shell.js";

const EXT_ID = "modes";
const STATE_ENTRY = "modes-state";
const CUSTOM_MODE_CONTEXT = "modes-context";

/** Default min terminal width for the overlay sidebar (see `sidebar.minCols`). */
const DEFAULT_SIDEBAR_MIN_COLS = 120;

// Tools available in plan mode. edit/write are absent entirely.
export const PLAN_ONLY_TOOLS = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"websearch",
	"webfetch",
	"ask",
	"delegate",
] as const;

/**
 * Pure helper: compute the tool list for a given mode and prior-tools
 * snapshot. Extracted so the filtering logic can be unit-tested without
 * a live pi host.
 */
export function computeActiveTools(mode: Mode, priorTools: string[]): string[] {
	const planTools = ["phase", "task", "plan"];
	if (mode === "plan") {
		return [...PLAN_ONLY_TOOLS, ...planTools];
	}
	// Restore prior tools and ensure phase/task/plan + delegate are present.
	// delegate works in every mode (researcher target); explorer routing is
	// gated to plan mode at execute time.
	const alwaysInclude = [...planTools, "delegate"];
	const extra = alwaysInclude.filter((t) => !priorTools.includes(t));
	return [...priorTools, ...extra];
}

/**
 * Transitions `state.mode` to `implementMode` and immediately applies the
 * resulting tool set via `setActiveTools`. Extracted from `launchExecution`
 * so the plan→executing tool-restoration step is unit-testable without a
 * live pi host.
 */
export function applyExecutionMode(
	state: { mode: string; priorTools: string[] },
	implementMode: ImplementMode,
	setActiveTools: (tools: string[]) => void,
): void {
	state.mode = implementMode;
	setActiveTools(computeActiveTools(implementMode, state.priorTools));
}

// ---- Types ----------------------------------------------------------------

type Mode = "plan" | "auto" | "ask" | "hack";

const ALL_MODES: readonly Mode[] = ["plan", "auto", "ask", "hack"] as const;

// Module-level guard so the process-level crash handler is registered
// exactly once even if the extension factory is re-evaluated (hot
// reload, multiple registrations). Without this, every re-evaluation
// would attach a new pair of `uncaughtExceptionMonitor` /
// `unhandledRejection` listeners and we'd produce duplicate crash
// reports + extra disk I/O on a real crash.
let crashHandlerDispose: (() => void) | null = null;

/**
 * Validate an extensionConfig.modes.mode.default value. Falls back to
 * "plan" on missing/invalid input. Caller is responsible for surfacing
 * a notify when `valid` is false.
 */
export function resolveDefaultMode(raw: unknown): {
	mode: Mode;
	valid: boolean;
} {
	if (raw === undefined || raw === null) return { mode: "plan", valid: true };
	if (typeof raw !== "string") return { mode: "plan", valid: false };
	if ((ALL_MODES as readonly string[]).includes(raw)) {
		return { mode: raw as Mode, valid: true };
	}
	return { mode: "plan", valid: false };
}

export type ImplementMode = "auto" | "ask";

const IMPLEMENT_MODES: readonly ImplementMode[] = ["auto", "ask"] as const;

/**
 * Validate an extensionConfig.modes.implement.default value. Falls back
 * to "auto" on missing/invalid input — the picker's auto-first ordering
 * matches the documented default mode story.
 */
export function resolveImplementDefault(raw: unknown): {
	mode: ImplementMode;
	valid: boolean;
} {
	if (raw === undefined || raw === null) return { mode: "auto", valid: true };
	if (typeof raw !== "string") return { mode: "auto", valid: false };
	if ((IMPLEMENT_MODES as readonly string[]).includes(raw)) {
		return { mode: raw as ImplementMode, valid: true };
	}
	return { mode: "auto", valid: false };
}

/**
 * Derive the effective implement mode for a given session mode.
 *
 * - `ask` / `auto` → preserve as-is (user already chose a deliberate mode)
 * - anything else (plan, hack, null) → fall back to the config default
 *
 * This is pure so it can be tested without a running session.
 */
export function resolveImplementModeForCurrentMode(
	currentMode: string | null | undefined,
	defaultMode: ImplementMode,
): ImplementMode {
	if (currentMode === "ask" || currentMode === "auto") return currentMode;
	// hack maps to auto: ImplementMode is "auto" | "ask" only, and hack
	// semantics are closest to auto (no plan ceremony, full tool access).
	if (currentMode === "hack") return "auto";
	return defaultMode;
}

type Stage =
	| "idle"
	| "planning"
	| "awaiting-choice"
	| "executing"
	| "reviewing"
	| "fixing"
	| "exec-complete";

/**
 * Persisted per-session state. Plan/phase/task data lives in `~/.pi/plans/`;
 * `currentPlanSlug` is the slug of the plan this session is working on.
 */
interface ModeState {
	mode: Mode;
	stage: Stage;
	/** Feature branch being implemented on; null until /implement runs. */
	branch: string | null;
	/** Default branch we synced from; used as base for new branches. */
	defaultBranch: string | null;
	/**
	 * Tools active before modes restricted them. Restored when leaving
	 * plan mode. Captured once at first activation.
	 */
	priorTools: string[];
	/** Snapshot of last assistant plan text; used by /park. */
	planText: string | null;
	/** Plan slug this session is currently working on; null if none. */
	currentPlanSlug: string | null;
}

/** Custom entry type for persisted Q&A pairs. */
export const ASK_ANSWERS_ENTRY = "modes-ask-answers";

/** A question queued by the `ask` tool. */
export interface PendingQuestion {
	id: string;
	question: string;
	options?: string[];
	context?: string;
}

/** Persisted Q&A pair. */
export interface QAPair {
	question: string;
	answer: string;
}

// ---- Extension ------------------------------------------------------------

export default defineExtension(
	{
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Permission-mode cycle (plan / ask / auto) with integrated git workflow.",
		integratesWith: ["commit", "review"],
		configSchema: [
			{
				key: "park.githubProject",
				type: "string",
				doc: "GitHub Project title to assign issues to when /park creates them. Leave unset to skip project assignment.",
			},
			{
				key: "compaction.phaseTokens",
				type: "number",
				default: DEFAULT_PHASE_TOKENS,
				doc: "Safety maxTokens cap for a single phase-boundary summary. `compaction.summaryTokens` is the cumulative soft budget across all summaries; this only prevents one summariser call from producing an unexpectedly large section. Default 10000.",
			},
			{
				key: "compaction.workingTokens",
				type: "number",
				default: DEFAULT_WORKING_TOKENS,
				doc: "Working budget covering `sys + work` (system prompt + tool schemas + live messages). Mid-phase compaction fires when this is exceeded. Summary tokens live in their own budget (`summaryTokens`) and don't count toward this trigger. Default 150000.",
			},
			{
				key: "compaction.summaryTokens",
				type: "number",
				default: DEFAULT_SUMMARY_TOKENS,
				doc: "Cumulative rolling-summary budget. Each plan→implement / phase-slice / phase-end compaction adds to the summary. Soft-warns once when exceeded; not enforced. Total target ceiling = `workingTokens + summaryTokens` — should fit the active model's `contextWindow`. Default 100000.",
			},
			{
				key: "compaction.planMaxContextTokens",
				type: "number",
				doc: "Optional context-window size (tokens) used only for the plan-mode footer usage gauge. Leave unset to use the active model's full context window. Plan mode never auto-compacts.",
			},
			{
				key: "compaction.timeoutMs",
				type: "number",
				default: DEFAULT_COMPACTION_TIMEOUT_MS,
				doc: "Deadline for a single mid-phase compaction. pi's compaction is fire-and-forget; if its summariser stalls, the turn_end hook would await forever and wedge the agent 'working' with no way to interrupt. On timeout modes stops awaiting, warns, and lets pi auto-compaction handle the next overflow. Default 90000.",
			},
			{
				key: "mode.default",
				type: "enum",
				enumValues: ALL_MODES,
				default: "plan",
				doc: "Mode for fresh sessions: plan | auto | ask | hack. Existing persisted sessions keep their saved mode.",
			},
			{
				key: "implement.default",
				type: "enum",
				enumValues: IMPLEMENT_MODES,
				default: "auto",
				doc: "Default option highlighted in the /implement picker: auto | ask. `auto` chugs through commit/ship/next phase autonomously; `ask` pauses at git boundaries. Set to `ask` if you want a human-in-the-loop default.",
			},
			{
				key: "planPanel",
				type: "enum",
				enumValues: ["auto", "overlay", "off"],
				default: "auto",
				doc: "How the plan is displayed. `auto` (default) and `overlay`: an always-on floating top-right panel listing every phase with a per-phase `[done/total]` task tally, the active phase expanded. `off` hides it. The panel auto-hides on terminals narrower than 100 columns.",
			},
			{
				key: "sidebar.minCols",
				type: "number",
				default: DEFAULT_SIDEBAR_MIN_COLS,
				doc: "Minimum terminal width (columns) for the overlay sidebar (Info/Plan/Notes). Below this it auto-hides so it never crushes a narrow pane, regardless of the show/hide toggle. Toggle the sidebar with the `/sidebar` command or ctrl+shift+b. Override via env `PI_MODES_SIDEBAR_MIN_COLS`. Default 120.",
			},
			{
				key: "research.timeoutMs",
				type: "number",
				default: DEFAULT_RESEARCH_TIMEOUT_MS,
				doc: 'Hard timeout (ms) for `delegate(to: "researcher")` calls. On timeout the tool returns a structured failure shape so the agent can recover. Per-call `timeoutMs` overrides this. Default 120000 (120s).',
			},
			{
				key: "delegate.maxAnswerChars",
				type: "number",
				default: DEFAULT_DELEGATE_MAX_CHARS,
				doc: "Safety backstop (characters) on a delegated answer before it crosses back into the caller's context. Subagents are still prompted to be concise and complete; this only catches runaways. Default 6000.",
			},
			{
				key: "delegate.maxConcurrent",
				type: "number",
				default: DEFAULT_DELEGATE_MAX_CONCURRENT,
				doc: 'Cap on concurrent researcher subprocesses spawned by `delegate(to: "researcher")`. Backpressure for a burst of parallel calls. Must be >= 1; fractional or smaller values fall back to the default. Default 10.',
			},
			{
				key: "explore.parallelism",
				type: "number",
				default: DEFAULT_PARALLELISM,
				doc: "Maximum simultaneous codebase-explore jobs across the persistent seed agent and clean ephemeral children. This is a numeric cap, not a boolean. Positive integers only; other values fall back to the default. Default 2.",
			},
			{
				key: "explore.queueDepthThreshold",
				type: "number",
				default: DEFAULT_QUEUE_DEPTH_THRESHOLD,
				doc: "Queued/running seed-task depth at which explore may fan out to child workers up to `explore.parallelism`. Positive integers only. Default 4.",
			},
			{
				key: "model",
				type: "string",
				fallbackChain:
					"extensionConfig.modes.model → backgroundModels.primary.normal → session model",
				doc: "Model for the plan/phase worker sub-agents and phase-boundary compaction summaries (both normal-tier background work). Leave unset to use backgroundModels.primary.normal, then the session model.",
			},
		],
	},
	(pi: ExtensionAPI) => {
		// ---- In-memory state --------------------------------------------------

		let modeState: ModeState | null = null;

		// Latest SessionManager seen by /implement. Captured here so the
		// process-level crash handler can pull recent session entries
		// without needing a per-command `ctx`. Reset on session_shutdown.
		let crashSessionAccessor: SessionAccessor | null = null;

		// Stored TUI instance from the footer factory, used to trigger re-renders
		// when the mode changes without reinstalling the footer, and to mount the
		// floating plan panel overlay (showOverlay lives on the TUI).
		let footerTui: TUI | null = null;

		// Floating plan panel (top-right overlay). Mounted in plan mode via the
		// mode-aware display controller; torn down on mode switch / shutdown.
		let planPanel: PlanPanelComponent | null = null;
		let planPanelHandle: OverlayHandle | null = null;
		// Latest ctx seen by updateWidget — the attach callback (bound once at
		// panel creation) reads this so session-switching never uses a ctx that
		// went stale across a mode/session transition.
		let planPanelCtx: ExtensionContext | null = null;
		// Theme captured from the footer factory — needed to style the overlay,
		// whose Component.render only receives a width.
		let panelTheme: Theme | null = null;

		// Overlay sidebar (Info/Plan/Notes). Opt-in: hidden until toggled on via
		// `/sidebar` or ctrl+shift+b. The toggle state is per-session (in-memory for the
		// life of this session); durable persistence arrives with the notes box.
		let sidebar: SidebarComponent | null = null;
		let sidebarHandle: OverlayHandle | null = null;
		let sidebarEnabled = false;
		// Shared plan view powering the sidebar's Plan box (created lazily on mount).
		let sidebarPlanPanel: PlanPanelComponent | null = null;
		// Free-text Notes box content, persisted per session. Loaded lazily the
		// first time the sidebar mounts or the editor opens; null = not yet loaded.
		let sidebarNotes: string | null = null;
		// Live `/implement --fanout` fleet, captured so the sidebar Info box can
		// list its workers. Set when the orchestrator starts, cleared when it ends.
		let activeFleet: FleetManager | null = null;

		// Persistent codebase-explore mailbox and web-research sub-agent.
		// Created lazily on first tool call; disposed when leaving plan mode,
		// on /implement, or on session shutdown.
		let delegateAgents: DelegateAgents | null = null;
		let exploreMailbox: ExploreMailbox | null = null;
		let exploreOverviewService: SharedOverviewService | null = null;

		// Install the process-level crash handler once per process. The
		// handler is a no-op outside `executing` stage, so plan/ask/hack
		// turns aren't instrumented. See `crash-report.ts` for the safety
		// contract. Module-level guard prevents duplicate listeners on
		// factory re-evaluation; the previous handler (if any) is disposed
		// so the new one observes fresh closures over `modeState` etc.
		if (crashHandlerDispose) {
			try {
				crashHandlerDispose();
			} catch {
				/* best-effort */
			}
			crashHandlerDispose = null;
		}
		crashHandlerDispose = installCrashHandler({
			getModeSnapshot: () => ({
				mode: modeState?.mode ?? null,
				stage: modeState?.stage ?? null,
				branch: modeState?.branch ?? null,
				planSlug: modeState?.currentPlanSlug ?? null,
				activePhaseId:
					activePhase(
						modeState?.currentPlanSlug
							? loadPlan(modeState.currentPlanSlug)
							: null,
					)?.id ?? null,
			}),
			getSessionAccessor: () => crashSessionAccessor,
		});

		function ensureDelegateAgents(ctx: ExtensionContext): DelegateAgents {
			if (!delegateAgents) {
				delegateAgents = new DelegateAgents(ctx);
				// Mirror research activity into the sidebar Info box (live).
				delegateAgents.setOnResearchChange(() => refreshSidebar(ctx));
				// When the sidebar is shown it owns sub-agent state, so the
				// below-editor research widget stands down to avoid duplication.
				delegateAgents.setWidgetSuppressed(() => sidebarEnabled);
			}
			return delegateAgents;
		}

		function ensureExploreOverviewService(): SharedOverviewService {
			if (!exploreOverviewService) {
				exploreOverviewService = new SharedOverviewService();
			}
			return exploreOverviewService;
		}

		function ensureExploreMailbox(ctx: ExtensionContext): ExploreMailbox {
			if (!exploreMailbox) {
				const opts = readExploreSettings(ctx);
				exploreMailbox = new ExploreMailbox(
					ctx,
					{
						...defaultExploreMailboxDeps(),
						getOverview: () => ensureExploreOverviewService().get(ctx),
					},
					opts,
				);
				exploreMailbox.onChange((state) => renderExploreWidget(ctx, state));
			}
			return exploreMailbox;
		}

		function disposeDelegateAgents(ctx?: ExtensionContext): void {
			if (delegateAgents) {
				void delegateAgents.dispose().catch(() => {});
				delegateAgents = null;
			}
			if (exploreMailbox) {
				const m = exploreMailbox;
				exploreMailbox = null;
				void m.dispose().catch(() => {});
			}
			if (ctx?.hasUI) ctx.ui.setWidget("delegate-explore", undefined);
		}

		function renderExploreWidget(
			ctx: ExtensionContext,
			state: { tasks: ExploreTask[]; notifications: ExploreNotification[] },
		): void {
			if (!ctx.hasUI) return;
			// Mirror explore activity into the sidebar Info box (live).
			refreshSidebar(ctx);
			// Sidebar owns this data when shown — keep the area under the editor clear.
			if (sidebarEnabled) {
				ctx.ui.setWidget("delegate-explore", undefined);
				return;
			}
			const running = state.tasks.filter((t) => t.status === "running").length;
			const queued = state.tasks.filter((t) => t.status === "queued").length;
			// Hide when no active work remains: empty mailbox, all tasks settled
			// (done/error/timeout), and no pending notifications. Completed tasks
			// no longer linger in the panel after the explore loop drains.
			if (exploreWidgetShouldHide(state.tasks, state.notifications)) {
				ctx.ui.setWidget("delegate-explore", undefined);
				return;
			}
			const header = `🔍 Explore (${running} running, ${queued} queued)`;
			const rows: string[] = [header];
			for (const t of state.tasks) {
				rows.push(
					`  ${statusGlyph(t.status)} ${t.id}: ${truncate(t.question, 56)}` +
						(t.status === "running" && t.lastToolSummary
							? `  · ${t.lastToolSummary}`
							: ""),
				);
			}
			for (const n of state.notifications.slice(-3)) {
				rows.push(
					`  💬 ${n.kind ? `[${n.kind}] ` : ""}${truncate(n.text, 64)}`,
				);
			}
			ctx.ui.setWidget("delegate-explore", rows);
		}

		function statusGlyph(s: ExploreTask["status"]): string {
			switch (s) {
				case "queued":
					return "⌛";
				case "running":
					return "⏳";
				case "done":
					return "🟢";
				case "error":
					return "❌";
				case "timeout":
					return "⏱";
			}
		}

		function truncate(s: string, n: number): string {
			const flat = s.replace(/\s+/g, " ").trim();
			return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
		}

		// Questions queued by the `ask` tool during a single agent turn.
		let pendingQuestions: PendingQuestion[] = [];
		let nextQuestionId = 1;

		// True when the user typed a free-text auto-mode message that should
		// receive the routing classifier. Set in the `input` handler and
		// consumed (cleared) in the next `before_agent_start`. Lives off the
		// session so it doesn't survive restarts — the classifier is only
		// useful for the immediate next turn.
		let pendingSteeringClassifier = false;

		// Snapshot of the plan structure at the start of the current plan-mode
		// turn. Used by the agent_end picker gate to decide whether the plan
		// changed during the turn (in which case we owe the user a decision)
		// or stayed put (just discussion — leave them alone).
		//
		// Lifecycle:
		//   - Captured in before_agent_start when null and mode is plan.
		//     Conditional capture preserves the snapshot across `ask`-tool
		//     question rounds so the picker fires once with the cumulative
		//     diff, not once per round.
		//   - Reset to null when the picker fires (next plan-build cycle
		//     starts fresh).
		//   - Reset to null when leaving plan mode and when the active plan
		//     slug changes — both invalidate any stored structure.
		let planTurnSnapshot: string | null = null;

		// Pinned sys token count derived from the first real API response.
		// Null until the first turn completes; reset on session start.
		// Avoids chars/4 error for JSON-heavy tool schemas (2–3 chars/token).
		let pinnedSysTokens: number | null = null;

		function clearPlanTurnSnapshot(): void {
			planTurnSnapshot = null;
		}

		// ---- Persistence ------------------------------------------------------

		function persist(): void {
			if (!modeState) return;
			pi.appendEntry(STATE_ENTRY, modeState satisfies ModeState);
			setActiveMode(modeState.mode);
		}

		/**
		 * Stamp the active session as this plan's planning session if no
		 * `planSessionPath` is recorded yet. Idempotent: re-running `/plan`
		 * on a plan whose path is already set is a no-op (we don't want to
		 * overwrite the original planning session with whatever session
		 * happens to be active now).
		 *
		 * Best-effort: silently skips if `getSessionFile()` returns undefined
		 * (ephemeral session) or the plan can't be loaded.
		 */
		function recordPlanSessionPathIfMissing(
			ctx: ExtensionContext,
			slug: string,
		): void {
			const plan = loadPlan(slug);
			if (!plan) return;
			if (plan.planSessionPath) return;
			const path = ctx.sessionManager.getSessionFile();
			if (!path) return;
			plan.planSessionPath = path;
			plan.updatedAt = new Date().toISOString();
			savePlan(plan);
		}

		function hydrateMode(ctx: ExtensionContext): void {
			let latest: ModeState | undefined;
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
					latest = entry.data as ModeState;
				}
			}
			// Migrate persisted state from old mode names. "default" was the
			// original name for hack; map forward to keep stale sessions
			// loadable. We used to map "ask" → "hack" too, back when ask was
			// removed; now ask is a real mode again, so it stays as-is.
			if (latest && (latest.mode as string) === "default") {
				latest.mode = "hack";
			}
			modeState = latest ?? null;
			setActiveMode(modeState?.mode ?? null);
		}

		/**
		 * Hydrate the current plan slug from modeState. The actual plan data
		 * lives in `~/.pi/plans/<slug>/plan.json` and is loaded on demand.
		 * If modeState has a slug but the plan file is gone (deleted manually),
		 * we clear the slug.
		 *
		 * No cross-session fallback: we deliberately do NOT consult
		 * activePlanForRepo() here. Plans are session-owned. A continued
		 * session (`pi -c`, /resume, /fork) keeps its binding because
		 * `currentPlanSlug` lives in STATE_ENTRY and rides the session JSONL.
		 * A genuinely fresh `pi` starts unbound — the user runs `/plan` to
		 * create a new plan or `/plan resume <slug>` to attach to one from
		 * another session.
		 */
		function hydratePlan(_ctx?: ExtensionContext): void {
			if (!modeState) return;
			if (modeState.currentPlanSlug && !planExists(modeState.currentPlanSlug)) {
				modeState.currentPlanSlug = null;
				persist();
			}
		}

		/** Load the current plan from disk, or null if none active. */
		function currentPlan(): Plan | null {
			const slug = modeState?.currentPlanSlug;
			return slug ? loadPlan(slug) : null;
		}

		/** All tasks across all phases of a plan. */
		function allTasks(plan: Plan | null): Array<{
			phase: PlanPhase;
			task: { id: string; title: string; body: string; done: boolean };
		}> {
			if (!plan) return [];
			return plan.phases.flatMap((phase) =>
				phase.tasks.map((task) => ({ phase, task })),
			);
		}

		/**
		 * The phase currently in flight — status `active` or `needs-attention`.
		 * At most one such phase exists at a time. Used to scope execution
		 * prompts and completion checks so the agent doesn't try to ship
		 * everything in one session.
		 */
		function activePhase(plan: Plan | null): PlanPhase | null {
			if (!plan) return null;
			return (
				plan.phases.find((p) => WORKTREE_STATUSES.includes(p.status)) ?? null
			);
		}

		/**
		 * Tasks of the active phase only. This is what /implement, ask-mode,
		 * and auto-mode prompts consume — we deliberately do NOT flatten
		 * tasks across phases here, so the agent works on one phase at a
		 * time and `/ship` has a clear per-phase boundary.
		 */
		function activeTasks(plan: Plan | null): Array<{
			phase: PlanPhase;
			task: Task;
		}> {
			const phase = activePhase(plan);
			if (!phase) return [];
			return phase.tasks.map((task) => ({ phase, task }));
		}

		/**
		 * Ensure there's a plan for this repo and return its slug. Reuses the
		 * most recently updated active plan if one exists; otherwise creates a
		 * fresh empty plan with a default title.
		 */
		async function doPlanList(ctx: ExtensionContext): Promise<void> {
			const { listPlans } = await import("./plan/storage.js");
			const { renderPlanListView } = await import("./plan/list-view.js");
			const entries = listPlans();
			if (entries.length === 0) {
				notify(ctx, "no plans yet", "info");
				return;
			}
			// Load each plan from disk so the formatter can inspect phases for
			// the stuck-classification. Skipping malformed entries silently —
			// rebuildIndex already filters most, but loadPlan() can still race a
			// concurrent /plan delete.
			const plans: Plan[] = [];
			for (const entry of entries) {
				const plan = loadPlan(entry.slug);
				if (plan) plans.push(plan);
			}
			const lines = renderPlanListView({
				plans,
				currentSessionId: ctx.sessionManager.getSessionId(),
				currentCwd: ctx.cwd,
			});
			notify(ctx, lines.join("\n"), "info");
		}

		async function doPlanResume(
			slug: string,
			ctx: ExtensionCommandContext,
		): Promise<void> {
			// Only accept slugs that the index already knows about — prevents
			// /plan resume from acting as an arbitrary-path probe.
			const { listPlans } = await import("./plan/storage.js");
			const known = listPlans().some((p) => p.slug === slug);
			if (!known) {
				notify(ctx, `plan ${slug} not found`, "error");
				return;
			}
			const plan = loadPlan(slug);
			if (!plan) {
				notify(ctx, `plan ${slug} not found`, "error");
				return;
			}
			if (plan.repo.path !== ctx.cwd) {
				notify(
					ctx,
					`plan ${slug} belongs to ${plan.repo.path} — cannot resume from ${ctx.cwd}`,
					"warning",
				);
				return;
			}

			// Cross-session adoption: prompt before binding a plan owned by
			// another session. Same-session rebinds (slug already in seenIn)
			// and legacy plans (no createdBy) skip the confirm.
			const sessionId = ctx.sessionManager.getSessionId();
			const owner = plan.createdBy?.sessionId;
			const alreadySeen = plan.seenIn?.includes(sessionId) ?? false;
			const isCrossSession =
				owner !== undefined && owner !== sessionId && !alreadySeen;
			if (isCrossSession && ctx.hasUI) {
				const ownerLabel =
					plan.createdBy?.sessionName?.trim() || `${owner.slice(0, 8)}…`;
				const ok = await ctx.ui.confirm(
					"Adopt plan from another session?",
					`Plan \`${slug}\` was created in session ${ownerLabel}. Adopt it in this session?`,
				);
				if (!ok) {
					notify(ctx, `aborted resume of ${slug}`, "info");
					return;
				}
			}

			if (!alreadySeen) {
				plan.seenIn = [...(plan.seenIn ?? []), sessionId];
				plan.updatedAt = new Date().toISOString();
				savePlan(plan);
			}

			// If the plan has a recorded planning-session path and we're not
			// already in it, switch sessions before flipping mode/state. The
			// post-switch work runs inside `withSession` because pi invalidates
			// the previous ctx after replacement.
			const targetPath = plan.planSessionPath;
			const currentPath = ctx.sessionManager.getSessionFile();
			if (targetPath && targetPath !== currentPath) {
				await ctx.switchSession(targetPath, {
					withSession: async (newCtx) => {
						applyPlanResumeState(newCtx, plan, slug);
					},
				});
				return;
			}

			applyPlanResumeState(ctx, plan, slug);
		}

		function applyPlanResumeState(
			ctx: ExtensionContext,
			plan: Plan,
			slug: string,
		): void {
			if (!modeState) {
				modeState = {
					mode: "plan",
					stage: "idle",
					branch: null,
					defaultBranch: detectDefaultBranch(ctx.cwd),
					priorTools: pi.getActiveTools(),
					planText: null,
					currentPlanSlug: slug,
				};
			} else if (modeState.currentPlanSlug !== slug) {
				modeState.currentPlanSlug = slug;
				// Switching plans invalidates any structure snapshot from the
				// previous plan — a diff against it would mean nothing.
				clearPlanTurnSnapshot();
			}
			persist();
			updateWidget(ctx);
			notify(
				ctx,
				`resumed plan ${slug} (${plan.phases.length} phases)`,
				"info",
			);
		}

		/**
		 * Hard-delete a plan: remove `~/.pi/plans/<slug>/` and rebuild the
		 * index. Refuses if any worktree associated with the plan is still
		 * dirty — the user has unsaved changes there and we won't risk them.
		 * Confirms before mutating; on success, also clears the binding if the
		 * deleted plan was bound to this session.
		 *
		 * Worktrees themselves are NOT removed by this command: deleting a
		 * plan from `~/.pi/plans/` doesn't touch the git worktree at
		 * `worktrees/<repo>/<plan>/<phase>/`. Users should `/worktree prune`
		 * first to clean those up; we just block the destructive case where
		 * an unprune-able worktree is still dirty.
		 */
		async function doPlanDelete(
			slug: string,
			ctx: ExtensionCommandContext,
		): Promise<void> {
			const { listPlans } = await import("./plan/storage.js");
			const known = listPlans().some((p) => p.slug === slug);
			if (!known) {
				notify(ctx, `plan ${slug} not found`, "error");
				return;
			}
			const plan = loadPlan(slug);
			if (!plan) {
				notify(ctx, `plan ${slug} not found`, "error");
				return;
			}

			const dirtyPhases = plan.phases.filter((phase) => {
				if (!worktreeExists(plan, phase)) return false;
				return !workingTreeClean(phase.worktreePath ?? plan.repo.path);
			});
			if (dirtyPhases.length > 0) {
				const names = dirtyPhases.map((p) => p.id).join(", ");
				notify(
					ctx,
					`refusing to delete ${slug}: dirty worktree(s) for ${names}. ` +
						`Commit/stash and run /worktree prune first.`,
					"warning",
				);
				return;
			}

			const confirmed = await ctx.ui.confirm(
				`Delete plan ${slug}?`,
				`This removes the plan directory under <agent-dir>/plans/${slug}/ permanently. ` +
					`Worktrees and branches are not touched. This cannot be undone.`,
			);
			if (!confirmed) {
				notify(ctx, `aborted delete of ${slug}`, "info");
				return;
			}

			deletePlan(slug);

			if (modeState?.currentPlanSlug === slug) {
				modeState.currentPlanSlug = null;
				clearPlanTurnSnapshot();
				persist();
			}
			updateWidget(ctx);
			notify(ctx, `deleted plan ${slug}`, "info");
		}

		/**
		 * Soft archive: mark every non-terminal phase as `abandoned` and let
		 * `reconcileWorktrees` tear down any worktrees that no longer have a
		 * status requiring them. The plan stays on disk for history; it just
		 * stops being "active" so /plan list can demote it.
		 *
		 * Branches are kept (worktree.ts policy: branches are never
		 * auto-deleted). Use /plan delete to fully remove the plan.
		 */
		async function doPlanArchive(
			slug: string,
			ctx: ExtensionContext,
		): Promise<void> {
			const { listPlans } = await import("./plan/storage.js");
			const known = listPlans().some((p) => p.slug === slug);
			if (!known) {
				notify(ctx, `plan ${slug} not found`, "error");
				return;
			}
			const plan = loadPlan(slug);
			if (!plan) {
				notify(ctx, `plan ${slug} not found`, "error");
				return;
			}

			const nonTerminal = plan.phases.filter(
				(p) => !TERMINAL_STATUSES.includes(p.status),
			);
			if (nonTerminal.length === 0) {
				notify(
					ctx,
					`plan ${slug} has no non-terminal phases — nothing to archive`,
					"info",
				);
				return;
			}

			const confirmed = await ctx.ui.confirm(
				`Archive plan ${slug}?`,
				`This marks ${nonTerminal.length} non-terminal phase(s) as abandoned ` +
					`and tears down their worktrees. Branches are kept. The plan stays on disk.`,
			);
			if (!confirmed) {
				notify(ctx, `aborted archive of ${slug}`, "info");
				return;
			}

			const now = new Date().toISOString();
			const { plan: archivedPlan, archived } = abandonNonTerminalPhases(
				plan,
				now,
			);
			savePlan(archivedPlan);
			if (reconcileWorktrees(archivedPlan, ctx)) savePlan(archivedPlan);

			if (modeState?.currentPlanSlug === slug) {
				// Bound plan was archived: keep the binding so the user can still
				// see the (now-terminal) phases via /modes-status, but refresh the
				// widget so the active-phase task list disappears.
				updateWidget(ctx);
			} else {
				updateWidget(ctx);
			}
			notify(
				ctx,
				`archived plan ${slug} (${archived.length} phase(s) abandoned)`,
				"info",
			);
		}

		/**
		 * Resolve the plan slug this session should bind to.
		 *
		 * Session-ownership semantics: if the current session already has a
		 * plan slug bound (in modeState), reuse it — that's the
		 * pi -c / /resume / /fork case where the binding rides along in
		 * STATE_ENTRY. Otherwise create a *fresh* plan stamped with this
		 * session's identity. We deliberately do NOT fall back to
		 * activePlanForRepo() here: a fresh `pi` (no session continuation)
		 * starts a new plan rather than silently inheriting a sibling
		 * session's work. To attach to an existing plan, the user runs
		 * /plan resume <slug>.
		 */
		function ensurePlanForRepo(ctx: ExtensionContext): string {
			const sm = ctx.sessionManager;
			const sessionId = sm.getSessionId();

			const existing = modeState?.currentPlanSlug;
			if (existing && planExists(existing)) {
				// Backfill seenIn if the bound plan predates ownership tracking
				// or somehow lost its membership. Cheap, idempotent.
				const plan = loadPlan(existing);
				if (plan && !plan.seenIn?.includes(sessionId)) {
					plan.seenIn = [...(plan.seenIn ?? []), sessionId];
					plan.updatedAt = new Date().toISOString();
					savePlan(plan);
				}
				return existing;
			}

			const now = new Date().toISOString();
			const repoName = repoNameFromPath(ctx.cwd);
			const datestamp = now.slice(0, 10).replace(/-/g, "");
			// Pick a unique-ish slug — ${repo}-${date}, with -2, -3 suffix on collision.
			let slug = `${slugify(repoName)}-${datestamp}`;
			let n = 2;
			while (planExists(slug)) {
				slug = `${slugify(repoName)}-${datestamp}-${n}`;
				n++;
			}
			const sessionName = sm.getSessionName?.() ?? undefined;
			const sessionFile = sm.getSessionFile?.() ?? undefined;
			const plan: Plan = {
				slug,
				title: `Plan for ${repoName}`,
				repo: { path: ctx.cwd },
				schemaVersion: 2,
				phases: [],
				followUps: [],
				createdBy: {
					sessionId,
					...(sessionName ? { sessionName } : {}),
					...(sessionFile ? { sessionFile } : {}),
				},
				seenIn: [sessionId],
				createdAt: now,
				updatedAt: now,
			};
			savePlan(plan);
			return slug;
		}

		/**
		 * Reconcile worktrees with phase statuses.
		 *
		 * Invariant: a phase has a worktree iff its status is active or
		 * needs-attention. This function brings the filesystem in line with
		 * the plan after any mutation.
		 */
		/**
		 * Reconcile worktrees with phase statuses.
		 *
		 * Invariant: a phase has a worktree iff its status is active or
		 * needs-attention, and `phase.worktreePath` records where it lives.
		 * This function brings the filesystem and the plan in line after
		 * any mutation, persisting the resolved path on the phase.
		 *
		 * Returns true if the plan was mutated and should be saved.
		 */
		function reconcileWorktrees(plan: Plan, ctx: ExtensionContext): boolean {
			const defaultBranch =
				modeState?.defaultBranch ??
				detectDefaultBranch(plan.repo.path) ??
				"main";
			let mutated = false;
			for (const phase of plan.phases) {
				const shouldExist = WORKTREE_STATUSES.includes(phase.status);
				const exists = worktreeExists(plan, phase);

				if (shouldExist && !exists) {
					if (!workingTreeClean(plan.repo.path)) {
						notify(
							ctx,
							`cannot create worktree for phase ${phase.id}: main has uncommitted changes — commit or stash first`,
							"warning",
						);
						continue;
					}
					const result = createWorktree(plan, phase, defaultBranch);
					if (!result.ok) {
						notify(
							ctx,
							`worktree create for ${phase.id} failed: ${result.error}`,
							"warning",
						);
						continue;
					}
					if (phase.worktreePath !== result.path) {
						phase.worktreePath = result.path;
						mutated = true;
					}
					if (result.created) {
						notify(ctx, `worktree ready: ${result.path}`, "info");
					}
				} else if (!shouldExist && exists) {
					const result = removeWorktree(plan, phase);
					if (!result.ok) {
						if (result.reason === "dirty") {
							notify(
								ctx,
								`worktree for ${phase.id} not removed (uncommitted changes at ${phase.worktreePath ?? worktreePath(plan, phase)})`,
								"warning",
							);
						} else if (result.reason === "main") {
							// Branch lives in the main repo — nothing to remove.
							// Just clear the persisted path so the phase no longer
							// claims a worktree.
							if (phase.worktreePath !== undefined) {
								phase.worktreePath = undefined;
								mutated = true;
							}
						} else {
							notify(
								ctx,
								`worktree remove for ${phase.id} failed: ${result.error}`,
								"warning",
							);
						}
					} else if (phase.worktreePath !== undefined) {
						phase.worktreePath = undefined;
						mutated = true;
					}
				}
			}
			return mutated;
		}

		// ---- UI helpers -------------------------------------------------------

		function notify(
			ctx: ExtensionContext,
			msg: string,
			level: "info" | "warning" | "error" = "info",
		): void {
			if (ctx.hasUI) ctx.ui.notify(`modes: ${msg}`, level);
		}

		// Mode display labels and their theme colour tokens.
		const MODE_LABELS: Record<Mode, string> = {
			plan: "plan",
			auto: "auto",
			ask: "ask",
			hack: "hack",
		};
		const MODE_COLORS: Record<
			Mode,
			"warning" | "accent" | "success" | "error"
		> = {
			plan: "warning",
			auto: "accent",
			// `ask` sits between plan and auto: full tools (so the agent can
			// edit/run things), but it pauses at git boundaries. `success`
			// (green) reads as "active but supervised".
			ask: "success",
			// `hack` is the default mode and the most permissive: full tools, no
			// plan ceremony, no compaction. Red footer flags "no safety net" —
			// the contrast when entering plan/auto is the visual point.
			hack: "error",
		};

		type PlanSurface = "overlay" | "off";
		type PlanPanelMode = "auto" | "overlay" | "off";

		// Overlay geometry. Width tracks a fraction of the terminal so the panel
		// is readable on wide terminals, with a floor so it never gets cramped.
		// Hidden on narrow terminals so it never collides with the chat column;
		// there is no plan surface at all below PLAN_PANEL_MIN_COLS.
		const PLAN_PANEL_WIDTH_PCT = "33%";
		const PLAN_PANEL_MIN_WIDTH = 40;
		const PLAN_PANEL_MIN_COLS = 100;

		/** Read extensionConfig.modes.planPanel (default "auto"). */
		function readPlanPanelSetting(ctx: ExtensionContext): PlanPanelMode {
			const settings = readRelevantSettings(ctx.cwd);
			const extCfg = settings.extensionConfig?.[EXT_ID] as
				| Record<string, unknown>
				| undefined;
			const raw = extCfg?.planPanel;
			if (raw === "overlay" || raw === "off" || raw === "auto") {
				return raw;
			}
			return "auto";
		}

		/**
		 * Decide which surface presents the plan. The panel is always-on: under
		 * the `auto` setting (and `overlay`) the floating overlay shows in every
		 * mode whenever a plan exists; `off` hides it. The narrow-terminal guard
		 * (PLAN_PANEL_MIN_COLS) still suppresses the overlay via its `visible`
		 * callback.
		 */
		function decidePlanSurface(setting: PlanPanelMode): PlanSurface {
			return setting === "off" ? "off" : "overlay";
		}

		function teardownPlanOverlay(): void {
			if (planPanelHandle) {
				planPanelHandle.hide();
				planPanelHandle = null;
			}
			planPanel = null;
			// Don't retain the last ctx past the panel it served.
			planPanelCtx = null;
		}

		/**
		 * Per-phase concurrent-driver badges for the panel. The host owns this
		 * because liveness needs an fs stat (`evaluateClaim` reads the driver
		 * session file's mtime); the renderer stays pure and just paints the badge.
		 */
		function computeDriverBadges(
			plan: Plan,
			selfSessionId: string,
		): Map<string, PhaseDriverBadge> {
			const badges = new Map<string, PhaseDriverBadge>();
			for (const phase of plan.phases) {
				const decision = evaluateClaim(phase, selfSessionId);
				if (decision.kind === "self") badges.set(phase.id, "self");
				else if (decision.kind === "occupied")
					badges.set(phase.id, "peer-live");
				else if (decision.kind === "stale") badges.set(phase.id, "peer-stale");
			}
			return badges;
		}

		/**
		 * Rebind this TUI into the session driving `phaseId`. Confirms first, then
		 * `switchSession` lands the user in the peer agent's session (the current
		 * session stays on disk). Groundwork for parallel `/implement --fanout`.
		 */
		async function attachToPhase(
			ctx: ExtensionContext,
			phaseId: string,
		): Promise<void> {
			const slug = modeState?.currentPlanSlug ?? null;
			const plan = slug ? loadPlan(slug) : null;
			const phase = plan?.phases.find((p) => p.id === phaseId) ?? null;
			if (!phase?.sessionPath) {
				notify(ctx, "phase has no session to attach to", "info");
				return;
			}
			if (phase.driverSessionId === ctx.sessionManager.getSessionId()) return;
			if (!hasSessionControl(ctx)) {
				notify(ctx, "cannot switch sessions from here", "warning");
				return;
			}
			const ok = await ctx.ui.confirm(
				"Attach to phase agent?",
				`Switch this TUI into the session driving "${phase.title}"? Your current session stays on disk.`,
			);
			if (!ok) return;
			await ctx.switchSession(phase.sessionPath);
		}

		/**
		 * Mount (or refresh) the floating plan overlay. No-op until the footer
		 * factory has handed us a TUI + theme; the factory calls updateWidget
		 * again once it has, so the panel appears on the next render.
		 */
		function mountPlanOverlay(ctx: ExtensionContext, plan: Plan): void {
			if (!footerTui || !panelTheme) return;
			const selfSessionId = ctx.sessionManager.getSessionId();
			planPanelCtx = ctx;
			if (planPanel) {
				planPanel.setPlan(plan);
				planPanel.setDriverBadges(computeDriverBadges(plan, selfSessionId));
				return;
			}
			const tui = footerTui;
			const panel = new PlanPanelComponent({
				plan,
				theme: panelTheme,
				requestRender: () => tui.requestRender(),
				onRequestUnfocus: () => {},
				onAttachPhase: (phaseId) => {
					const attachCtx = planPanelCtx;
					if (attachCtx) void attachToPhase(attachCtx, phaseId);
				},
			});
			planPanel = panel;
			panel.setDriverBadges(computeDriverBadges(plan, selfSessionId));
			planPanelHandle = tui.showOverlay(panel, {
				nonCapturing: true,
				anchor: "top-right",
				width: PLAN_PANEL_WIDTH_PCT,
				minWidth: PLAN_PANEL_MIN_WIDTH,
				maxHeight: "100%",
				margin: { top: 1, right: 1 },
				visible: (w, h) => {
					panel.setViewportHeight(h);
					return w >= PLAN_PANEL_MIN_COLS;
				},
			});
		}

		/**
		 * Open the plan in a dedicated, full-screen overlay that captures input —
		 * the way the notes editor takes over the screen. Reuses
		 * {@link PlanPanelComponent} (focused), so navigation/scroll/expand/attach
		 * behave exactly like the passive panel, just roomy. Esc/q closes it.
		 */
		async function openPlanView(ctx: ExtensionContext): Promise<void> {
			if (!ctx.hasUI) return;
			const plan = currentPlan();
			if (!plan || plan.phases.length === 0) {
				notify(ctx, "no active plan", "info");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const panel = new PlanPanelComponent({
					plan,
					theme,
					requestRender: () => tui.requestRender(),
					onRequestUnfocus: () => done(),
					onAttachPhase: (phaseId) => {
						done();
						void attachToPhase(ctx, phaseId);
					},
				});
				panel.setDriverBadges(
					computeDriverBadges(plan, ctx.sessionManager.getSessionId()),
				);
				panel.setViewportHeight(tui.terminal.rows);
				panel.setFocused(true);
				return {
					render: (width) => panel.render(width),
					invalidate: () => panel.invalidate(),
					handleInput: (data) => panel.handleInput(data),
				};
			});
		}

		/** Read extensionConfig.modes["sidebar.minCols"] (default 120). */
		function readSidebarMinCols(ctx: ExtensionContext): number {
			// Env override wins (handy for quick tuning without editing settings).
			const envRaw = process.env.PI_MODES_SIDEBAR_MIN_COLS;
			if (envRaw !== undefined) {
				const envN = Number(envRaw);
				if (Number.isFinite(envN) && envN > 0) return Math.floor(envN);
			}
			const settings = readRelevantSettings(ctx.cwd);
			const extCfg = settings.extensionConfig?.[EXT_ID] as
				| Record<string, unknown>
				| undefined;
			const nested = extCfg?.sidebar as Record<string, unknown> | undefined;
			const raw = extCfg?.["sidebar.minCols"] ?? nested?.minCols;
			const n = typeof raw === "number" ? raw : Number(raw);
			return Number.isFinite(n) && n > 0
				? Math.floor(n)
				: DEFAULT_SIDEBAR_MIN_COLS;
		}

		function teardownSidebar(): void {
			if (sidebarHandle) {
				sidebarHandle.hide();
				sidebarHandle = null;
			}
			sidebar = null;
			sidebarPlanPanel = null;
		}

		/**
		 * Mount the overlay sidebar (no-op until the footer factory has handed us a
		 * TUI + theme, and idempotent once mounted). Anchored top-right like the plan
		 * panel; the `visible` callback auto-hides it below `sidebar.minCols` so it
		 * never crushes a narrow pane.
		 */
		function mountSidebar(ctx: ExtensionContext): void {
			if (!footerTui || !panelTheme || sidebar) return;
			const tui = footerTui;
			const minCols = readSidebarMinCols(ctx);
			const theme = panelTheme;
			const component = new SidebarComponent({
				theme,
				requestRender: () => tui.requestRender(),
			});
			// Shared plan view for the Plan box: same component class as the
			// standalone overlay, so tree/scroll/navigation behave identically.
			const planView = new PlanPanelComponent({
				plan: currentPlan(),
				theme,
				requestRender: () => tui.requestRender(),
				onRequestUnfocus: () => {},
				onAttachPhase: (phaseId) => void attachToPhase(ctx, phaseId),
			});
			sidebarPlanPanel = planView;
			component.setPlanView(planView);
			sidebar = component;
			sidebarHandle = tui.showOverlay(component, {
				nonCapturing: true,
				anchor: "top-right",
				width: PLAN_PANEL_WIDTH_PCT,
				minWidth: PLAN_PANEL_MIN_WIDTH,
				maxHeight: "100%",
				margin: { top: 1, right: 1 },
				visible: (w, h) => {
					component.setViewportHeight(h);
					return w >= minCols;
				},
			});
		}

		/** Short, home-relative form of the cwd for the Info box `repo` row. */
		function shortCwd(cwd: string): string | null {
			if (!cwd) return null;
			const home = homedir();
			return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
		}

		/** Gather the Info box env facts from live ctx + git state. */
		function buildSidebarEnv(ctx: ExtensionContext): SidebarEnv {
			return {
				model: formatModelLabel(ctx),
				context: formatContextUsage(ctx),
				repo: shortCwd(ctx.cwd ?? ""),
				branch: currentBranch(ctx.cwd ?? ".") ?? modeState?.branch ?? null,
			};
		}

		/**
		 * Aggregate every live sub-agent into one flat list for the Info box:
		 * codebase-explore tasks, web-research delegates, `--fanout` fleet workers,
		 * and peer phase drivers. Terminal/idle entries are dropped so rows clear on
		 * completion.
		 */
		function buildSidebarAgents(ctx: ExtensionContext): AgentRow[] {
			const rows: AgentRow[] = [];

			// Codebase-explore tasks (active only).
			const explore = exploreMailbox?.getState();
			if (explore) {
				for (const t of explore.tasks) {
					if (t.status !== "queued" && t.status !== "running") continue;
					rows.push({
						kind: "explore",
						label: t.id,
						status: t.status,
						detail: t.lastToolSummary ?? t.question,
					});
				}
			}

			// Web-research delegates (blocking path tracked by activeResearch).
			for (const topic of delegateAgents?.getActiveResearch() ?? []) {
				rows.push({ kind: "research", label: topic, status: "running" });
			}

			// `--fanout` fleet workers + queued chains.
			const snapshot = activeFleet?.getSnapshot();
			if (snapshot) {
				for (const w of snapshot.workers) {
					const status: AgentRow["status"] =
						w.status === "ended"
							? "done"
							: w.status === "error"
								? "error"
								: "running";
					rows.push({
						kind: "fleet",
						label: w.chainId.slice(0, 8),
						status,
						detail: w.lastToolSummary ?? w.chainHeadId,
					});
				}
				for (const chainId of snapshot.queued) {
					rows.push({
						kind: "fleet",
						label: chainId.slice(0, 8),
						status: "queued",
					});
				}
			}

			// Peer phase drivers (other live sessions claiming phases).
			const slug = modeState?.currentPlanSlug ?? null;
			const plan = slug ? loadPlan(slug) : null;
			if (plan) {
				const badges = computeDriverBadges(
					plan,
					ctx.sessionManager.getSessionId(),
				);
				for (const phase of plan.phases) {
					const badge = badges.get(phase.id);
					if (badge === "peer-live" || badge === "peer-stale") {
						rows.push({
							kind: "peer",
							label: phase.title,
							status: badge === "peer-live" ? "live" : "stale",
							detail: "phase driver",
						});
					}
				}
			}

			return rows;
		}

		/** Push fresh env + sub-agent data into the sidebar (no-op when unmounted). */
		function refreshSidebar(ctx: ExtensionContext): void {
			if (!sidebar || !ctx.hasUI) return;
			sidebar.setEnv(buildSidebarEnv(ctx));
			sidebar.setAgents(buildSidebarAgents(ctx));
			sidebar.setNotes(loadSidebarNotes(ctx));
			// Feed the Plan box the live plan + driver badges (mirrors mountPlanOverlay).
			if (sidebarPlanPanel) {
				const plan = currentPlan();
				sidebarPlanPanel.setPlan(plan);
				if (plan) {
					sidebarPlanPanel.setDriverBadges(
						computeDriverBadges(plan, ctx.sessionManager.getSessionId()),
					);
				}
			}
		}

		/** Lazily read the per-session notes from disk, caching in-memory. */
		function loadSidebarNotes(ctx: ExtensionContext): string {
			if (sidebarNotes === null) {
				const sm = ctx.sessionManager;
				sidebarNotes = loadNotes(sm.getSessionDir(), sm.getSessionId());
			}
			return sidebarNotes;
		}

		/** Open the host editor on the current notes, then persist + refresh. */
		async function editSidebarNotes(ctx: ExtensionContext): Promise<void> {
			if (!ctx.hasUI) return;
			const current = loadSidebarNotes(ctx);
			const edited = await ctx.ui.editor("Notes", current);
			// Editor cancelled (Esc) returns undefined — keep the existing notes.
			if (edited === undefined) return;
			sidebarNotes = edited;
			const sm = ctx.sessionManager;
			saveNotes(sm.getSessionDir(), sm.getSessionId(), edited);
			sidebar?.setNotes(edited);
		}

		/** Flip the per-session sidebar toggle and reconcile overlays. */
		function toggleSidebar(ctx: ExtensionContext): void {
			sidebarEnabled = !sidebarEnabled;
			updateWidget(ctx);
			// Reconcile the below-editor delegate widgets: hidden while the sidebar
			// shows the same sub-agent data, restored when it's hidden again.
			reconcileDelegateWidgets(ctx);
			notify(ctx, sidebarEnabled ? "sidebar shown" : "sidebar hidden", "info");
		}

		/** Re-render the explore/research widgets against the current toggle. */
		function reconcileDelegateWidgets(ctx: ExtensionContext): void {
			if (!ctx.hasUI) return;
			if (exploreMailbox) renderExploreWidget(ctx, exploreMailbox.getState());
			delegateAgents?.refreshResearchWidget();
		}

		/**
		 * Mode-aware plan display controller. Picks the surface (floating overlay,
		 * inline footer indicator, or nothing) from the active mode + planPanel
		 * setting and tears down whatever isn't selected. Kept named `updateWidget`
		 * because it's called from many lifecycle hooks.
		 */
		function updateWidget(ctx: ExtensionContext): void {
			if (!ctx.hasUI) return;

			// Trigger footer re-render so the mode label + progress line refresh.
			footerTui?.requestRender();

			// The sidebar owns the top-right corner when enabled; the floating plan
			// panel stands down so the two overlays never overlap. (The plan tree
			// moves into the sidebar's Plan box in a later phase.)
			if (sidebarEnabled) {
				teardownPlanOverlay();
				mountSidebar(ctx);
				refreshSidebar(ctx);
				return;
			}
			teardownSidebar();

			const slug = modeState?.currentPlanSlug ?? null;
			const plan = slug ? loadPlan(slug) : null;
			const hasPlan = !!plan && plan.phases.length > 0;
			const surface: PlanSurface =
				modeState && hasPlan
					? decidePlanSurface(readPlanPanelSetting(ctx))
					: "off";

			// Tear down the overlay when it's not selected so a mode switch never
			// leaves a stale panel behind. The panel is the single plan surface in
			// every mode now — the old auto/ask inline footer line is retired.
			if (surface !== "overlay") teardownPlanOverlay();

			if (plan && surface === "overlay") mountPlanOverlay(ctx, plan);
		}

		/**
		 * Install a custom footer that renders the default left-side content
		 * (git branch + other extension statuses) and the current mode label
		 * right-aligned on the same line.
		 */
		function formatContextUsage(ctx: ExtensionContext): string | null {
			const usage = ctx.getContextUsage();
			if (!usage) return null;

			// Plan mode uses its own configurable cap (falls back to the model's
			// contextWindow). All other modes use the working + summary budget.
			const limit: number | null =
				modeState?.mode === "plan"
					? (readPlanMaxContextTokensSetting(ctx) ??
						usage.contextWindow ??
						null)
					: readWorkingTokensSetting(ctx) + readSummaryTokensSetting(ctx);
			if (!limit) return null;

			const systemPromptChars = ctx.getSystemPrompt().length;
			const toolSchemaChars = computeToolSchemaChars();
			const summaryChars = computeSummaryChars(ctx);
			const seedChars = computeSeedChars(ctx);

			const buckets = computeContextBuckets({
				total: usage.tokens,
				systemPromptChars,
				toolSchemaChars,
				summaryChars,
				seedChars,
			});

			// Use the pinned sys value when available — more accurate than
			// chars/4 for JSON-heavy tool schemas. Recompute work accordingly.
			const sys = pinnedSysTokens ?? buckets.sys;
			const sum = buckets.seed + buckets.summary;
			const work =
				buckets.total !== null ? Math.max(0, buckets.total - sys - sum) : 0;

			const k = (n: number) => `${Math.round(n / 1000)}k`;
			const total = buckets.total !== null ? k(buckets.total) : "0k";

			return `${total}/${k(limit)} (${k(sys)}/${k(sum)}/${k(work)})`;
		}

		/**
		 * Total chars across all currently-active tool schemas. Used to
		 * estimate the `sys` bucket's tool-definition contribution.
		 */
		function computeToolSchemaChars(): number {
			const active = new Set(pi.getActiveTools());
			let chars = 0;
			for (const tool of pi.getAllTools()) {
				if (!active.has(tool.name)) continue;
				chars += tool.name.length;
				chars += tool.description?.length ?? 0;
				try {
					chars += JSON.stringify(tool.parameters).length;
				} catch {
					// TypeBox schemas may contain symbols that don't serialise.
					// On error, skip the schema rather than crashing the footer.
				}
			}
			return chars;
		}

		/**
		 * Length of the active branch's most-recent compaction summary, or 0
		 * when none exists. Earlier compactions are superseded by the most
		 * recent (`firstKeptEntryId` rebases the prefix), so live summary
		 * cost in the prompt prefix equals just this one summary.
		 */
		function computeSummaryChars(ctx: ExtensionContext): number {
			try {
				const sm = ctx.sessionManager as unknown as SessionManager;
				return findLatestCompactionSummary(sm).length;
			} catch {
				return 0;
			}
		}

		/**
		 * Sum of `modes:plan-seed` custom-message-entry char counts on the
		 * current branch. Used by the footer (own bucket) and the mid-phase
		 * trigger (subtracted from working budget so a heavy carry-forward
		 * seed doesn't penalise the trigger). Returns 0 in plan-mode
		 * sessions or any session that hasn't seen a `seedPlanDoc` write.
		 */
		function computeSeedChars(ctx: ExtensionContext): number {
			try {
				const sm = ctx.sessionManager;
				let n = 0;
				for (const e of sm.getBranch()) {
					if (
						e.type === "custom_message" &&
						e.customType === PLAN_SEED_CUSTOM_TYPE
					) {
						const content = (e as { content?: unknown }).content;
						if (typeof content === "string") n += content.length;
					}
				}
				return n;
			} catch {
				return 0;
			}
		}

		/**
		 * Return a pretty model label for the footer. Prefers the model's display
		 * `name` (e.g. "Claude Sonnet 4.5"), falls back to the id with any
		 * provider prefix stripped.
		 */
		function formatModelLabel(ctx: ExtensionContext): string | null {
			const model = ctx.model;
			if (!model) return null;
			const pretty = (model as { name?: string }).name?.trim();
			let label: string;
			if (pretty) {
				label = pretty;
			} else {
				const id = model.id;
				if (!id) return null;
				const slash = id.lastIndexOf("/");
				label = slash >= 0 ? id.slice(slash + 1) : id;
			}
			// Trim to the part we care about: drop the vendor prefix
			// ("Claude Opus 4.8" → "Opus 4.8") and any trailing region /
			// parenthetical tag ("Opus 4.8 (EU)" → "Opus 4.8"). We append our
			// own parenthetical (thinking level) below, so a source paren would
			// only ever be noise here.
			label = label
				.replace(/^claude\s+/i, "")
				.replace(/\s*\([^)]*\)\s*$/, "")
				.trim();
			if (!label) return null;
			// Surface the active reasoning level so the footer answers "which
			// thinking mode am I in" at a glance. Hidden when off / unknown.
			let thinking: string | undefined;
			try {
				thinking = pi.getThinkingLevel();
			} catch {
				thinking = undefined;
			}
			if (thinking && thinking !== "off") {
				label = `${label} (${thinking})`;
			}
			return label;
		}

		function installFooter(ctx: ExtensionContext): void {
			if (!ctx.hasUI) return;
			const cwd = ctx.cwd ?? "";
			ctx.ui.setFooter((tui, theme, footerData) => {
				footerTui = tui;
				panelTheme = theme;
				// The TUI handle is now available; (re)mount the plan display in
				// case the footer renders after the first updateWidget call.
				updateWidget(ctx);
				return {
					invalidate() {
						tui.requestRender();
					},
					render(width) {
						// When the sidebar is shown it carries repo/branch/model/context
						// in its Info box, so the footer slims to just other-extension
						// statuses + the mode label. When hidden, the full footer stands.
						const slim = sidebarEnabled;
						// Left: path (branch) + context usage + other extensions.
						const branch = footerData.getGitBranch();
						const statuses = footerData.getExtensionStatuses();
						const leftParts: string[] = [];
						if (!slim) {
							const home = homedir();
							const shortPath = cwd.startsWith(home)
								? `~${cwd.slice(home.length)}`
								: cwd;
							const location = branch ? `${shortPath} (${branch})` : shortPath;
							leftParts.push(theme.fg("muted", location));
						}

						for (const [, val] of statuses) leftParts.push(val);
						const leftText = leftParts.join("  ");

						// Right: context usage | model | mode label.
						// Phase status lives in the widget (glyph + active-phase task
						// list), so we deliberately don't duplicate it here. With the
						// sidebar shown, usage/model live in the Info box too.
						const ctxLabel = slim ? null : formatContextUsage(ctx);
						const modelLabel = slim ? null : formatModelLabel(ctx);
						const usageLabel =
							[ctxLabel, modelLabel]
								.filter((s): s is string => Boolean(s))
								.join(" | ") || null;

						// Candidates ordered richest → sparsest. composeFooterLine picks
						// the first that fits and clamps the final line to `width` so a
						// long usage/model label or a narrow / resized terminal cannot
						// produce an over-wide line.
						const candidates: FooterRightCandidate[] = [];

						if (!modeState) {
							// ctx/model when available, then nothing.
							if (usageLabel) {
								candidates.push({
									visible: usageLabel,
									styled: theme.fg("muted", usageLabel),
								});
							}
							return [composeFooterLine(leftText, candidates, width)];
						}
						const label = MODE_LABELS[modeState.mode];
						const color = MODE_COLORS[modeState.mode];
						const sep = theme.fg("muted", " | ");
						const modeText = theme.bold(theme.fg(color, label));

						if (usageLabel) {
							candidates.push({
								visible: `${usageLabel} | ${label}`,
								styled: theme.fg("muted", usageLabel) + sep + modeText,
							});
						}
						candidates.push({ visible: label, styled: modeText });

						return [composeFooterLine(leftText, candidates, width)];
					},
					dispose: footerData.onBranchChange(() => tui.requestRender()),
				};
			});
		}

		function hasSessionControl(
			ctx: ExtensionContext,
		): ctx is ExtensionCommandContext {
			return typeof (ctx as ExtensionCommandContext).newSession === "function";
		}

		function runDetached(
			label: string,
			ctx: ExtensionContext,
			fn: () => Promise<void>,
		): void {
			// setImmediate (macrotask) ensures fn runs in a new event-loop tick,
			// after pi has fully flipped to idle following agent_end. Using
			// Promise.resolve().then (microtask) would fire before pi's own
			// post-handler continuation, causing ctx.ui.select to open while
			// pi is still mid-flush and silently return null.
			setImmediate(() => {
				void fn().catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					notify(ctx, `${label} failed: ${msg}`, "error");
				});
			});
		}

		// ---- Tool management --------------------------------------------------

		function applyModeTools(): void {
			if (!modeState) return;
			pi.setActiveTools(
				computeActiveTools(modeState.mode, modeState.priorTools),
			);
		}

		function restorePriorTools(): void {
			if (modeState?.priorTools) {
				pi.setActiveTools(modeState.priorTools);
			}
		}

		// ---- Mode transition --------------------------------------------------

		function setMode(mode: Mode, ctx: ExtensionContext): void {
			if (!modeState) return;
			if (modeState.mode === "plan" && mode !== "plan") {
				// Leaving plan mode — snapshot and delegate agents are stale.
				clearPlanTurnSnapshot();
				disposeDelegateAgents(ctx);
			}
			modeState.mode = mode;
			if (mode === "plan") {
				ensureExploreOverviewService().ensureStarted(ctx);
			}
			persist();
			applyModeTools();
			updateWidget(ctx);
		}

		// ---- Git sync ---------------------------------------------------------

		async function syncToDefault(
			ctx: ExtensionContext,
		): Promise<string | null> {
			if (!isGitRepo(ctx.cwd)) {
				notify(ctx, "not inside a git repository", "error");
				return null;
			}
			if (!workingTreeClean(ctx.cwd)) {
				if (isWorker()) {
					notify(
						ctx,
						"worker: working tree dirty in `" +
							ctx.cwd +
							"` — aborting (orchestrator must reconcile)",
						"error",
					);
					return null;
				}
				if (!ctx.hasUI) {
					notify(
						ctx,
						"working tree dirty and no UI to confirm — aborting",
						"error",
					);
					return null;
				}
				const proceed = await ctx.ui.confirm(
					"Working tree is dirty",
					"Uncommitted changes detected. Continue with checkout + pull anyway?",
				);
				if (!proceed) {
					notify(ctx, "aborted — commit or stash first", "warning");
					return null;
				}
			}
			const defaultBranch = detectDefaultBranch(ctx.cwd);
			if (!defaultBranch) {
				notify(
					ctx,
					"could not detect a default branch (no origin/HEAD, no main, no master)",
					"error",
				);
				return null;
			}
			const co = checkoutBranch(ctx.cwd, defaultBranch);
			if (!co.ok) {
				notify(
					ctx,
					`checkout ${defaultBranch} failed: ${co.stderr.trim()}`,
					"error",
				);
				return null;
			}
			const pull = await pullFastForwardAsync(
				ctx.cwd,
				defaultBranch,
				ctx.signal,
			);
			if (!pull.ok) {
				notify(
					ctx,
					pull.aborted
						? `pull origin ${defaultBranch} aborted; continuing on the local branch`
						: pull.timedOut
							? `pull origin ${defaultBranch} timed out — check connectivity or credentials; continuing on the local branch`
							: `pull origin ${defaultBranch} failed: ${pull.stderr.trim()}`,
					"warning",
				);
			}
			return defaultBranch;
		}

		// ---- Branch creation --------------------------------------------------

		async function createFeatureBranch(
			ctx: ExtensionContext,
			description: string,
		): Promise<string | null> {
			const branch = await deriveBranchNameWithModel(ctx, description);
			if (!branch) {
				notify(
					ctx,
					"could not derive a branch slug — try a more descriptive input",
					"error",
				);
				return null;
			}
			const onBranch = currentBranch(ctx.cwd);
			if (onBranch === branch) return branch;
			const r = createBranch(ctx.cwd, branch);
			if (!r.ok) {
				const sw = checkoutBranch(ctx.cwd, branch);
				if (!sw.ok) {
					notify(
						ctx,
						`failed to create or switch to ${branch}: ${r.stderr.trim() || sw.stderr.trim()}`,
						"error",
					);
					return null;
				}
			}
			return branch;
		}

		// ---- Picker -----------------------------------------------------------

		async function runPicker(ctx: ExtensionContext): Promise<void> {
			// Guard against stale setImmediate callbacks: if the user switched out
			// of plan mode (e.g. Shift+Tab) between scheduling and execution, bail.
			if (!modeState || modeState.mode !== "plan") return;

			const { mode: implementDefault, valid: implementDefaultValid } =
				readImplementDefaultSetting(ctx);
			if (!implementDefaultValid) {
				notify(
					ctx,
					'invalid implement.default setting (expected "auto" | "ask") — falling back to "auto"',
					"warning",
				);
			}

			const view = planPickerView(
				currentPlan(),
				modeState.branch,
				implementDefault,
			);
			if (view.action === "bail") {
				// The auto-pop gate blocks this case, but the Shift+Tab and
				// /plan resume paths can still land here. Bail gracefully
				// rather than offering "Implement" with nothing to implement.
				notify(ctx, view.notice, "info");
				modeState.stage = "planning";
				persist();
				return;
			}

			// Emit the current plan into chat so the user can review phases
			// without having to open a separate view.
			const summary = planSummaryContent(currentPlan(), view.action);
			if (summary) {
				pi.sendMessage(
					{
						customType: EXT_ID,
						content: summary,
						display: true,
						details: { planSummaryBeforePicker: true },
					},
					{ triggerTurn: false },
				);
			}

			const choice = await ctx.ui.select(view.title, view.options);

			if (!choice || choice.startsWith("Continue")) {
				// Reset to planning so the picker re-arms after the next agent turn.
				if (modeState) {
					modeState.stage = "planning";
					persist();
				}
				notify(ctx, "staying in plan mode", "info");
				return;
			}
			if (choice === view.scrutinizeLabel) {
				// On-demand scrutiny from the picker. If the user applies findings
				// we trigger a planning turn (agent_end re-arms the picker); if not
				// (no findings / dismissed / error) we re-show the picker so they
				// can still implement/park/continue.
				const applied = await runScrutiny(ctx);
				if (!applied) return runPicker(ctx);
				return;
			}
			if (choice.startsWith("Park")) {
				await doPark(ctx);
			} else {
				// Implement option — dispatch by exact-label identity rather than
				// substring-matching the parenthetical, which was brittle when
				// label suffixes embedded branch names.
				const implementMode: ImplementMode =
					choice === view.askLabel ? "ask" : "auto";
				await doImplement(ctx, null, implementMode);
			}
			// If the action failed / returned early, phase is still "awaiting-choice".
			// Reset to "planning" so agent_end re-arms the picker on the next turn.
			if (modeState?.stage === "awaiting-choice") {
				modeState.stage = "planning";
				persist();
			}
		}

		/** Format the findings dialog title, including a count per severity. */
		function formatFindingsTitle(findings: ScrutinyFinding[]): string {
			const high = findings.filter((f) => f.severity === "high").length;
			const medium = findings.filter((f) => f.severity === "medium").length;
			const low = findings.filter((f) => f.severity === "low").length;
			const parts: string[] = [];
			if (high) parts.push(`${high} high`);
			if (medium) parts.push(`${medium} medium`);
			if (low) parts.push(`${low} low`);
			return `🔍 Plan scrutiny: ${parts.join(", ")} finding${findings.length === 1 ? "" : "s"}`;
		}

		/** Format findings as a concise markdown message for the agent. */
		function formatFindingsMessage(findings: ScrutinyFinding[]): string {
			const LEVELS = ["high", "medium", "low"] as const;
			const sections: string[] = [
				"The plan scrutinizer found the following gaps and risks. Please address them before finalising the plan:",
			];
			for (const level of LEVELS) {
				const group = findings.filter((f) => f.severity === level);
				if (group.length === 0) continue;
				sections.push(
					`\n### ${level.charAt(0).toUpperCase() + level.slice(1)} severity`,
				);
				for (const f of group) {
					const scope = f.phase ? ` \`${f.phase}\`` : " (cross-cutting)";
					sections.push(`- **${f.finding}**${scope}: ${f.detail}`);
				}
			}
			return sections.join("\n");
		}

		/**
		 * Run the plan scrutinizer on demand and surface findings.
		 *
		 * Shared by the picker's "Scrutinize plan" option and the
		 * `/scrutinize` command. Replaces the old always-on
		 * `scrutinize.enable` gate — scrutiny now runs only when the user
		 * explicitly asks, so it never taxes the normal plan→implement flow.
		 *
		 * Returns `true` when findings were applied (a planning turn was
		 * triggered, so callers should let `agent_end` re-arm the picker) and
		 * `false` otherwise (no plan / no findings / dismissed / error — the
		 * caller decides what to show next). Headless sessions can't surface a
		 * findings dialog, so they no-op and return `false`.
		 */
		async function runScrutiny(ctx: ExtensionContext): Promise<boolean> {
			if (!ctx.hasUI) {
				notify(ctx, "scrutinize needs an interactive session", "warning");
				return false;
			}
			const plan = currentPlan();
			if (!plan) {
				notify(ctx, "no active plan to scrutinize", "info");
				return false;
			}

			notify(ctx, "🔍 Scrutinizing plan…", "info");
			const result = await scrutinizePlan(plan, ctx);

			if (result.error) {
				notify(ctx, `scrutinize error: ${result.error}`, "warning");
				return false;
			}

			if (result.findings.length === 0) {
				notify(ctx, "✅ plan scrutiny found no gaps or risks", "info");
				return false;
			}

			const choice = await ctx.ui.select(formatFindingsTitle(result.findings), [
				"Apply findings to plan",
				"Dismiss",
			]);

			if (choice === "Apply findings to plan") {
				// Send findings as a follow-up so the agent incorporates them in
				// the next planning turn. Reset stage so the picker re-arms.
				pi.sendMessage(
					{
						customType: EXT_ID,
						content: formatFindingsMessage(result.findings),
						display: false,
						details: { scrutinyFindings: true },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
				if (modeState?.stage === "awaiting-choice") {
					modeState.stage = "planning";
					persist();
				}
				return true;
			}

			return false;
		}

		/**
		 * Auto-mode end-of-phase loop: commit → ship → advance to next phase.
		 *
		 * Runs in place of `runPostExecPicker` when `modeState.mode === "auto"`.
		 * The loop is best-effort — any thrown error propagates back to the
		 * agent_end caller, which falls back to `runPostExecPicker` so the
		 * user can recover by hand.
		 *
		 * Sequencing notes:
		 *   - `runCommit({ nonInteractive: true })` stages, commits, and
		 *     pushes. It does NOT manage the PR — that's `/ship`'s job. If it
		 *     aborts with a "nothing new to commit" reason (clean-tree,
		 *     no-commits, agent-no-pr-output — e.g. the agent committed/
		 *     pushed/PR'd the phase out-of-band), we still proceed to ship;
		 *     `diagnoseCommitAbort` only halts on genuine blockers. Letting
		 *     doShip arbitrate is what keeps a bypassed commit from killing
		 *     the whole auto run.
		 *   - `doShip` then pushes again (idempotent fast-forward), opens
		 *     the PR, transitions the phase to `in-review`, and — if this
		 *     was the last actionable phase — fires the existing
		 *     `runCompletionPromptIfDone` (which is a no-op for non-final
		 *     phases because `buildCompletionPrompt` returns null until
		 *     every phase is terminal).
		 *   - For non-final phases we then call `doImplement(ctx, null,
		 *     "auto")`, which forks the next phase's session via
		 *     `ctx.newSession`. After that returns the current ctx is dead
		 *     (replaced by the new session); the next `agent_end` cycle
		 *     will re-enter this helper from the new session.
		 */
		async function runAutoPhaseLoop(
			ctx: ExtensionContext,
			_plan: Plan,
			completedPhase: PlanPhase | null,
		): Promise<void> {
			const phaseLabel = completedPhase?.id ?? "(unknown)";
			notify(ctx, `auto: committing Phase \`${phaseLabel}\`…`, "info");
			const commitMod = await import("pi-ext-commit/core");
			const commitResult = await commitMod.runCommit({
				ctx: ctx as ExtensionCommandContext,
				pi,
				guidance: "",
				nonInteractive: true,
				mode: "auto",
			});
			// Decide whether the commit outcome is ship-eligible. "Nothing new
			// to commit" reasons (clean-tree, no-commits, agent-no-pr-output)
			// route into doShip as the arbiter rather than throwing: the
			// agent may have committed/pushed/PR'd the phase out-of-band, and
			// doShip reconciles the existing PR (or pushes + creates one). A
			// fatal throw here would drop the loop into the agent_end picker
			// and halt auto progression — see diagnoseCommitAbort. Genuine
			// blockers halt cleanly (return, not throw) with an actionable
			// message; the post-ship `status === "active"` guard below still
			// catches the case where doShip itself couldn't establish a PR.
			const commitDecision = diagnoseCommitAbort(commitResult);
			if (commitDecision.action === "halt") {
				notify(
					ctx,
					`auto: commit step blocked (${commitDecision.reason}) — resolve and run /ship.`,
					"warning",
				);
				return;
			}

			notify(ctx, `auto: shipping Phase \`${phaseLabel}\`…`, "info");
			await doShip(undefined, ctx as ExtensionCommandContext);

			// `doShip` mutates the plan in place; re-read so we see the new
			// status of the just-shipped phase before deciding whether to
			// advance.
			//
			// Multi-driver auto: a driver owns its chain. After shipping,
			// walk to chainHead first — staying on the same chain is the
			// natural continuation and a peer driver wouldn't be working it
			// (their own chain is independent). If the chain is exhausted,
			// scan for ANY unclaimed-and-ready chain head elsewhere in the
			// plan and adopt it. If only blocked or peer-owned phases
			// remain, exit quietly with a reason — the user (or another
			// driver) takes it from here.
			const refreshed = currentPlan();
			if (!refreshed || !completedPhase) return;
			// If `doShip` failed (e.g. push/PR timed out or auth broke), the
			// phase stays `active` rather than advancing to `in-review`. Stop
			// the auto-loop here with a clear reason instead of walking the
			// chain — the successor depends on this phase and isn't shippable
			// yet, and plowing on would surface a misleading "not ready".
			const shippedNow = refreshed.phases.find(
				(p) => p.id === completedPhase.id,
			);
			if (shippedNow && shippedNow.status === "active") {
				notify(
					ctx,
					`auto: shipping Phase \`${phaseLabel}\` did not complete — stopping. Resolve the issue and run /ship.`,
					"warning",
				);
				return;
			}
			const next = chainHead(refreshed, completedPhase);
			const selfSessionId = ctx.sessionManager.getSessionId();
			if (next) {
				if (!isPhaseReady(refreshed, next)) {
					// Chain head exists but isn't ready — parent is
					// abandoned/missing or the user reshuffled dependsOn. End
					// the auto loop quietly with a reason; do not force-activate.
					const reason =
						blockedReason(refreshed, next) ?? `\`${next.id}\` not ready`;
					notify(ctx, `auto: ${reason} — stopping here.`, "info");
					return;
				}
				const decision = evaluateClaim(next, selfSessionId);
				if (decision.kind === "occupied") {
					notify(
						ctx,
						`auto: next phase \`${next.id}\` is being driven by session ${decision.sessionId} — stopping here.`,
						"info",
					);
					return;
				}
				notify(ctx, `auto: advancing to Phase \`${next.id}\`…`, "info");
				// Pass targetPhaseId so this branch deterministically advances
				// to the chain successor; without it, classifyImplementContext
				// could pick a different ready phase across parallel chains.
				await doImplement(ctx, null, "auto", false, next.id);
				return;
			}

			// Chain exhausted. Try to adopt another chain whose head is ready
			// and not actively driven by a peer. Stale claims (TTL-expired) and
			// own-claims are eligible — only live peer claims block adoption.
			const candidates = readyPhases(refreshed).filter((p) => {
				const d = evaluateClaim(p, selfSessionId);
				return d.kind !== "occupied";
			});
			const adopt = candidates[0];
			if (!adopt) {
				notify(
					ctx,
					"auto: chain complete — no ready chain heads available to adopt.",
					"info",
				);
				return;
			}
			notify(
				ctx,
				`auto: chain complete — adopting Phase \`${adopt.id}\`…`,
				"info",
			);
			await doImplement(ctx, null, "auto", false, adopt.id);
		}

		/**
		 * Pattern X coordinator entry point. Spawns a `FleetManager`, which
		 * spawns one worker subagent per independent chain. The orchestrator
		 * blocks on the fleet's completion promise; on `agent_end` for any
		 * worker, the manager re-evaluates the plan and fans out into
		 * newly-unblocked chains.
		 *
		 * Fleet completion = no workers remain AND no ready chain heads
		 * exist. The plan-completion check then surfaces in the parent
		 * session as usual via the post-exec picker / plan-complete prompt.
		 */
		async function runFleetOrchestrator(ctx: ExtensionContext): Promise<void> {
			const plan = currentPlan();
			if (!plan) {
				notify(
					ctx,
					"/implement --fanout: no active plan in this session. Run `/plan` first.",
					"warning",
				);
				return;
			}
			const selfSessionId = ctx.sessionManager.getSessionId();
			if (fleetWouldBeTrivial(plan, selfSessionId)) {
				notify(
					ctx,
					"/implement --fanout: plan has fewer than two independent chains — falling back to single-driver `/implement`.",
					"info",
				);
				await doImplement(ctx, null, "auto");
				return;
			}
			notify(ctx, `fanout: spawning fleet for plan \`${plan.slug}\`…`, "info");
			const fleet = new FleetManager(ctx, {
				planSlug: plan.slug,
				selfSessionId,
			});
			activeFleet = fleet;
			refreshSidebar(ctx);
			fleet.onEvent(({ chainId, notification }) => {
				// Keep the sidebar Info box in step with worker lifecycle.
				refreshSidebar(ctx);
				switch (notification.kind) {
					case "phase-started":
						notify(
							ctx,
							`fleet[${chainId.slice(0, 8)}] started \`${notification.phaseId}\``,
							"info",
						);
						break;
					case "phase-shipped": {
						const pr = notification.prNumber
							? ` (PR #${notification.prNumber})`
							: "";
						notify(
							ctx,
							`fleet[${chainId.slice(0, 8)}] shipped \`${notification.phaseId}\`${pr}`,
							"info",
						);
						break;
					}
					case "phase-blocked":
						// Reserved for future worker-side emission. Today's
						// `diffWorkerEvents` derives only started/shipped/complete
						// from plan-status diffs; this branch is dormant until a
						// worker can emit blocks (e.g. via the notify-tool path
						// scaffolded in `worker-protocol.ts`).
						notify(
							ctx,
							`fleet[${chainId.slice(0, 8)}] blocked on \`${notification.phaseId}\`: ${notification.reason}`,
							"warning",
						);
						break;
					case "phase-error":
						// Reachable: `FleetManager` synthesises this on worker
						// spawn failure (no model configured, RPC startup error,
						// etc.). Mid-run worker errors currently surface via the
						// worker exiting without advancing the chain.
						notify(
							ctx,
							`fleet[${chainId.slice(0, 8)}] error on \`${notification.phaseId}\`: ${notification.error}`,
							"error",
						);
						break;
					case "chain-complete":
						notify(
							ctx,
							`fleet[${chainId.slice(0, 8)}] chain complete✨`,
							"info",
						);
						break;
				}
			});
			try {
				await fleet.start();
				notify(ctx, "fleet complete — no chains remain.", "info");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				notify(ctx, `fleet error: ${msg}`, "error");
			} finally {
				activeFleet = null;
				refreshSidebar(ctx);
				await fleet.dispose();
			}
		}

		async function runPostExecPicker(ctx: ExtensionContext): Promise<void> {
			if (!ctx.hasUI) {
				if (modeState) modeState.stage = "idle";
				persist();
				updateWidget(ctx);
				return;
			}
			const installed = new Set(pi.getCommands().map((c) => c.name));
			const options: string[] = [];
			if (installed.has("commit")) options.push("Run /commit");
			options.push("Stay here");

			if (options.length === 1) {
				if (modeState) modeState.stage = "idle";
				persist();
				updateWidget(ctx);
				return;
			}

			const choice = await ctx.ui.select(
				"Execution complete. Now what?",
				options,
			);
			if (modeState) modeState.stage = "idle";
			persist();
			updateWidget(ctx);

			if (!choice || choice.startsWith("Stay")) return;

			if (choice.startsWith("Run /commit")) {
				try {
					const mod = await import("pi-ext-commit/core");
					await mod.runCommit({
						ctx,
						pi,
						guidance: "",
						skipReviewOffer: true,
						mode: modeState?.mode,
					});
				} catch (err) {
					notify(
						ctx,
						`commit failed: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
			}
		}

		// ---- Ask dialog -------------------------------------------------------

		async function showAskDialog(
			ctx: ExtensionContext,
			questions: PendingQuestion[],
		): Promise<void> {
			let dialogMod: typeof import("@vegardx/pi-questions") | null = null;
			try {
				dialogMod = await import("@vegardx/pi-questions");
			} catch {
				// Fallback: questions not available. Feed questions as
				// plain text and let the user reply normally.
				const fallback = questions
					.map((q, i) => `${i + 1}. ${q.question}`)
					.join("\n");
				pi.sendMessage(
					{
						customType: `${EXT_ID}-ask-fallback`,
						content: `**Questions:**\n\n${fallback}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			const items = questions.map((q) => ({
				id: q.id,
				label: truncateToWidth(q.question, 30),
				prompt: q.question,
				options: (q.options ?? []).map((opt, i) => ({
					value: String(i),
					label: opt,
				})),
				textInput: { placeholder: "Type your answer\u2026" },
				...(q.context
					? {
							preview: {
								kind: "code" as const,
								content: q.context,
								title: "Context",
							},
						}
					: {}),
			}));

			const result = await dialogMod.showQuestions(ctx, {
				title: "Questions",
				items,
				requireAll: true,
			});

			if (result.cancelled) {
				notify(
					ctx,
					"questions dismissed \u2014 agent will continue without answers",
					"warning",
				);
				return;
			}

			// Build Q&A pairs and persist.
			const pairs: QAPair[] = [];
			const answerLines: string[] = [];
			for (const q of questions) {
				const answer = result.answers.find((a) => a.id === q.id);
				const text = answer?.text ?? answer?.label ?? "(no answer)";
				pairs.push({ question: q.question, answer: text });
				answerLines.push(`**Q:** ${q.question}\n**A:** ${text}`);
			}

			// Persist for context.
			pi.appendEntry(ASK_ANSWERS_ENTRY, { pairs });

			// Send answers as a followUp message to continue the conversation.
			pi.sendMessage(
				{
					customType: `${EXT_ID}-ask-answers`,
					content: answerLines.join("\n\n"),
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}

		// ---- Compaction wiring ------------------------------------------------
		//
		// Mid-phase compaction is driven by `ctx.compact()` from the `turn_end`
		// trigger; the actual summary is built in the `session_before_compact`
		// handler registered below. Pi performs `appendCompaction` AND the
		// `agent.state.messages` rebuild that the legacy direct-write path
		// skipped.
		//
		// Plan→implement and phase-end compactions are gone. Plan→implement is
		// replaced by `seedPlanDoc` in the new auto session (see
		// `plan/seed.ts`); phase-end is replaced by `phase.summary` written to
		// the plan doc at /ship time (a follow-up commit on this branch).
		//
		// See plan/compaction.ts for the byte-stable prefix invariant and the
		// three-bucket budget model.

		/** Once-per-session warning when no normal-tier model is configured. */
		let warnedNoCompactionModel = false;

		/**
		 * Re-entrancy guard. Mid-phase compaction runs from the `turn_end`
		 * hook; the LLM summarisation call can take seconds, during which
		 * pi may fire another turn_end. Without this flag we'd stack
		 * concurrent compactions on the same branch and produce duplicate
		 * sections. Set true at compactPhaseSlice entry, cleared in finally.
		 */
		/**
		 * Soft-warn deduplication: once `summaryUsed > summaryTokens` fires
		 * a warning during `turn_end`, suppress further warnings for the
		 * remainder of the session. Reset on `session_start`.
		 */
		let summaryBudgetWarnFired = false;

		let compactionInFlight = false;
		/**
		 * Set when a mid-phase compaction is *abandoned* (timeout/abort) while
		 * pi may still be running it in the background. pi's `compact()` aborts
		 * the agent and replaces its compaction controller on each call, so
		 * firing a second compaction before the orphaned one settles races two
		 * `agent.state.messages` rebuilds. We suppress new mid-phase
		 * compactions until this timestamp to keep concurrency at one.
		 */
		let compactionCooldownUntil = 0;
		/** Guard preventing double-fire of the exec-complete auto-loop from both
		 *  the agent_end path and the compaction-fallback path (#138). */
		let postExecInFlight = false;

		/**
		 * Side-channel between modes' trigger sites and the
		 * `session_before_compact` handler. Set just before `ctx.compact()`,
		 * read & cleared inside the handler. Identifies which modes-flavoured
		 * compaction shape to build. `null` means "no modes-driven compaction
		 * is in flight" — if pi fires `session_before_compact` from its own
		 * auto-compaction path we let it through (return `{}`).
		 */
		let pendingCompactionKind: { kind: "phase-slice"; phaseId: string } | null =
			null;

		/**
		 * Promise wrapper around the fire-and-forget `ctx.compact(...)` API.
		 * Resolves on `onComplete`, rejects on `onError`. `compactPhaseSlice`
		 * awaits this so the surrounding `compactionInFlight` guard releases
		 * only after pi has actually finished the compaction (and its
		 * post-compaction `agent.state.messages` rebuild).
		 *
		 * Bounded by a timeout and the active turn's abort signal. pi only
		 * fires `onComplete`/`onError` once its internal summariser settles; a
		 * stalled or pathologically slow summariser would otherwise leave this
		 * promise pending forever, wedging the `turn_end` hook (and thus the
		 * whole agent) "working" with no way to interrupt — escape can't cancel
		 * a hook await. `CompactOptions` exposes no abort signal, so we can't
		 * cancel pi's in-flight compaction; instead we stop awaiting it. The
		 * underlying compaction may still complete in the background (harmless:
		 * its `onComplete` becomes a no-op here), and the caller's `catch`
		 * surfaces a warning + lets pi's own auto-compaction handle overflow.
		 */
		function compactAwait(ctx: ExtensionContext): Promise<void> {
			const timeoutMs = readCompactionNumber(
				ctx,
				"timeoutMs",
				DEFAULT_COMPACTION_TIMEOUT_MS,
			);
			return awaitCompaction({
				start: (opts) => ctx.compact(opts),
				signal: ctx.signal,
				timeoutMs,
			});
		}

		function readCompactionNumber(
			ctx: ExtensionContext,
			key: string,
			fallback: number,
		): number {
			const settings = readRelevantSettings(ctx.cwd);
			const extCfg = settings.extensionConfig?.[EXT_ID] as
				| Record<string, unknown>
				| undefined;
			const compactionCfg = extCfg?.compaction as
				| Record<string, unknown>
				| undefined;
			const raw = compactionCfg?.[key];
			if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
				return Math.floor(raw);
			}
			return fallback;
		}

		function readPhaseTokensSetting(ctx: ExtensionContext): number {
			return readCompactionNumber(ctx, "phaseTokens", DEFAULT_PHASE_TOKENS);
		}

		function readDefaultModeSetting(ctx: ExtensionContext): {
			mode: Mode;
			valid: boolean;
		} {
			const settings = readRelevantSettings(ctx.cwd);
			const extCfg = settings.extensionConfig?.[EXT_ID] as
				| Record<string, unknown>
				| undefined;
			const modeCfg = extCfg?.mode as Record<string, unknown> | undefined;
			return resolveDefaultMode(modeCfg?.default);
		}

		function readImplementDefaultSetting(ctx: ExtensionContext): {
			mode: ImplementMode;
			valid: boolean;
		} {
			const settings = readRelevantSettings(ctx.cwd);
			const extCfg = settings.extensionConfig?.[EXT_ID] as
				| Record<string, unknown>
				| undefined;
			const implementCfg = extCfg?.implement as
				| Record<string, unknown>
				| undefined;
			return resolveImplementDefault(implementCfg?.default);
		}

		function readWorkingTokensSetting(ctx: ExtensionContext): number {
			return readCompactionNumber(ctx, "workingTokens", DEFAULT_WORKING_TOKENS);
		}

		function readSummaryTokensSetting(ctx: ExtensionContext): number {
			return readCompactionNumber(ctx, "summaryTokens", DEFAULT_SUMMARY_TOKENS);
		}

		/**
		 * Plan-mode footer cap. Returns null when the user hasn't set a
		 * positive override — the footer then falls back to the model's
		 * contextWindow. Pure display: nothing in the runtime enforces this.
		 */
		function readPlanMaxContextTokensSetting(
			ctx: ExtensionContext,
		): number | null {
			const settings = readRelevantSettings(ctx.cwd);
			const extCfg = settings.extensionConfig?.[EXT_ID] as
				| Record<string, unknown>
				| undefined;
			const compactionCfg = extCfg?.compaction as
				| Record<string, unknown>
				| undefined;
			const raw = compactionCfg?.planMaxContextTokens;
			if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
				return Math.floor(raw);
			}
			return null;
		}

		function readResearchTimeoutMs(ctx: ExtensionContext): number {
			const settings = readRelevantSettings(ctx.cwd);
			const extCfg = settings.extensionConfig?.[EXT_ID] as
				| Record<string, unknown>
				| undefined;
			const researchCfg = extCfg?.research as
				| Record<string, unknown>
				| undefined;
			const raw = researchCfg?.timeoutMs;
			if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
				return Math.floor(raw);
			}
			return DEFAULT_RESEARCH_TIMEOUT_MS;
		}

		/**
		 * Read `extensionConfig.modes.delegate.maxAnswerChars` — the hard cap
		 * on a delegated answer's size before it crosses back into the
		 * caller's context. Keeps delegation context-slimming honest.
		 */
		function readDelegateMaxChars(ctx: ExtensionContext): number {
			const settings = readRelevantSettings(ctx.cwd);
			const extCfg = settings.extensionConfig?.[EXT_ID] as
				| Record<string, unknown>
				| undefined;
			const delegateCfg = extCfg?.delegate as
				| Record<string, unknown>
				| undefined;
			const raw = delegateCfg?.maxAnswerChars;
			if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
				return Math.floor(raw);
			}
			return DEFAULT_DELEGATE_MAX_CHARS;
		}

		/** Hard-cap a delegated answer; append a marker when truncated. */
		function capDelegatedAnswer(text: string, cap: number): string {
			if (text.length <= cap) return text;
			const marker = `\n\n[…delegated answer truncated at ${cap} chars]`;
			// Reserve room for the marker so the FINAL string stays within `cap`
			// (a tiny cap below the marker length degrades to marker-only).
			const room = Math.max(0, cap - marker.length);
			return text.slice(0, room) + marker;
		}

		/**
		 * Read `extensionConfig.modes.delegate.maxConcurrent` — the cap on
		 * concurrent researcher subprocesses. Backpressure for a burst of
		 * parallel delegate(researcher) calls (the agent loop runs a turn's
		 * tool calls via Promise.all with no cap of its own).
		 */
		function readDelegateMaxConcurrent(ctx: ExtensionContext): number {
			const settings = readRelevantSettings(ctx.cwd);
			const extCfg = settings.extensionConfig?.[EXT_ID] as
				| Record<string, unknown>
				| undefined;
			const delegateCfg = extCfg?.delegate as
				| Record<string, unknown>
				| undefined;
			const raw = delegateCfg?.maxConcurrent;
			// Require >= 1: a fractional value like 0.5 would floor to 0, which
			// cappedResearch treats as uncapped — the opposite of intent.
			if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
				return Math.floor(raw);
			}
			return DEFAULT_DELEGATE_MAX_CONCURRENT;
		}

		/**
		 * Read `extensionConfig.modes.explore.{parallelism,queueDepthThreshold}`.
		 *
		 * Both values are sanitised the same way the mailbox itself does
		 * (positive numbers floored to integer; everything else falls back
		 * to the default). When the user supplied something that fell back
		 * we emit a one-line warning so they know the setting was ignored.
		 */
		function readExploreSettings(ctx: ExtensionContext): {
			parallelism: number;
			queueDepthThreshold: number;
		} {
			const settings = readRelevantSettings(ctx.cwd);
			const extCfg = settings.extensionConfig?.[EXT_ID] as
				| Record<string, unknown>
				| undefined;
			const explore = extCfg?.explore as Record<string, unknown> | undefined;
			const parallelism = readSanitisedNumber(
				ctx,
				explore?.parallelism,
				"extensionConfig.modes.explore.parallelism",
				DEFAULT_PARALLELISM,
				sanitiseParallelism,
			);
			const queueDepthThreshold = readSanitisedNumber(
				ctx,
				explore?.queueDepthThreshold,
				"extensionConfig.modes.explore.queueDepthThreshold",
				DEFAULT_QUEUE_DEPTH_THRESHOLD,
				sanitiseQueueDepthThreshold,
			);
			return { parallelism, queueDepthThreshold };
		}

		/**
		 * Read a numeric setting via the same sanitiser the mailbox uses, and
		 * warn only when the user supplied something that fell back to the
		 * default. Keeps settings-path behaviour consistent with the
		 * constructor-path behaviour for things like `2.7` (floored to 2,
		 * not silently rejected).
		 */
		function readSanitisedNumber(
			ctx: ExtensionContext,
			raw: unknown,
			key: string,
			fallback: number,
			sanitise: (raw: unknown) => number,
		): number {
			if (raw === undefined) return fallback;
			const sanitised = sanitise(raw);
			if (sanitised === fallback && raw !== fallback) {
				notify(
					ctx,
					`${key}: ${JSON.stringify(raw)} is not a valid positive number; using default ${fallback}`,
					"warning",
				);
			}
			return sanitised;
		}

		/**
		 * Map a `ResearchOutcome` into the `{ content, details }` shape the
		 * tool runtime expects. Timeout outcomes also fire a one-shot
		 * warning notify so the user knows a research call was reaped.
		 *
		 * The agent-facing text keeps the historical `[research …]`
		 * bracketed-message convention so existing prompts continue to
		 * recognise failure shapes; `details` carries the structured
		 * outcome verbatim for any caller that wants to branch on it.
		 */
		function formatResearchOutcome(
			ctx: ExtensionContext,
			outcome: ResearchOutcome,
		): {
			content: { type: "text"; text: string }[];
			details: ResearchOutcome;
		} {
			let text: string;
			if (outcome.ok) {
				text = outcome.text;
			} else if (outcome.reason === "timeout") {
				notify(
					ctx,
					`research timed out after ${outcome.elapsedMs}ms (limit ${outcome.timeoutMs}ms)`,
					"warning",
				);
				text = `[research timeout: no response after ${outcome.elapsedMs}ms (limit ${outcome.timeoutMs}ms)]`;
			} else if (outcome.reason === "no-model") {
				text = `[research: ${outcome.detail}]`;
			} else if (outcome.reason === "subagent-error") {
				text = `[research error: ${outcome.detail}]`;
			} else {
				text = "[research: no response]";
			}
			return { content: [{ type: "text", text }], details: outcome };
		}

		/**
		 * Build the SummariseFn used by the compaction orchestrators. Returns
		 * null when no normal-tier model is configured/auth'd — callers then
		 * skip compaction (with a once-per-session warning).
		 */
		async function buildSummariseFn(
			ctx: ExtensionContext,
		): Promise<SummariseFn | null> {
			const resolved = await resolveModel(ctx, {
				name: "modes",
				tier: "normal",
				requireApiKey: true,
			});
			if (!resolved?.apiKey) return null;

			return async ({ messages, preamble, maxTokens, signal }) => {
				const conversationText = serializeConversation(convertToLlm(messages));
				const prompt = `${preamble}\n\n<conversation>\n${conversationText}\n</conversation>`;
				try {
					const response = await complete(
						resolved.model,
						{
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: prompt }],
									timestamp: Date.now(),
								},
							],
						},
						{
							apiKey: resolved.apiKey,
							headers: resolved.headers,
							maxTokens,
							signal,
						},
					);
					if (
						response.stopReason === "error" ||
						response.stopReason === "aborted"
					) {
						return null;
					}
					const text = response.content
						.filter(
							(c): c is { type: "text"; text: string } => c.type === "text",
						)
						.map((c) => c.text)
						.join("\n")
						.trim();
					if (!text) return null;
					const usage = fromAiUsage(response.usage) ?? undefined;
					return { text, usage };
				} catch {
					return null;
				}
			};
		}

		/**
		 * Mid-phase compaction. Fires from the `turn_end` hook when context
		 * tokens exceed `workingTokens` (after subtracting summary cost) in
		 * auto mode with an active phase.
		 *
		 * Routes through `ctx.compact()` so pi performs `appendCompaction` AND
		 * the `agent.state.messages = sessionContext.messages` rebuild that the
		 * legacy direct-write path skipped (the bug that made every previous
		 * mid-phase compaction a runtime no-op). The actual summary content is
		 * built by `buildPhaseSliceCompactionResult` inside the
		 * `session_before_compact` handler.
		 */
		async function compactPhaseSlice(
			ctx: ExtensionContext,
			_plan: Plan,
			phaseId: string,
		): Promise<void> {
			if (modeState?.mode === "hack") return;

			// Capture the stage and mode at entry. The post-compaction
			// continuation kick (below) only fires when we entered in
			// `executing`, which scopes it to the auto-mode `turn_end` trigger
			// path. The Shift+Tab hack→plan compaction path enters with
			// stage=`idle`, so it skips the kick and lets the user drive the
			// next turn manually. The manual `/compact` slash command goes
			// through pi's own path and never reaches this function. We also
			// snapshot the mode so the gate can detect a Shift+Tab during the
			// async `ctx.compact()` call (e.g. user leaves auto mid-flight —
			// don't kick an auto-mode follow-up turn for them).
			const stageAtEntry = modeState?.stage;
			const modeAtEntry = modeState?.mode;

			pendingCompactionKind = { kind: "phase-slice", phaseId };
			let compacted = false;
			try {
				await compactAwait(ctx);
				compacted = true;
				notify(
					ctx,
					`context compacted: phase ${phaseId} mid-phase slice`,
					"info",
				);
			} catch (err) {
				// `compactAwait` rejects when (a) the summariser fails / no
				// normal-tier model is configured (the handler returns
				// `{ cancel: true }`), (b) pi's `prepareCompaction` returned
				// undefined ("Already compacted" / "Nothing to compact"), or
				// (c) the LLM call errored. None of these are crash-worthy for
				// modes — surface a warning and let pi auto-compaction handle
				// the next overflow.
				const msg = err instanceof Error ? err.message : String(err);
				notify(ctx, `mid-phase compaction skipped (${msg})`, "warning");
				// Timeout/abort mean we stopped awaiting but pi may still be
				// compacting in the background. Hold off on re-triggering until
				// the orphan should have settled, so we don't stack two
				// concurrent compactions. (Real onError settles pi → no orphan.)
				if (msg === "aborted" || msg.includes("timed out")) {
					compactionCooldownUntil =
						Date.now() +
						readCompactionNumber(
							ctx,
							"timeoutMs",
							DEFAULT_COMPACTION_TIMEOUT_MS,
						);
				}
			} finally {
				pendingCompactionKind = null;
			}

			// Kick a follow-up turn so the agent resumes work after the rebuild.
			// Without this, `ctx.compact()` returns, pi rebuilds messages, and
			// the agent goes idle mid-phase — the user has to type "continue"
			// manually, which defeats auto mode.
			const plan = currentPlan();
			const remaining = activeTasks(plan).filter(({ task }) => !task.done);
			const compactionResume = diagnoseResumeAfterCompaction({
				compacted,
				stageAtEntry,
				modeAtEntry,
				currentStage: modeState?.stage,
				currentMode: modeState?.mode,
				remainingTaskCount: remaining.length,
			});
			if (!compactionResume.resume) {
				// Fallback re-entry (#138): stage drifted to exec-complete during
				// compaction — agent_end set the stage but the post-exec
				// runDetached may not have survived the async gap. Fire the
				// exec-complete path now. The postExecInFlight guard prevents
				// double-firing if agent_end's own runDetached is still running.
				if (compactionResume.driftedToExecComplete && !postExecInFlight) {
					const planNow = currentPlan();
					notify(
						ctx,
						"auto-loop: stage drifted to exec-complete during compaction — firing fallback re-entry",
						"info",
					);
					runDetached("post-exec fallback", ctx, async () => {
						if (postExecInFlight) return;
						postExecInFlight = true;
						try {
							await new Promise<void>((resolve) => setImmediate(resolve));
							// Guard: re-check stage in case the primary post-exec path
							// already ran to completion while this fallback was queued.
							// If stage advanced past exec-complete the auto-loop already
							// ran and we must not fire it a second time.
							if (
								modeState?.mode === "auto" &&
								modeState.stage === "exec-complete" &&
								planNow
							) {
								try {
									await runAutoPhaseLoop(ctx, planNow, activePhase(planNow));
									return;
								} catch (err) {
									notify(
										ctx,
										`auto loop fallback failed: ${
											err instanceof Error ? err.message : String(err)
										}`,
										"error",
									);
								}
							}
							await runPostExecPicker(ctx);
						} finally {
							postExecInFlight = false;
						}
					});
					return;
				}
				// Surface other non-trivial gate trips as info. Skip the obvious
				// ones (user left auto, compaction failed) to avoid notify spam.
				if (
					compacted &&
					compactionResume.gate !== "stage-at-entry-not-executing" &&
					compactionResume.gate !== "mode-drifted"
				) {
					notify(
						ctx,
						`auto-loop: post-compaction resume skipped (gate: ${compactionResume.gate})`,
						"info",
					);
				}
				return;
			}

			pi.sendMessage(
				{
					customType: EXT_ID,
					content:
						"[modes: context was compacted mid-phase. The rolling summary above " +
						"captures what was done so far. Continue executing the active phase's " +
						"remaining tasks — do NOT restart from the beginning.]",
					display: false,
					details: { postCompactionResume: true, phaseId },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}

		// ---- Implement path ---------------------------------------------------

		async function doImplement(
			ctx: ExtensionContext,
			descriptionArg: string | null,
			implementMode: ImplementMode = "auto",
			takeover = false,
			targetPhaseId: string | null = null,
		): Promise<void> {
			if (!modeState) return;

			if (!isGitRepo(ctx.cwd)) {
				// Not a git repo — skip branching, just switch into the chosen
				// execution mode.
				modeState.stage = "executing";
				setMode(implementMode, ctx);
				if (descriptionArg) {
					pi.sendMessage(
						{ customType: EXT_ID, content: descriptionArg, display: false },
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}
				notify(
					ctx,
					`${implementMode} mode — not a git repo, skipping branch creation`,
					"info",
				);
				return;
			}

			const description =
				descriptionArg ||
				modeState.planText ||
				descriptionFromLastAssistant(ctx) ||
				"implement the plan";

			// If a plan exists, scope execution to one phase. Pick the in-flight
			// phase if there is one, otherwise the next `planned` phase, and
			// flip it to `active`. The branch comes from the phase, not from
			// the description — so /ship has a clear per-phase boundary.
			const plan = currentPlan();
			// `/implement <phaseId>` routes to a specific phase, bypassing the
			// auto-picker. Validates the id, that the phase isn't terminal, and
			// that the dependsOn chain isn't blocked. Adoption guard still fires
			// downstream so a peer's claim is respected unless --takeover is set.
			let classified: ImplementContext;
			if (targetPhaseId) {
				if (!plan) {
					notify(
						ctx,
						`/implement \`${targetPhaseId}\`: no active plan in this session. Run \`/plan\` first.`,
						"warning",
					);
					return;
				}
				const target = plan.phases.find((p) => p.id === targetPhaseId);
				if (!target) {
					notify(
						ctx,
						`/implement \`${targetPhaseId}\`: no such phase in plan \`${plan.slug}\`.`,
						"warning",
					);
					return;
				}
				if (TERMINAL_STATUSES.includes(target.status)) {
					notify(
						ctx,
						`phase \`${targetPhaseId}\` is ${target.status} — nothing more to implement here.`,
						"warning",
					);
					return;
				}
				// In-flight (active / needs-attention / in-review / ready-to-ship)
				// or planned-but-blocked phases are still legal targets when the
				// caller passed an explicit id — the user / orchestrator is
				// asserting they know what they're doing. The adoption guard
				// downstream handles peer claims; isPhaseReady-type policy applies
				// only to the auto-picker.
				if (target.status === "planned") {
					const reason = blockedReason(plan, target);
					if (reason) {
						notify(
							ctx,
							`phase \`${targetPhaseId}\` is not ready: ${reason}. ` +
								`Edit dependsOn (phase update) to unblock, or wait for the predecessor to ship.`,
							"warning",
						);
						return;
					}
				}
				// Pre/post phases are manual checklists — they have no branch
				// and `/ship` rejects them. `/implement <phaseId>` would happily
				// flow into the branch-checkout path with `phase.branch === ""`,
				// producing `git checkout -B ""` failures. Refuse explicitly with
				// the same warning shape as the pre/post `/ship` guard.
				const targetKind = effectivePhaseKind(target);
				if (targetKind !== "regular") {
					notify(
						ctx,
						`phase \`${target.id}\` is a ${targetKind}-phase (manual checklist) — there's no branch to implement. Tick its tasks with \`plan_task toggle\` instead.`,
						"warning",
					);
					return;
				}
				classified = { kind: "use-phase", phase: target };
			} else {
				classified = classifyImplementContext(plan);
			}
			let branch: string | null;
			let phase: PlanPhase | null = null;
			let branchPlan: ImplementBranchPlan | null = null;
			if (classified.kind === "refuse-no-actionable") {
				// Plan exists but every phase is shipped/abandoned. Refuse rather
				// than silently creating an off-plan branch from the description;
				// that surprised users.
				notify(
					ctx,
					"plan has no actionable phase (all shipped/abandoned). " +
						"Use /plan to start a new plan, or Shift+Tab to hack mode " +
						"for an off-plan branch.",
					"warning",
				);
				modeState.stage = "planning";
				persist();
				return;
			}
			if (classified.kind === "blocked-on-pre" && plan) {
				// Pre-phase has un-ticked tasks; refuse to start any regular work
				// until the user completes the manual preflight checklist.
				const pre = classified.phase;
				const pending = pre.tasks.filter((t) => !t.done);
				const headline = pending
					.slice(0, 3)
					.map((t) => `  - [!] ${t.title}`)
					.join("\n");
				const more =
					pending.length > 3 ? `\n  … and ${pending.length - 3} more` : "";
				notify(
					ctx,
					`preflight phase \`${pre.id}\` has ${pending.length} unchecked item${
						pending.length === 1 ? "" : "s"
					}. Tick them with \`plan_task toggle\` before starting regular phases.\n${headline}${more}`,
					"warning",
				);
				modeState.stage = "planning";
				persist();
				return;
			}
			if (classified.kind === "post-handover" && plan) {
				// All regular phases terminal; surface the post-handover
				// checklist instead of falsely reporting "all done".
				const post = classified.phase;
				const pending = post.tasks.filter((t) => !t.done);
				const headline = pending
					.slice(0, 5)
					.map((t) => `  - [!] ${t.title}`)
					.join("\n");
				const more =
					pending.length > 5 ? `\n  … and ${pending.length - 5} more` : "";
				notify(
					ctx,
					`all regular phases are terminal (shipped or abandoned) — handover phase \`${post.id}\` has ${pending.length} pending item${
						pending.length === 1 ? "" : "s"
					} for you to complete:\n${headline}${more}`,
					"info",
				);
				modeState.stage = "planning";
				persist();
				return;
			}
			if (classified.kind === "blocked-on-deps" && plan) {
				// Planned phases exist but every one is blocked on an in-flight
				// or unresolvable parent. Surface the specific blocker so the
				// user can edit dependsOn or wait for the predecessor to ship.
				const reason =
					blockedReason(plan, classified.phase) ?? "blocked on dependencies";
				notify(
					ctx,
					`plan has planned phases but none are ready: \`${classified.phase.id}\` ${reason}. ` +
						"Edit dependsOn (phase update) to unblock, or wait for the predecessor to ship.",
					"warning",
				);
				modeState.stage = "planning";
				persist();
				return;
			}
			if (classified.kind === "use-phase" && plan) {
				phase = classified.phase;
				branch = phase.branch;

				// Driver-claim adoption guard. Refuse to adopt a phase already
				// being driven by another live session unless the user passed
				// `--takeover`. A stale claim (missing session file or session
				// quiet for >TTL) is silently broken — lets a crashed peer's
				// in-flight phase be picked up without manual intervention.
				const selfSessionId = ctx.sessionManager.getSessionId();
				const decision = evaluateClaim(phase, selfSessionId);
				if (decision.kind === "occupied" && !takeover) {
					const ageMin = Math.round(decision.ageMs / 60_000);
					notify(
						ctx,
						`phase \`${phase.id}\` is being driven by session ${decision.sessionId} ` +
							`(active ${ageMin}m ago). Re-run with \`/implement --takeover\` to adopt it anyway, ` +
							`or pick a different phase with \`/implement <phaseId>\`.`,
						"warning",
					);
					modeState.stage = "planning";
					persist();
					return;
				}
				if (decision.kind === "stale") {
					notify(
						ctx,
						`adopting phase \`${phase.id}\` from stale driver ${decision.sessionId} (${decision.reason}).`,
						"info",
					);
				}
				if (decision.kind === "occupied" && takeover) {
					notify(
						ctx,
						`taking over phase \`${phase.id}\` from session ${decision.sessionId} (--takeover).`,
						"warning",
					);
				}

				// `git checkout -B <branch>` is destructive: if <branch> already
				// exists, it resets it to HEAD (the default branch after
				// syncToDefault). Re-running /implement on an in-flight phase
				// must NOT do that — it would erase any commits the user has on
				// the phase branch. planImplementBranch decides per phase status:
				// create the branch on first activation (planned), resume
				// non-destructively when in flight (active / needs-attention),
				// or abort when the branch is missing locally so we don't
				// silently destroy work that may still be on a remote / reflog.
				const defaultBranch = modeState.defaultBranch ?? "main";
				const branchExists = runCommand(
					"git",
					["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
					{ cwd: ctx.cwd },
				).ok;
				branchPlan = planImplementBranch(
					plan,
					phase,
					defaultBranch,
					branchExists,
				);

				if (branchPlan.kind === "abort") {
					notify(ctx, branchPlan.reason, "error");
					return;
				}

				// Atomic (re-)claim. The `evaluateClaim` guard above runs before
				// the git work; a peer session can claim the phase in that window.
				// Re-check against fresh on-disk state *inside* the plan lock and
				// bail if it flipped to a live peer — this is what closes the
				// check-to-claim TOCTOU race that previously let two sessions
				// drive the same phase (both saw `available`/`stale`, both
				// claimed, last write won). `apply` runs on both the locked copy
				// (which the lock persists) and the local reference, so the
				// downstream seed/launch work sees the committed state without a
				// reload.
				const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
				const claimPlan = plan;
				const claimPhaseRef = phase;
				type ClaimResult =
					| { ok: true }
					| { ok: false; reason: "occupied"; sessionId: string }
					| { ok: false; reason: "missing" };
				const claimAtomically = async (
					apply: (p: PlanPhase) => void,
				): Promise<boolean> => {
					const out = await withPlanLock<ClaimResult>(
						claimPlan.slug,
						(fresh) => {
							const fp = fresh.phases.find((p) => p.id === claimPhaseRef.id);
							if (!fp) {
								return {
									result: { ok: false, reason: "missing" } as const,
									save: false,
								};
							}
							const d = evaluateClaim(fp, selfSessionId);
							if (d.kind === "occupied" && !takeover) {
								return {
									result: {
										ok: false,
										reason: "occupied",
										sessionId: d.sessionId,
									} as const,
									save: false,
								};
							}
							apply(fp);
							fresh.updatedAt = fp.updatedAt;
							return { ok: true } as const;
						},
					);
					if (out.ok) {
						apply(claimPhaseRef);
						claimPlan.updatedAt = claimPhaseRef.updatedAt;
						return true;
					}
					if (out.reason === "occupied") {
						notify(
							ctx,
							`phase \`${claimPhaseRef.id}\` was claimed by session ${out.sessionId} ` +
								"while the branch was being prepared. Re-run with " +
								"`/implement --takeover` to adopt it anyway, or pick a " +
								"different phase with `/implement <phaseId>`.",
							"warning",
						);
					} else {
						notify(
							ctx,
							`phase \`${claimPhaseRef.id}\` vanished from the plan on disk — aborting.`,
							"warning",
						);
					}
					if (modeState) modeState.stage = "planning";
					persist();
					return false;
				};

				if (branchPlan.kind === "create") {
					// First-time activation. Hop to the picked base before creating
					// the phase branch so it forks from the right ancestor; for the
					// linear case the base IS the default branch we're already on,
					// so no extra checkout fires.
					if (branchPlan.baseBranch !== defaultBranch) {
						const baseCo = runCommand(
							"git",
							["checkout", branchPlan.baseBranch],
							{ cwd: ctx.cwd },
						);
						if (!baseCo.ok) {
							notify(
								ctx,
								`checkout base ${branchPlan.baseBranch} failed: ${baseCo.stderr.trim()} — falling back to ${defaultBranch}`,
								"warning",
							);
						} else {
							notify(
								ctx,
								`forking ${branch} from ${branchPlan.baseBranch} (predecessor in flight)`,
								"info",
							);
						}
					}
					// `-B` here is intentional: silently overwrites a leftover
					// branch from a previous failed run on a still-`planned` phase.
					const checkout = runCommand("git", ["checkout", "-B", branch], {
						cwd: ctx.cwd,
					});
					if (!checkout.ok) {
						notify(
							ctx,
							`git checkout -B ${branch} failed: ${checkout.stderr.trim()}`,
							"error",
						);
						return;
					}
					const claimNow = new Date().toISOString();
					if (
						!(await claimAtomically((p) => {
							p.status = "active";
							p.worktreePath = ctx.cwd;
							p.updatedAt = claimNow;
							claimPhase(p, selfSessionId, sessionFile, claimNow);
						}))
					) {
						return;
					}
					if (reconcileWorktrees(plan, ctx)) savePlan(plan);
				} else {
					// Resume: phase branch exists and holds work. Plain checkout,
					// no reset — commits on the branch must survive the round-trip
					// through plan mode.
					const checkout = runCommand("git", ["checkout", branch], {
						cwd: ctx.cwd,
					});
					if (!checkout.ok) {
						notify(
							ctx,
							`git checkout ${branch} failed: ${checkout.stderr.trim()} — ` +
								"is the branch checked out in another worktree? " +
								"Try `git worktree list` to investigate.",
							"error",
						);
						return;
					}
					// Re-claim on resume: this session is now the live driver,
					// regardless of whether the prior driver was self, stale, or
					// just took over. Atomic re-check inside the plan lock guards
					// against a peer that claimed the phase during the checkout.
					const now = new Date().toISOString();
					if (
						!(await claimAtomically((p) => {
							claimPhase(p, selfSessionId, sessionFile, now);
							p.updatedAt = now;
						}))
					) {
						return;
					}
					notify(
						ctx,
						`resumed phase ${phase.id} on ${branch} (${phase.status})`,
						"info",
					);
				}
			} else {
				// No plan at all — legacy description-derived branch. /implement
				// outside a planned context is intentionally supported. No
				// session lifecycle for this case — the work continues in the
				// current session.
				branch = await createFeatureBranch(ctx, description);
				if (!branch) return;
				await launchExecution(ctx, null, null, branch, implementMode);
				return;
			}

			// At this point we have a plan + phase + branch and have done the
			// git lifecycle work. Now drive the session lifecycle.
			//
			//   - First activation (`create`) or orphan resume (no recorded
			//     `phase.sessionPath`): `ctx.newSession` with `seedPlanDoc` in
			//     setup. Capture the new session's path onto `phase.sessionPath`
			//     inside `withSession` and save the plan.
			//   - Resume with recorded session: `ctx.switchSession` to the
			//     stored path; pi rebinds and we run `launchExecution` in
			//     `withSession`.
			//
			// All post-replacement work (setMode, persist, sendMessage)
			// happens inside `withSession` because the previous ctx is stale
			// after session replacement.
			if (plan && phase) {
				const planRef = plan;
				const phaseRef = phase;
				const branchRef = branch;
				const needsNewSession =
					branchPlan?.kind === "create" || !phase.sessionPath;

				if (!hasSessionControl(ctx)) {
					const path = ctx.sessionManager.getSessionFile();
					if (path) {
						phaseRef.sessionPath = path;
						phaseRef.updatedAt = new Date().toISOString();
						planRef.updatedAt = phaseRef.updatedAt;
						savePlan(planRef);
					}
					await launchExecution(
						ctx,
						planRef,
						phaseRef,
						branchRef,
						implementMode,
					);
					return;
				}

				if (needsNewSession) {
					await ctx.newSession({
						setup: async (sm) => {
							seedPlanDoc(sm, planRef, phaseRef);
						},
						withSession: async (newCtx) => {
							const path = newCtx.sessionManager.getSessionFile();
							if (path) {
								phaseRef.sessionPath = path;
								phaseRef.updatedAt = new Date().toISOString();
								planRef.updatedAt = phaseRef.updatedAt;
								savePlan(planRef);
							}
							await launchExecution(
								newCtx,
								planRef,
								phaseRef,
								branchRef,
								implementMode,
							);
						},
					});
				} else if (phase.sessionPath) {
					await ctx.switchSession(phase.sessionPath, {
						withSession: async (newCtx) => {
							await launchExecution(
								newCtx,
								planRef,
								phaseRef,
								branchRef,
								implementMode,
							);
						},
					});
				}
			}
		}

		/**
		 * Post-session-replacement work shared by /implement's create, resume,
		 * and no-plan paths. Receives the (possibly newly-replaced) ctx and
		 * runs everything that needs the post-replacement session: mode flip,
		 * persistence, the followUp prompt that kicks the agent's first turn.
		 *
		 * For planned execution the seed entry (written in `setup`) carries
		 * the plan/tasks/instruction footer, so the followUp is minimal — it
		 * exists only to trigger the first agent turn. The legacy off-plan
		 * path keeps the longer free-text followUp.
		 */
		async function launchExecution(
			ctx: ExtensionContext,
			plan: Plan | null,
			phase: PlanPhase | null,
			branch: string,
			implementMode: ImplementMode = "auto",
		): Promise<void> {
			if (!modeState) return;
			modeState.branch = branch;
			modeState.stage = "executing";
			// launchExecution may run inside `withSession` after `ctx.newSession()`
			// or `ctx.switchSession()`, where the captured `pi` handle is
			// invalidated. Route session-bound writes through `ctx` (the
			// ReplacedSessionContext) instead. For non-replacement callers the
			// same calls hit the live session manager, so this path is uniform.
			// `appendSessionInfo` / `appendCustomEntry` exist on the full
			// SessionManager but not on the public ReadonlySessionManager type
			// `ctx.sessionManager` exposes — cast to the full type, matching the
			// pattern used elsewhere in this file.
			const sm = ctx.sessionManager as unknown as SessionManager;
			sm.appendSessionInfo(branch);
			// Capture the SessionManager-like surface for the process-level
			// crash handler. The handler only fires when stage==="executing",
			// so refreshing here is sufficient.
			crashSessionAccessor = {
				getSessionId: () => sm.getSessionId(),
				getSessionFile: () => sm.getSessionFile(),
				getEntries: () => sm.getEntries(),
			};
			if (modeState.mode === "plan") {
				clearPlanTurnSnapshot();
				disposeDelegateAgents(ctx);
			}
			applyExecutionMode(modeState, implementMode, (tools) =>
				pi.setActiveTools(tools),
			);
			sm.appendCustomEntry(STATE_ENTRY, modeState satisfies ModeState);
			setActiveMode(modeState.mode);
			updateWidget(ctx);

			const tasks = activeTasks(plan);
			const hasTasks = tasks.length > 0;
			const phaseId = phase?.id ?? null;
			notify(
				ctx,
				`on ${branch}${phaseId ? ` (phase ${phaseId}, ${tasks.length} task${tasks.length === 1 ? "" : "s"})` : ""} — executing`,
				"info",
			);

			const content = phaseId
				? `Begin executing phase \`${phaseId}\`. The plan and active tasks are loaded as session context.`
				: `Feature branch \`${branch}\` is ready. ${
						hasTasks
							? "Use `task(toggle, phaseId, taskId)` to mark each task done as you complete it."
							: "Edit files, run tests, and stop when the change is clean."
					}`;

			// `ctx.sendMessage` is exposed by `ReplacedSessionContext`; fall back
			// to the captured `pi` for non-withSession callers (no plan / no
			// session control), where the captured handle is still active.
			const sendMessage =
				(
					ctx as ExtensionContext & {
						sendMessage?: typeof pi.sendMessage;
					}
				).sendMessage ?? pi.sendMessage;
			sendMessage(
				{
					customType: EXT_ID,
					content,
					display: false,
					details: { branch, phaseId },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}

		// ---- Park path --------------------------------------------------------

		async function doShip(
			args: string | undefined,
			ctx: ExtensionCommandContext,
		): Promise<void> {
			const slug = modeState?.currentPlanSlug;
			if (!slug) {
				notify(ctx, "no plan active — run /plan first", "warning");
				return;
			}
			const plan = loadPlan(slug);
			if (!plan) {
				notify(ctx, `plan ${slug} not found on disk`, "error");
				return;
			}

			// Pick phase: explicit arg > first active phase > error. The arg
			// matcher is prefix-tolerant so legacy `/ship p-foo` invocations
			// still resolve `foo` (and vice versa).
			const arg = args?.trim();
			const phase = arg
				? plan.phases.find((p) => matchPhaseId(p.id, arg))
				: plan.phases.find((p) => p.status === "active");
			if (!phase) {
				notify(
					ctx,
					arg
						? `phase ${arg} not found in plan`
						: "no active phase to ship — set one to active first or pass /ship <phaseId>",
					"error",
				);
				return;
			}
			// Pre/post phases are manual checklists — there's no branch and no
			// PR to open. /ship is a no-op; user just toggles their tasks.
			const phaseKind = effectivePhaseKind(phase);
			if (phaseKind !== "regular") {
				notify(
					ctx,
					`phase \`${phase.id}\` is a ${phaseKind}-phase (manual checklist) — ` +
						"there's no branch to ship. Tick its tasks with `plan_task toggle` instead.",
					"warning",
				);
				return;
			}
			// /ship is idempotent: if the phase already has an open PR (either
			// because /ship was retried, or because the user shelled out to
			// raw `git push` + `gh pr create` mid-phase), reconcile plan state
			// to match reality and exit success rather than refusing or
			// double-creating. Cases covered:
			//   - status=shipped (already merged) → notify and exit
			//   - status=abandoned                → refuse (cannot ship a closed PR)
			//   - status=in-review with prNumber  → confirm PR still open; if
			//     merged, flip to shipped; if closed, refuse
			//   - status=active with existing PR  → reconcile to in-review and exit
			//   - status=active without PR        → ship as before
			if (phase.status === "shipped") {
				notify(
					ctx,
					`phase ${phase.id} is already shipped (merged)${phase.prNumber ? ` — PR #${phase.prNumber}` : ""}`,
					"info",
				);
				return;
			}
			if (phase.status === "abandoned") {
				notify(ctx, `phase ${phase.id} is abandoned; cannot ship`, "warning");
				return;
			}

			// Probe for an existing PR before deciding to ship. This is the
			// reconcile-when-work-already-done path (#150). We probe by
			// prNumber when set, then fall back to branch lookup so we
			// recover from manually-created PRs the agent never recorded.
			const worktreeCwd = effectiveWorktreePath(plan, phase);
			let existingPr: { number: number; url: string } | null = null;
			if (phase.prNumber) {
				const probed = probePrByNumber(phase.prNumber, worktreeCwd);
				if (probed) {
					if (probed.state === "merged") {
						phase.status = "shipped";
						phase.updatedAt = new Date().toISOString();
						plan.updatedAt = phase.updatedAt;
						savePlan(plan);
						if (reconcileWorktrees(plan, ctx)) savePlan(plan);
						updateWidget(ctx);
						notify(
							ctx,
							`phase ${phase.id} ➜ shipped (PR #${phase.prNumber} merged; reconciled from remote)`,
							"info",
						);
						return;
					}
					if (probed.state === "closed") {
						notify(
							ctx,
							`phase ${phase.id} PR #${phase.prNumber} is closed (not merged); resolve manually before re-shipping`,
							"warning",
						);
						return;
					}
					if (probed.state === "open") {
						existingPr = { number: phase.prNumber, url: probed.url };
					}
				}
			}
			if (!existingPr && phase.branch) {
				existingPr = probeOpenPrForBranch(phase.branch, worktreeCwd);
			}

			if (existingPr) {
				// Push any local commits that were added after the PR was opened.
				// The push is idempotent (reports "Everything up-to-date" when in
				// sync) so it is safe to run unconditionally.
				if (phase.branch) {
					const push = await pushBranchAsync(
						worktreeCwd,
						phase.branch,
						ctx.signal,
					);
					if (!push.ok) {
						const detail =
							push.stderr.trim() ||
							push.stdout.trim() ||
							`git exited with code ${push.exitCode}`;
						notify(
							ctx,
							`push to origin/${phase.branch} failed: ${detail} — ` +
								`local commits may not be on PR #${existingPr.number}. ` +
								"Reconciling plan status to in-review anyway; re-run /ship " +
								"or /sync once the push succeeds to land them on the PR.",
							"warning",
						);
					}
				}
				const drifted =
					phase.prNumber !== existingPr.number || phase.status !== "in-review";
				phase.prNumber = existingPr.number;
				phase.status = "in-review";
				phase.updatedAt = new Date().toISOString();
				plan.updatedAt = phase.updatedAt;
				savePlan(plan);
				if (reconcileWorktrees(plan, ctx)) savePlan(plan);
				updateWidget(ctx);
				notify(
					ctx,
					drifted
						? `phase ${phase.id} ➜ in-review (reconciled from existing PR #${existingPr.number}${existingPr.url ? ` ${existingPr.url}` : ""})`
						: `phase ${phase.id} already in-review (PR #${existingPr.number}${existingPr.url ? ` ${existingPr.url}` : ""}; nothing to do)`,
					"info",
				);
				// Still run the post-ship summary so a prior summariser failure
				// gets a retry on re-ship (writePhaseSummary is a no-op once
				// phase.summary exists). Only re-run the completion picker when
				// the reconcile actually changed something — re-shipping an
				// already-in-review phase with the same PR shouldn't re-pop the
				// "what next?" picker (and its PR sweep) on every invocation.
				await writePhaseSummary(ctx, plan, phase);
				if (drifted) {
					await runCompletionPromptIfDone(ctx, plan);
				}
				return;
			}

			if (phase.status !== "active") {
				notify(
					ctx,
					`phase ${phase.id} is in status ${phase.status}; can only ship active phases`,
					"warning",
				);
				return;
			}

			notify(ctx, `shipping phase ${phase.id}…`, "info");
			// Record per-phase token total *before* shipPhase so renderPrBody
			// includes the Tokens section in the initial PR body. The auto
			// session that just executed this phase is `ctx.sessionManager` at
			// /ship time. Mid-phase compaction entries (already pushed into
			// phase.tokens.midPhase[]) are preserved; the end-of-phase summary
			// call's cost is written by writePhaseSummary below and lives in
			// the plan doc rather than the PR body.
			recordPhaseTotalTokens(ctx, plan, phase);
			const result = await shipPhase(plan, phase, { signal: ctx.signal });
			if (!result.ok) {
				notify(ctx, `ship failed: ${result.error}`, "error");
				return;
			}

			phase.prNumber = result.prNumber;
			phase.status = "in-review";
			phase.updatedAt = new Date().toISOString();
			plan.updatedAt = phase.updatedAt;
			savePlan(plan);
			if (reconcileWorktrees(plan, ctx)) savePlan(plan);
			updateWidget(ctx);
			notify(
				ctx,
				result.reconciled
					? `phase ${phase.id} ➜ in-review (existing PR #${result.prNumber}${result.prUrl ? ` ${result.prUrl}` : ""}; nothing new pushed)`
					: `phase ${phase.id} ➜ in-review (PR #${result.prNumber}${result.prUrl ? ` ${result.prUrl}` : ""})`,
				"info",
			);

			// Generate the phase-end summary that future phases' seeds will
			// carry forward. Soft-fail: on summariser/model issues, the phase
			// just ships without a summary block in subsequent seeds.
			await writePhaseSummary(ctx, plan, phase);

			// If this was the last actionable phase, prompt the user for what
			// to do next: stay / start a fresh plan / archive.
			await runCompletionPromptIfDone(ctx, plan);
		}

		async function runCompletionPromptIfDone(
			ctx: ExtensionContext,
			plan: Plan,
		): Promise<void> {
			const prompt = buildCompletionPrompt(plan, ctx.hasUI);
			if (!prompt) return;

			// Sweep PRs and surface CI/review state in one notify before the
			// picker fires. Soft-fail: if `gh` is unavailable or every call
			// errors, skip the sweep and offer the existing options as before.
			let sweep: PrSweepResult[] | null = null;
			try {
				sweep = await runEndOfPlanPrSweep({ cwd: ctx.cwd, plan });
			} catch (err) {
				notify(
					ctx,
					`PR sweep failed: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
			let feedback: PrSweepResult | null = null;
			if (sweep && sweep.length > 0) {
				notify(ctx, summarisePrSweep(sweep), "info");
				feedback = pickFirstWithFeedback(sweep);
			}

			// Build "Watch for Copilot review" options for every open PR in the
			// sweep. These appear before the feedback option and the standard
			// three-option set so the most-actionable choices are at the top.
			const copilotOptions: Array<{ label: string; result: PrSweepResult }> = (
				sweep ?? []
			)
				.filter((r) => r.state === "open" && !r.error)
				.map((r) => ({
					label: `Watch for Copilot review on PR #${r.prNumber} (\`${r.phaseId}\`)`,
					result: r,
				}));

			const feedbackOption = feedback
				? `Open PR #${feedback.prNumber} (\`${feedback.phaseId}\`) in ask mode to address feedback`
				: null;

			const options = [
				...copilotOptions.map((o) => o.label),
				...(feedbackOption ? [feedbackOption] : []),
				...prompt.options,
			];

			const choice = await ctx.ui.select(prompt.title, options);

			// Copilot-watch pick: switch to ask mode on the PR branch, then fire
			// /triage copilot N as a follow-up so the watcher starts immediately.
			const copilotPick = copilotOptions.find((o) => o.label === choice);
			if (copilotPick) {
				await openFeedbackPhaseInAsk(ctx, plan, copilotPick.result.phaseId);
				pi.sendMessage(
					{
						customType: EXT_ID,
						content: `/triage copilot ${copilotPick.result.prNumber}`,
						display: false,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
				return;
			}

			if (feedbackOption && choice === feedbackOption && feedback) {
				await openFeedbackPhaseInAsk(ctx, plan, feedback.phaseId);
				return;
			}

			const decision = decideFromCompletionChoice(choice);
			if (decision.action === "stay") return;

			if (decision.action === "archive") {
				await doPlanArchive(plan.slug, ctx);
				return;
			}

			// `newPlan`: open a fresh session on the default branch, already in
			// plan mode. syncToDefault must run in the current (command) ctx
			// because it may show a confirm dialog; newSession then carries the
			// resolved branch name into the new context.
			//
			// On the auto-loop path the ctx coming from `agent_end` is a plain
			// `ExtensionContext` with no `newSession` — in that case we degrade
			// to a notify telling the user to open a fresh session manually.
			// The next `session_start` rehydrates plan mode from the cleared
			// slug below.
			if (!hasSessionControl(ctx)) {
				if (modeState) {
					modeState.currentPlanSlug = null;
					modeState.stage = "idle";
					persist();
				}
				notify(ctx, NEW_PLAN_STALE_MESSAGE, "info");
				return;
			}

			const priorTools = modeState?.priorTools ?? pi.getActiveTools();
			const defaultBranch = await syncToDefault(ctx);
			if (!defaultBranch) return;

			if (modeState) {
				modeState.currentPlanSlug = null;
				persist();
			}

			await ctx.newSession({
				withSession: async (newCtx) => {
					const planSlug = ensurePlanForRepo(newCtx);
					modeState = {
						mode: "plan",
						stage: "planning",
						branch: null,
						defaultBranch,
						priorTools,
						planText: null,
						currentPlanSlug: planSlug,
					};
					persist();
					applyModeTools();
					installFooter(newCtx);
					updateWidget(newCtx);
					recordPlanSessionPathIfMissing(newCtx, planSlug);
					notify(newCtx, `plan mode on ${defaultBranch}`, "info");
				},
			});
		}

		/**
		 * Set up the user to address review feedback on a specific phase's
		 * PR. Used by the end-of-plan sweep when a PR needs attention.
		 *
		 * The phase is `in-review` after `/ship`, which means its worktree
		 * was torn down. Bring the worktree back by flipping the phase to
		 * `needs-attention` (a valid `in-review` transition) and running
		 * {@link reconcileWorktrees}, then notify the user with the worktree
		 * path — they need to open a session there to actually work on the
		 * branch (the current pi session is bound to its own cwd).
		 *
		 * `modeState` is updated so when the user does open a session in
		 * the worktree it picks up where this left off. Best-effort: a
		 * missing branch / failed reconcile notifies and stays put.
		 */
		async function openFeedbackPhaseInAsk(
			ctx: ExtensionContext,
			plan: Plan,
			phaseId: string,
		): Promise<void> {
			const phase = plan.phases.find((p) => p.id === phaseId);
			if (!phase) {
				notify(ctx, `phase ${phaseId} not found in plan`, "error");
				return;
			}

			// Restore the worktree if /ship tore it down. `in-review` -> `needs-
			// attention` is a valid state-machine transition; `reconcileWorktrees`
			// then re-creates the worktree so the user has a clean checkout to
			// open a session in.
			if (phase.status === "in-review") {
				phase.status = "needs-attention";
				phase.updatedAt = new Date().toISOString();
				savePlan(plan);
			}
			reconcileWorktrees(plan, ctx);
			savePlan(plan);

			const wt = phase.worktreePath ?? worktreePath(plan, phase);
			notify(
				ctx,
				`Phase \`${phase.id}\` flagged needs-attention. Open a session in ${wt} ` +
					`(branch \`${phase.branch}\`) to address feedback on PR, then /commit and /ship.`,
				"info",
			);
			if (modeState) {
				modeState.branch = phase.branch;
				modeState.stage = "executing";
				pi.setSessionName(phase.branch);
				setMode("ask", ctx);
				persist();
			}
		}

		/**
		 * At /ship, summarise the just-shipped phase's auto session and store
		 * the result on `phase.summary`. Future phases' `seedPlanDoc` includes
		 * shipped phases' summaries verbatim, so phase N learns from phase
		 * N-1's discoveries without ingesting the raw auto-session.
		 *
		 * Idempotent: re-runs of /ship on a phase that already has a summary
		 * are a no-op (manual edits survive too).
		 *
		 * Failure modes are soft: missing normal-tier model, summariser error,
		 * or empty session all leave `phase.summary` unset and emit a
		 * warning. /ship continues normally; subsequent seeds gracefully omit
		 * the missing-summary block.
		 *
		 * Does NOT call `ctx.compact()` or `sm.appendCompaction`. The auto
		 * session is left untouched on disk; the summary is purely a plan-doc
		 * artefact.
		 */
		/**
		 * Aggregate every assistant message's token usage in the current
		 * (auto) session and write it to `phase.tokens.phase`. Idempotent:
		 * called both at /ship entry (so `renderPrBody` has the data) and
		 * later inside `writePhaseSummary` (which overwrites with the same
		 * value and adds `phase.tokens.summary`).
		 *
		 * Best-effort: a missing/empty session leaves `phase.tokens` as it
		 * was. Mid-phase compaction entries (`phase.tokens.midPhase[]`) are
		 * preserved — they're appended during compaction and never reset
		 * here.
		 */
		function recordPhaseTotalTokens(
			ctx: ExtensionContext,
			plan: Plan,
			phase: PlanPhase,
		): void {
			try {
				const entries = ctx.sessionManager.getEntries();
				const total = aggregateAssistantUsage(
					entries as unknown as Parameters<typeof aggregateAssistantUsage>[0],
				);
				const tokens = phase.tokens ?? { phase: total, midPhase: [] };
				tokens.phase = total;
				phase.tokens = tokens;
				phase.updatedAt = new Date().toISOString();
				plan.updatedAt = phase.updatedAt;
				savePlan(plan);
			} catch {
				// Telemetry must never block /ship. A persist failure here is
				// recoverable on the next savePlan.
			}
		}

		async function writePhaseSummary(
			ctx: ExtensionCommandContext,
			plan: Plan,
			phase: PlanPhase,
		): Promise<void> {
			// Summary is frozen once written: re-shipping a phase that gained
			// more commits keeps the original carry-forward text rather than
			// re-summarising. Intentional — regenerating on every re-ship would
			// burn a model call each time and churn the downstream seeds for a
			// phase that's already left the user's hands. The first write
			// happens at the /ship that opens the PR, which is the meaningful
			// boundary. A failed first attempt leaves `summary` unset, so the
			// next /ship retries (see #247).
			if (phase.summary) return;

			const summarise = await buildSummariseFn(ctx);
			if (!summarise) {
				notify(
					ctx,
					"phase summary skipped: no normal-tier model configured",
					"warning",
				);
				return;
			}

			// `buildSessionContext` is on the full SessionManager (not on the
			// public ReadonlySessionManager type pi exposes). Cast — the runtime
			// value is always a full SessionManager in pi-coding-agent.
			const sm = ctx.sessionManager as unknown as SessionManager;
			const messages = sm
				.buildSessionContext()
				.messages.filter((m) =>
					["user", "assistant", "toolResult", "compactionSummary"].includes(
						(m as { role?: string }).role ?? "",
					),
				);
			if (messages.length === 0) {
				notify(
					ctx,
					"phase summary skipped: auto session has no recorded messages",
					"warning",
				);
				return;
			}

			const maxTokens = readPhaseTokensSetting(ctx);
			const preamble = buildPhaseEndSummaryPreamble(plan, phase, maxTokens);
			const out = await summarise({
				messages: messages as Parameters<SummariseFn>[0]["messages"],
				preamble,
				maxTokens,
				signal: ctx.signal,
			});
			if (out === null) {
				notify(ctx, "phase summary skipped: summariser failed", "warning");
				return;
			}

			phase.summary = out.text.trim();
			// Walk the auto session and sum every assistant `usage` so the
			// shipped phase carries a record of what it actually cost. Mid-phase
			// compactions and the summary itself are added below.
			const phaseTotal = aggregateAssistantUsage(sm.getEntries());
			const tokens = phase.tokens ?? { phase: phaseTotal, midPhase: [] };
			tokens.phase = phaseTotal;
			if (out.usage) tokens.summary = out.usage;
			phase.tokens = tokens;
			phase.updatedAt = new Date().toISOString();
			plan.updatedAt = phase.updatedAt;
			savePlan(plan);
			notify(ctx, `phase ${phase.id} summary written (≤${maxTokens}t)`, "info");
		}

		async function doSync(ctx: ExtensionCommandContext): Promise<void> {
			const slug = modeState?.currentPlanSlug;
			if (!slug) {
				notify(ctx, "no plan active", "warning");
				return;
			}
			const plan = loadPlan(slug);
			if (!plan) {
				notify(ctx, `plan ${slug} not found on disk`, "error");
				return;
			}
			const before = plan.phases.map((p) => ({ id: p.id, status: p.status }));
			const { checked, failed } = syncPlanFromRemote(plan, ctx);
			plan.lastSyncedAt = new Date().toISOString();
			plan.updatedAt = plan.lastSyncedAt;
			savePlan(plan);
			if (reconcileWorktrees(plan, ctx)) savePlan(plan);
			updateWidget(ctx);

			const changes = plan.phases
				.map((p) => {
					const prev = before.find((b) => b.id === p.id);
					return prev && prev.status !== p.status
						? `${p.id}: ${prev.status} → ${p.status}`
						: null;
				})
				.filter((s): s is string => s !== null);
			const failureSuffix =
				failed > 0
					? ` (${failed}/${checked} PR check${checked === 1 ? "" : "s"} failed — is gh authenticated?)`
					: "";
			if (changes.length === 0) {
				notify(
					ctx,
					checked === 0
						? "sync complete — no PRs in flight"
						: `sync complete — no changes${failureSuffix}`,
					failed > 0 ? "warning" : "info",
				);
			} else {
				notify(
					ctx,
					`sync complete:\n  ${changes.join("\n  ")}${failureSuffix}`,
					failed > 0 ? "warning" : "info",
				);
			}
		}

		async function doWorktree(
			args: string | undefined,
			ctx: ExtensionCommandContext,
		): Promise<void> {
			const slug = modeState?.currentPlanSlug;
			if (!slug) {
				notify(ctx, "no plan active", "warning");
				return;
			}
			const plan = loadPlan(slug);
			if (!plan) {
				notify(ctx, `plan ${slug} not found on disk`, "error");
				return;
			}

			const sub = (args ?? "list").trim().split(/\s+/);
			const action = sub[0] || "list";

			if (action === "list") {
				const lines = plan.phases.map((p) => {
					const path = worktreePath(plan, p);
					const status = worktreeExists(plan, p) ? "exists" : "absent";
					return `  ${p.id} [${p.status}] — ${status}: ${path}`;
				});
				notify(ctx, `worktrees:\n${lines.join("\n") || "  (none)"}`, "info");
				return;
			}

			if (action === "prune") {
				// Orphan = worktree exists but the phase no longer needs one.
				const orphans = plan.phases.filter(
					(p) =>
						worktreeExists(plan, p) && !WORKTREE_STATUSES.includes(p.status),
				);
				if (orphans.length === 0) {
					notify(ctx, "no orphan worktrees", "info");
					return;
				}
				const removed: string[] = [];
				const skipped: string[] = [];
				for (const p of orphans) {
					const proceed = ctx.hasUI
						? await ctx.ui.confirm(
								`Remove worktree for ${p.id}?`,
								`Path: ${worktreePath(plan, p)}\nStatus: ${p.status}`,
							)
						: true;
					if (!proceed) {
						skipped.push(p.id);
						continue;
					}
					const r = removeWorktree(plan, p);
					if (r.ok) {
						removed.push(p.id);
					} else {
						skipped.push(`${p.id} (${r.error})`);
					}
				}
				notify(
					ctx,
					`pruned ${removed.length} worktree(s)${skipped.length > 0 ? `; skipped: ${skipped.join(", ")}` : ""}`,
					"info",
				);
				return;
			}

			notify(ctx, `unknown /worktree action: ${action}`, "warning");
		}

		/**
		 * Sync PR state on session start, fire-and-forget. Reports any newly
		 * shipped or abandoned phases via notify().
		 */
		async function syncPlanOnStart(ctx: ExtensionContext): Promise<void> {
			const slug = modeState?.currentPlanSlug;
			if (!slug) return;
			const plan = loadPlan(slug);
			if (!plan) return;
			const before = plan.phases.map((p) => ({ id: p.id, status: p.status }));
			syncPlanFromRemote(plan, ctx);
			plan.lastSyncedAt = new Date().toISOString();
			plan.updatedAt = plan.lastSyncedAt;
			savePlan(plan);
			if (reconcileWorktrees(plan, ctx)) savePlan(plan);
			updateWidget(ctx);

			const transitioned = plan.phases
				.map((p) => {
					const prev = before.find((b) => b.id === p.id);
					if (
						prev &&
						prev.status !== p.status &&
						TERMINAL_STATUSES.includes(p.status)
					) {
						return `${p.id}: → ${p.status}`;
					}
					return null;
				})
				.filter((s): s is string => s !== null);
			if (transitioned.length > 0) {
				notify(
					ctx,
					`since last session:\n  ${transitioned.join("\n  ")}\n  Run /worktree prune to clean up.`,
					"info",
				);
			}
		}

		/**
		 * Walk the plan's phases and ask `gh` for each PR's current state.
		 * Mutates `plan` in place. Returns counts so callers can distinguish
		 * "no PRs in flight" from "all gh calls failed" — important because a
		 * silent failure (gh not authed, no network, no remote) otherwise
		 * looks identical to a successful sync with no transitions.
		 */
		function syncPlanFromRemote(
			plan: Plan,
			ctx: ExtensionContext,
		): { checked: number; failed: number } {
			let checked = 0;
			let failed = 0;
			const now = () => new Date().toISOString();
			for (const phase of plan.phases) {
				if (TERMINAL_STATUSES.includes(phase.status)) continue;

				// Recovery path (#150): an `active` phase with a branch but no
				// recorded PR is the symptom of the user shelling out to raw
				// `git push` + `gh pr create` mid-phase. Probe by branch and
				// reconcile so /sync brings plan state back in line with remote.
				if (!phase.prNumber) {
					if (phase.status !== "active" || !phase.branch) continue;
					checked++;
					const found = probeOpenPrForBranch(phase.branch, ctx.cwd);
					if (!found) {
						// Soft-skip — no open PR for this branch is the normal
						// case; don't count as a failure.
						checked--;
						continue;
					}
					phase.prNumber = found.number;
					phase.status = "in-review";
					phase.updatedAt = now();
					plan.updatedAt = phase.updatedAt;
					continue;
				}

				checked++;
				const r = runCommand(
					"gh",
					[
						"pr",
						"view",
						String(phase.prNumber),
						"--json",
						"state,merged,mergedAt",
					],
					{ cwd: ctx.cwd },
				);
				if (!r.ok) {
					failed++;
					continue;
				}
				try {
					const data = JSON.parse(r.stdout) as {
						state: string;
						merged: boolean;
					};
					if (data.merged) {
						phase.status = "shipped";
						releasePhase(phase);
					} else if (data.state === "CLOSED") {
						phase.status = "abandoned";
						releasePhase(phase);
					}
				} catch {
					failed++;
				}
			}
			return { checked, failed };
		}

		// ---- Park path --------------------------------------------------------

		async function doPark(ctx: ExtensionContext): Promise<void> {
			if (!modeState) {
				notify(ctx, "no active session — run /plan first", "warning");
				return;
			}
			const slug = modeState.currentPlanSlug;
			if (!slug) {
				notify(
					ctx,
					"no plan to park — run /plan first to build phases and tasks",
					"error",
				);
				return;
			}
			const plan = loadPlan(slug);
			if (!plan) {
				notify(ctx, `plan ${slug} not found on disk`, "error");
				return;
			}
			if (plan.phases.length === 0) {
				notify(
					ctx,
					"plan has no phases — add at least one with phase before parking",
					"error",
				);
				return;
			}

			// Secret scan over plan title + every phase/task body.
			const scanText = [
				plan.title,
				...plan.phases.flatMap((p) => [
					p.title,
					p.goal,
					...p.tasks.flatMap((t) => [t.title, t.body]),
				]),
			].join("\n");
			const secretCheck = scanForSecrets(scanText);
			if (secretCheck.hasSecret) {
				const proceed = await ctx.ui.confirm(
					"Possible secret detected",
					`${secretCheck.reason ?? "unknown"}.\n\nPublishing to GitHub will expose it. Proceed anyway?`,
				);
				if (!proceed) {
					notify(ctx, "park aborted — redact secrets and retry", "warning");
					return;
				}
			}

			// Optional Copilot assignment, per phase. Phase/task content is
			// untrusted (derived from repo + prior agent output) so we add a
			// second explicit prompt-injection warning before opting in.
			let assignCopilot = false;
			if (ctx.hasUI) {
				assignCopilot = await ctx.ui.confirm(
					"Assign Copilot to each phase issue?",
					`Will assign @copilot to each of the ${plan.phases.length} phase issues. Each phase becomes a parallel coding-agent session — ${plan.phases.length} premium requests, ${plan.phases.length} PRs.\n\nOnly works on github.com (not GHES).`,
				);
				if (assignCopilot) {
					const confirmed = await ctx.ui.confirm(
						"Confirm: phase content is untrusted",
						"Phase goals and task bodies will be sent to a Copilot coding" +
							" session as part of each issue. They are derived from this" +
							" repo and prior agent output and may contain prompt-injection" +
							" attempts. We wrap them in quoted blocks with a non-instruction" +
							" preamble, but you should review the plan once more before" +
							" handing control to a remote agent.\n\nProceed?",
					);
					if (!confirmed) {
						assignCopilot = false;
						notify(
							ctx,
							"Copilot assignment cancelled — phases will be created without assignee",
							"info",
						);
					}
				}
			}

			const settings = readRelevantSettings(ctx.cwd);
			const parkCfg = (
				settings.extensionConfig?.[EXT_ID] as
					| Record<string, unknown>
					| undefined
			)?.park as Record<string, unknown> | undefined;
			const projectName = parkCfg?.githubProject as string | undefined;

			const tmpDir = mkdtempSync(join(tmpdir(), "modes-park-"));
			try {
				// Step 1: create the parent (plan) tracking issue.
				const parentBodyFile = join(tmpDir, "parent.md");
				const parentBody = renderParentIssueBody(plan);
				writeFileSync(parentBodyFile, parentBody, "utf8");
				const parentArgs = [
					"issue",
					"create",
					"--title",
					plan.title,
					"--body-file",
					parentBodyFile,
					"--label",
					"plan",
				];
				if (projectName) parentArgs.push("--project", projectName);

				const parentResult = await runCommandAsync("gh", parentArgs, {
					cwd: ctx.cwd,
					signal: ctx.signal,
				});
				if (!parentResult.ok) {
					notify(
						ctx,
						`gh issue create (parent) failed: ${parentResult.stderr.trim()}`,
						"error",
					);
					return;
				}
				const parentMatch = parentResult.stdout.match(/\/issues\/(\d+)/);
				if (!parentMatch) {
					notify(
						ctx,
						`gh issue create (parent) returned unexpected output: ${parentResult.stdout.trim()}`,
						"error",
					);
					return;
				}
				const parentNumber = Number.parseInt(parentMatch[1], 10);
				if (!Number.isFinite(parentNumber)) {
					notify(
						ctx,
						`gh issue create (parent) returned invalid number: ${parentMatch[1]}`,
						"error",
					);
					return;
				}
				plan.parentIssueNumber = parentNumber;

				// Step 2: create one issue per phase, link to parent.
				await createPhaseIssues(
					ctx,
					plan,
					parentNumber,
					tmpDir,
					projectName,
					assignCopilot,
				);

				plan.updatedAt = new Date().toISOString();
				savePlan(plan);

				const parentUrl =
					parentResult.stdout.match(/https?:\/\/\S+/)?.[0] ?? "";
				notify(
					ctx,
					`parked plan as #${parentNumber}${parentUrl ? ` (${parentUrl})` : ""} with ${plan.phases.length} phase issues`,
					"info",
				);
				modeState.stage = "idle";
				restorePriorTools();
				modeState.mode = "hack";
				persist();
				updateWidget(ctx);
			} finally {
				try {
					rmSync(tmpDir, { recursive: true, force: true });
				} catch {
					/* best-effort */
				}
			}
		}

		/**
		 * Quote untrusted text so it cannot be interpreted as live instructions
		 * by an LLM consuming the issue body. We:
		 *  - Replace any code fences in the input with a non-fence sentinel so
		 *    the block can't be terminated and "escape".
		 *  - Wrap the result in a fenced block with `text` language hint.
		 *
		 * This does NOT prevent prompt injection on its own — callers should
		 * also include a non-instruction preamble.
		 */
		/**
		 * Create one GitHub issue per phase, link them to the parent via the
		 * sub_issues API, and store the issue numbers back into the Plan.
		 */
		async function createPhaseIssues(
			ctx: ExtensionContext,
			plan: Plan,
			parentNumber: number,
			tmpDir: string,
			projectName: string | undefined,
			assignCopilot: boolean,
		): Promise<void> {
			const errors: string[] = [];

			for (const phase of plan.phases) {
				const bodyFile = join(tmpDir, `phase-${phase.id}.md`);
				writeFileSync(
					bodyFile,
					renderPhaseIssueBody(phase, parentNumber),
					"utf8",
				);
				const args = [
					"issue",
					"create",
					"--title",
					phase.title,
					"--body-file",
					bodyFile,
					"--label",
					"phase",
				];
				if (projectName) args.push("--project", projectName);
				if (assignCopilot) args.push("--assignee", "@copilot");

				const result = await runCommandAsync("gh", args, {
					cwd: ctx.cwd,
					signal: ctx.signal,
				});
				if (!result.ok) {
					errors.push(
						`phase ${phase.id} (${phase.title}): ${result.stderr.trim() || "unknown error"}`,
					);
					continue;
				}
				const urlMatch = result.stdout.match(/\/issues\/(\d+)/);
				if (!urlMatch) {
					errors.push(
						`phase ${phase.id}: could not parse issue number from "${result.stdout.trim()}"`,
					);
					continue;
				}
				const num = Number.parseInt(urlMatch[1], 10);
				if (!Number.isFinite(num)) {
					errors.push(`phase ${phase.id}: invalid issue number ${urlMatch[1]}`);
					continue;
				}
				phase.issueNumber = num;

				// Look up internal id (sub_issues API requires REST id, not number).
				const restView = await runCommandAsync(
					"gh",
					["api", `/repos/{owner}/{repo}/issues/${num}`, "--jq", ".id"],
					{ cwd: ctx.cwd, signal: ctx.signal },
				);
				if (!restView.ok) {
					errors.push(
						`phase ${phase.id}: REST id lookup for #${num} failed: ${restView.stderr.trim()}`,
					);
					continue;
				}
				const id = Number.parseInt(restView.stdout.trim(), 10);
				if (!Number.isFinite(id)) {
					errors.push(
						`phase ${phase.id}: invalid REST id "${restView.stdout.trim()}"`,
					);
					continue;
				}

				const link = await runCommandAsync(
					"gh",
					[
						"api",
						"--method",
						"POST",
						`/repos/{owner}/{repo}/issues/${parentNumber}/sub_issues`,
						"-F",
						`sub_issue_id=${id}`,
					],
					{ cwd: ctx.cwd, signal: ctx.signal },
				);
				if (!link.ok) {
					errors.push(
						`link phase ${phase.id} (#${num}) to parent #${parentNumber}: ${link.stderr.trim() || "unknown error"}`,
					);
				}
			}

			if (errors.length > 0) {
				notify(ctx, `phase issue errors:\n  ${errors.join("\n  ")}`, "warning");
			}
		}

		// ---- ask tool ---------------------------------------------------------

		pi.registerTool({
			name: "ask",
			label: "Ask",
			description:
				"Queue a clarifying question. Questions are batched and shown to the user " +
				"as a structured dialog after your turn ends. Provide options when the " +
				"question has a finite set of likely answers.",
			promptSnippet:
				"Queue a clarifying question for the user (shown as structured dialog at turn end)",
			promptGuidelines: [
				"Use `ask` when you need clarification before finalizing a plan or making a decision. " +
					"Each call queues one question. All queued questions are presented together as a structured " +
					"dialog after your turn ends. The user can pick a suggested option or type a free-text answer. " +
					"Provide 2\u20134 options when the question has a known set of likely answers. " +
					"Omit options for open-ended questions. " +
					"Do NOT ask questions inline in your response text when using this tool \u2014 " +
					"the dialog replaces inline questions.",
			],
			parameters: Type.Object({
				question: Type.String({ description: "The question to ask the user" }),
				options: Type.Optional(
					Type.Array(Type.String(), {
						description: "Suggested answer options (2-4 recommended)",
					}),
				),
				context: Type.Optional(
					Type.String({
						description:
							"Optional context shown as a preview pane (e.g. relevant code snippet)",
					}),
				),
			}),

			async execute(_toolCallId, params) {
				const id = `q-${nextQuestionId++}`;
				pendingQuestions.push({
					id,
					question: params.question,
					options: params.options,
					context: params.context,
				});
				return {
					content: [
						{
							type: "text",
							text: `Question queued (${pendingQuestions.length} pending). Will present to user at end of turn.`,
						},
					],
					details: {
						id,
						question: params.question,
						options: params.options,
						context: params.context,
					},
				};
			},
		});

		// ---- Delegate tools: explore + research ----------------------------

		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			// Show the target + question instead of a bare "Delegate", so a row
			// of concurrent delegate calls is self-describing in the transcript.
			renderCall: (args, theme) => {
				const to =
					args?.to === "researcher" || args?.to === "explorer" ? args.to : "?";
				const q =
					typeof args?.question === "string"
						? args.question.replace(/\s+/g, " ").trim()
						: "";
				const prefix = `Delegate → ${to}`;
				return {
					render(width: number): string[] {
						const styledPrefix = theme.fg("toolTitle", theme.bold(prefix));
						if (!q) return [truncateToWidth(styledPrefix, width, "…")];
						const avail = Math.max(8, width - prefix.length - 2);
						const qShort = q.length > avail ? `${q.slice(0, avail - 1)}…` : q;
						return [
							truncateToWidth(
								styledPrefix + theme.fg("muted", `: ${qShort}`),
								width,
								"…",
							),
						];
					},
					invalidate(): void {},
				};
			},
			description:
				"Delegate a question to a specialist sub-agent and get back a " +
				'concise, distilled answer (blocking). to="researcher" for web ' +
				'research; to="explorer" for codebase questions (plan mode only). ' +
				"The sub-agent's raw results never enter your context — you only " +
				"get the answer. Fire several delegate calls in one turn to run " +
				"them concurrently.",
			promptSnippet:
				"Delegate a question to a specialist; returns a distilled answer",
			promptGuidelines: [
				"Use delegate to push heavy lookups (web search, codebase " +
					"exploration) into a sub-agent so its raw output never bloats your " +
					"context — you receive only the distilled answer.",
				'to="researcher": web research (plan/auto/ask). to="explorer": ' +
					"codebase questions (plan mode only).",
				"delegate blocks until the answer returns. Emit multiple delegate " +
					"calls in a single turn to run them in parallel.",
			],
			parameters: Type.Object({
				to: Type.Union([Type.Literal("researcher"), Type.Literal("explorer")], {
					description:
						'Which specialist: "researcher" (web search) or "explorer" ' +
						"(codebase questions, plan mode only).",
				}),
				question: Type.String({ description: "The question to delegate." }),
				timeoutMs: Type.Optional(
					Type.Number({
						description:
							"Hard timeout in ms. For researcher, bounds the web subprocess; " +
							"for explorer, bounds the wait for the codebase answer. Overrides " +
							"`extensionConfig.modes.research.timeoutMs`.",
					}),
				),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const cap = readDelegateMaxChars(ctx);
				if (params.to === "researcher") {
					const rawOverride = params.timeoutMs;
					const timeoutMs =
						rawOverride != null &&
						Number.isFinite(rawOverride) &&
						rawOverride > 0
							? rawOverride
							: readResearchTimeoutMs(ctx);
					const outcome = await ensureDelegateAgents(ctx).cappedResearch(
						params.question,
						{
							timeoutMs,
							signal,
							maxConcurrent: readDelegateMaxConcurrent(ctx),
						},
					);
					if (!outcome.ok) return formatResearchOutcome(ctx, outcome);
					const text = capDelegatedAnswer(outcome.text, cap);
					return {
						content: [{ type: "text", text }],
						details: { to: "researcher", elapsedMs: outcome.elapsedMs },
					};
				}
				// explorer — plan mode only (where the explore mailbox is wired)
				if (modeState?.mode !== "plan") {
					return {
						content: [
							{
								type: "text",
								text:
									'[delegate] to:"explorer" is only available in plan mode. ' +
									'Use to:"researcher" for web research.',
							},
						],
						details: {
							error: "explorer-not-available",
							mode: modeState?.mode ?? null,
						},
					};
				}
				const mailbox = ensureExploreMailbox(ctx);
				const { id } = await mailbox.ask(params.question);
				const task = await mailbox.wait(id, params.timeoutMs);
				if (task.status === "error" || task.status === "timeout") {
					return {
						content: [
							{
								type: "text",
								text: `[delegate explorer ${task.status}] ${task.error ?? "no answer"}`,
							},
						],
						details: { to: "explorer", status: task.status, error: task.error },
					};
				}
				const text = capDelegatedAnswer(task.text ?? "", cap);
				return {
					content: [{ type: "text", text }],
					details: { to: "explorer" },
				};
			},
		});

		// ---- Plan tools (phase / task) ---------------------------------------

		registerPlanTools(pi, {
			getCurrentPlanSlug: () => modeState?.currentPlanSlug ?? null,
			onPlanChanged: (plan, ctx) => {
				// Plan mode advertises read-only access through three layers (tool
				// gating, system prompt, bash classifier). Don't let phase
				// side-effects bypass that contract by mutating the filesystem.
				// Worktree reconciliation only runs in ask/auto, where the agent
				// is allowed to make changes anyway.
				if (modeState && modeState.mode !== "plan") {
					if (reconcileWorktrees(plan, ctx)) savePlan(plan);
				}
				updateWidget(ctx);
			},
		});

		// ---- Session lifecycle ------------------------------------------------

		// Refresh the footer when the reasoning level changes so the model
		// label's `(level)` suffix stays current. The footer reads the live
		// value via pi.getThinkingLevel() on render; this just nudges it.
		pi.on("thinking_level_select", async () => {
			footerTui?.requestRender();
		});

		pi.on("session_start", async (_event, ctx) => {
			hydrateMode(ctx);
			hydratePlan(ctx);
			summaryBudgetWarnFired = false;
			pinnedSysTokens = null;

			// Fire-and-forget sync of PR state for the active plan. Reports
			// shipped/abandoned phases since last session.
			syncPlanOnStart(ctx).catch(() => {
				/* best-effort */
			});

			if (!modeState) {
				// First session — capture baseline tools, default mode is
				// configurable via extensionConfig.modes.mode.default (default "plan").
				const { mode: defaultMode, valid } = readDefaultModeSetting(ctx);
				if (!valid) {
					notify(
						ctx,
						'modes: invalid mode.default setting (expected "plan" | "auto" | "hack") — falling back to "plan"',
						"warning",
					);
				}
				// When booting straight into plan mode in a git repo, materialise
				// the plan file up front so phase / task work without
				// the user first running `/plan`. Outside a git repo we leave the
				// slug null — same behaviour as today. Filesystem failures
				// (unwritable `~/.pi/plans`, full disk, ...) must not break
				// session_start; fall back to a null slug + warning instead.
				let initialPlanSlug: string | null = null;
				if (defaultMode === "plan" && isGitRepo(ctx.cwd)) {
					try {
						initialPlanSlug = ensurePlanForRepo(ctx);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						notify(
							ctx,
							`modes: failed to initialize plan for fresh session — ${msg}`,
							"warning",
						);
					}
				}
				modeState = {
					mode: defaultMode,
					stage: "idle",
					branch: null,
					defaultBranch: null,
					priorTools: pi.getActiveTools(),
					planText: null,
					currentPlanSlug: initialPlanSlug,
				};
				// Don't persist yet — only persist when the user actively changes mode.
				// Mirror the in-memory mode to the shared accessor so /commit and any
				// other reader see the actual default mode (otherwise they get null
				// and fall back to the strict copy on every fresh session).
				setActiveMode(modeState.mode);
				if (modeState.mode === "plan") {
					ensureExploreOverviewService().ensureStarted(ctx);
				}
				applyModeTools();
				installFooter(ctx);
				updateWidget(ctx);
				return;
			}

			// Restore tool restrictions for the persisted mode.
			if (modeState.mode === "plan") {
				ensureExploreOverviewService().ensureStarted(ctx);
			}
			applyModeTools();
			installFooter(ctx);
			updateWidget(ctx);
		});

		pi.on("session_tree", async (_event, ctx) => {
			hydratePlan();
			updateWidget(ctx);
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			// Remove our custom footer so we don't leave it installed across
			// session switches (/new, /resume, /fork).
			if (ctx?.hasUI) ctx.ui.setFooter(undefined);
			teardownPlanOverlay();
			teardownSidebar();
			footerTui = null;
			panelTheme = null;
			crashSessionAccessor = null;
			exploreOverviewService?.reset();
			disposeDelegateAgents(ctx);
		});

		// ---- session_before_compact: modes-flavoured mid-phase compaction ----
		//
		// Fires when ctx.compact() is invoked (modes triggers it from
		// compactPhaseSlice; pi may also trigger it from auto-compaction or the
		// /compact command). When `pendingCompactionKind` is set we know it's
		// modes-driven and we substitute our summary; otherwise we return `{}`
		// and let pi run its default compaction logic.
		//
		// Returning `{ compaction: { ... } }` causes pi to:
		//   1. sessionManager.appendCompaction(summary, firstKeptEntryId, ...)
		//   2. agent.state.messages = sessionManager.buildSessionContext().messages
		//   3. emit `session_compact`
		// Step 2 is the rebuild that the legacy direct-write path skipped.

		pi.on("session_before_compact", async (event, ctx) => {
			const pending = pendingCompactionKind;
			pendingCompactionKind = null;
			if (!pending) return {};

			const plan = currentPlan();
			if (!plan) return {};

			const summarise = await buildSummariseFn(ctx);
			if (!summarise) {
				if (!warnedNoCompactionModel) {
					warnedNoCompactionModel = true;
					notify(
						ctx,
						"compaction skipped: no normal-tier model configured (set backgroundModels.primary.normal or extensionConfig.modes.model)",
						"warning",
					);
				}
				return { cancel: true };
			}

			const sm = ctx.sessionManager as unknown as SessionManager;
			const result = await buildPhaseSliceCompactionResult({
				sm,
				plan,
				summarise,
				maxTokens: readPhaseTokensSetting(ctx),
				tokensBefore: event.preparation.tokensBefore,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				phaseId: pending.phaseId,
				signal: event.signal,
			});
			if (!result) return { cancel: true };

			// Record mid-phase compaction usage so /ship can sum it into the
			// phase total. Best-effort: a plan write here is independent of pi's
			// own compaction-side state, and a savePlan failure must not block
			// the compaction from completing.
			if (result.usage) {
				const phase = plan.phases.find((p) => p.id === pending.phaseId);
				if (phase) {
					const tokens = phase.tokens ?? {
						phase: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						midPhase: [],
					};
					tokens.midPhase = [...tokens.midPhase, result.usage];
					phase.tokens = tokens;
					phase.updatedAt = new Date().toISOString();
					plan.updatedAt = phase.updatedAt;
					try {
						savePlan(plan);
					} catch {
						// Best-effort — telemetry must never break compaction.
					}
				}
			}

			// Strip our extension-only `usage` field before handing back to pi:
			// `CompactionResult` doesn't model it, and pi only consumes
			// {summary, firstKeptEntryId, tokensBefore, details}.
			const { usage: _u, ...piCompaction } = result;
			void _u;
			return { compaction: piCompaction };
		});

		// ---- System prompt injection ------------------------------------------

		pi.on("before_agent_start", async () => {
			pendingQuestions = [];
			if (!modeState) return;

			if (modeState.mode === "plan") {
				// Capture once per plan-mode-entry. Conditional capture preserves
				// the snapshot across `ask`-tool question rounds so the picker
				// fires once with the cumulative diff. Cleared on plan-mode
				// exit, on slug change, and when the picker actually fires.
				if (planTurnSnapshot === null) {
					planTurnSnapshot = snapshotPlanStructure(currentPlan());
				}
				return {
					message: {
						customType: CUSTOM_MODE_CONTEXT,
						content: [
							"[PLAN MODE — read-only exploration]",
							"",
							"You may only read the codebase — no file writes, no git mutations.",
							"This applies to ALL methods: the edit/write tools are absent, and",
							"bash commands that write to files (redirects, tee, sed -i, etc.)",
							"will be blocked.",
							"",
							"The `gh` CLI is available for coordination: viewing issues/PRs,",
							"searching code, querying CI status, creating issues, and commenting.",
							"These are remote operations that don't mutate local state — the",
							"'no writes' contract refers to local filesystem and git mutations.",
							"",
							"Use the plan tools to build a structured plan with phases and tasks:",
							"  phase(add, title, goal?, position?)         → add a phase",
							"  phase(update, id, title?, goal?, status?)    → update a phase",
							"  phase(remove, id) | phase(reorder, id, position) | phase(list)",
							"  task(add, phaseId, title, body?)             → add a task",
							"  task(toggle, phaseId, taskId)                → mark a task done",
							"  task(update | remove | move)                 → edit / move tasks",
							"  plan()                                       → show the current plan",
							"",
							"A phase ships as one PR / one issue. Tasks are concrete work items inside",
							"a phase — keep titles short and put detail (acceptance criteria, files,",
							"tests) in the body.",
							"",
							"When you have a clear plan: build it with phase + task, present",
							"a summary to the user, then stop. The user will choose to implement,",
							"park as GitHub issues, or keep discussing.",
							"",
							"When you need clarification before finalizing the plan, use the `ask` tool:",
							"  ask(question, options?, context?)",
							"Each call queues one question. All queued questions are presented together",
							"as a structured dialog after your turn ends. The user can pick a suggested",
							"option or type a free-text answer.",
							"Do NOT ask questions inline in your response when using the `ask` tool —",
							"the dialog replaces inline questions.",
							"",
							"To keep this context lean, delegate heavy lookups to a specialist",
							"sub-agent — its raw results never enter your context, you get only",
							"the distilled answer:",
							'  delegate({ to: "researcher", question })  → web research',
							'  delegate({ to: "explorer", question })    → codebase questions (plan mode)',
							"delegate blocks until the answer returns. Fire several delegate calls",
							"in one turn to run them concurrently.",
						].join("\n"),
						details: { modeMarker: "plan" as const },
						display: false,
					},
				};
			}

			if (modeState.mode === "hack") {
				return {
					message: {
						customType: CUSTOM_MODE_CONTEXT,
						content: [
							"[HACK MODE — full tool access, no plan structure]",
							"",
							"The user is exploring or making a quick change. There is no",
							"plan/phase to follow and no compaction will fire automatically —",
							"context length is the user's responsibility.",
							"",
							"Do NOT invoke `phase`, `task`, or `plan` unless",
							"the user explicitly asks. Just do the work.",
						].join("\n"),
						details: { modeMarker: "hack" as const },
						display: false,
					},
				};
			}

			if (modeState.mode === "auto" || modeState.mode === "ask") {
				const plan = currentPlan();
				const tasks = activeTasks(plan);
				const phase = activePhase(plan);
				if (tasks.length === 0 || modeState.stage !== "executing") {
					// Even when the auto preamble itself doesn't fire (e.g. no
					// active tasks), we still consume any pending classifier flag
					// so it doesn't leak into the next turn.
					pendingSteeringClassifier = false;
					return;
				}
				const remaining = tasks.filter(({ task }) => !task.done);
				if (remaining.length === 0) {
					pendingSteeringClassifier = false;
					return;
				}
				// Split by kind so the agent gets a clean "these are yours" vs
				// "these are notes for the human" signal. The completion gate
				// only counts deliverables, so a phase with only non-deliverables
				// remaining would already have triggered exec-complete — but the
				// preamble still surfaces them so the agent is aware they exist
				// (e.g. open questions to consider while implementing).
				const remainingDeliverables = remaining.filter(
					({ task }) => effectiveTaskKind(task) === "deliverable",
				);
				const remainingNotes = remaining.filter(
					({ task }) => effectiveTaskKind(task) !== "deliverable",
				);
				const includeClassifier = pendingSteeringClassifier;
				pendingSteeringClassifier = false;
				const modeBanner =
					modeState.mode === "auto"
						? "[AUTO MODE — executing plan]"
						: "[ASK MODE — executing plan, will pause at commit/ship boundaries]";
				const lines: string[] = [
					modeBanner,
					"",
					`Active phase: \`${phase?.id ?? "(unknown)"}\` — only this phase's tasks are in scope.`,
					"Do NOT start work on other phases. When all of this phase's deliverables are done, run /ship.",
					"Route commit/push/PR work through /commit and /ship — don't shell out to `git commit`, `git push`, or `gh pr create` directly. If you already did, /sync will reconcile.",
					"",
				];
				// If this phase depends on a predecessor, surface its authoritative
				// plan state so the agent doesn't infer push/PR status from git
				// (which may be stale, wrong worktree, or out of sync).
				if (phase && plan) {
					const parentId = effectiveDependsOn(plan, phase)[0];
					if (parentId) {
						const parent = plan.phases.find((p) => p.id === parentId);
						if (parent) {
							let parentInfo = `Predecessor \`${parent.id}\`: status=\`${parent.status}\``;
							if (parent.branch) parentInfo += `, branch=\`${parent.branch}\``;
							if (parent.prNumber) parentInfo += `, PR=#${parent.prNumber}`;
							lines.push(
								`${parentInfo} — trust this, do not re-check its push/PR state from git.`,
								"",
							);
						}
					}
				}
				if (remainingDeliverables.length > 0) {
					lines.push(
						"Remaining deliverables (titles short — see `plan` for full body):",
						...remainingDeliverables.map(({ task }) => `  ${task.title}`),
						"",
					);
				}
				if (remainingNotes.length > 0) {
					lines.push(
						"Notes / open questions / manual steps for the human reviewer",
						"(NOT for you to tick — these surface in the PR body for the",
						"reviewer; treat as context, not as work):",
						...remainingNotes.map(({ task }) => {
							const kind = effectiveTaskKind(task);
							return `  [${kind}] ${task.title}`;
						}),
						"",
					);
				}
				lines.push(
					"Execute each deliverable in order. Call task(toggle, phaseId, taskId)",
					"after completing each one. Do not stop to ask for confirmation unless",
					"genuinely stuck.",
					"If you need to look up a library, API, or external reference: " +
						'delegate({ to: "researcher", question }).',
				);
				if (includeClassifier) {
					lines.push("", STEERING_CLASSIFIER);
				}
				return {
					message: {
						customType: CUSTOM_MODE_CONTEXT,
						content: lines.join("\n"),
						details: { modeMarker: modeState.mode },
						display: false,
					},
				};
			}
		});

		// Strip stale context messages from LLM payload when they are no longer
		// relevant (e.g. plan mode context after switching to auto).
		pi.on("context", async (event) => {
			const currentMode = modeState?.mode;
			return {
				messages: event.messages.filter((m) => {
					const ct = (m as { customType?: string }).customType;
					if (ct !== CUSTOM_MODE_CONTEXT) return true;
					// Keep the injected context only for the mode that produced it.
					// details.modeMarker is the authoritative discriminator — content-string
					// matching would silently break on any wording change.
					const marker = (m as { details?: { modeMarker?: string } }).details
						?.modeMarker;
					return marker === currentMode;
				}),
			};
		});

		// ---- Steering classifier flag ----------------------------------------
		//
		// In auto mode, a free-text user message during /implement arrives as
		// the most-recent / most-specific instruction and the agent reliably
		// pivots to it. We don't *block* steering — sometimes the user really
		// does want an immediate course correction — but we tag the message so
		// the next `before_agent_start` appends a 4-way routing classifier to
		// the auto-mode preamble (display: false; user only sees their own text).
		//
		// Slash commands, skills, templates, and extension-injected messages
		// pass through unchanged — see shouldInjectSteeringClassifier.
		pi.on("input", async (event) => {
			pendingSteeringClassifier = false;
			if (!modeState) return { action: "continue" };
			if (
				shouldInjectSteeringClassifier({
					text: event.text,
					source: event.source,
					mode: modeState.mode,
					plan: currentPlan(),
				})
			) {
				pendingSteeringClassifier = true;
			}
			return { action: "continue" };
		});

		// ---- Tool call enforcement --------------------------------------------

		pi.on("tool_call", async (event, ctx) => {
			if (!modeState) return;

			if (modeState.mode === "plan") {
				if (event.toolName === "edit" || event.toolName === "write") {
					return {
						block: true,
						reason:
							"modes: edit/write are disabled in plan mode. " +
							"Switch to ask or auto mode to make changes.",
					};
				}
				if (event.toolName === "bash") {
					const command = (event.input as { command?: string }).command ?? "";
					const result = await classifyBashCommand(command, ctx);
					if (result.verdict === "allow") return;
					if (result.verdict === "redirect") {
						return {
							block: true,
							reason: `Use the \`${result.tool ?? "read"}\` tool instead — ${result.reason}`,
						};
					}
					return {
						block: true,
						reason: `modes (plan): ${result.reason}`,
					};
				}
				return;
			}

			// auto and hack: full tools, no confirmation. Plan-mode write
			// protection is the only mode-level gate; everything else is the
			// agent's call.
		});

		// ---- Connection-error recovery dialog ----------------------------------

		async function handleConnectionError(
			ctx: ExtensionContext,
			errMsg: string,
		): Promise<void> {
			let dialogMod: typeof import("@vegardx/pi-questions") | null = null;
			try {
				dialogMod = await import("@vegardx/pi-questions");
			} catch {
				// questions not available; surface as plain notify.
				notify(ctx, `Connection error: ${errMsg}. Retry manually.`, "error");
				return;
			}

			const result = await dialogMod.showQuestions(ctx, {
				title: "Connection error",
				items: [
					{
						id: "action",
						label: "What would you like to do?",
						prompt: errMsg,
						badge: "error",
						options: [
							{
								value: "retry",
								label: "Retry",
								description: "Re-send the last message and try again",
							},
							{
								value: "pause",
								label: "Pause",
								description: "Stop here — resume manually when ready",
							},
							{
								value: "abort",
								label: "Abort",
								description: "Discard the turn and do nothing",
							},
						],
					},
				],
			});

			if (
				result.cancelled ||
				result.answers.find((a) => a.id === "action")?.value !== "retry"
			)
				return;

			pi.sendMessage(
				{
					customType: EXT_ID,
					content:
						"[Connection error was transient — please retry the last turn.]",
					display: false,
					details: { connectionErrorRetry: true },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}

		// ---- Completion detection ---------------------------------------------

		pi.on("agent_end", async (event, ctx) => {
			// Connection error guard: pop Retry / Pause / Abort before any other
			// completion logic so the user can recover without disrupting plan state.
			if (ctx.hasUI) {
				const connErr = findConnectionError(
					event.messages as ReadonlyArray<{
						role: string;
						stopReason?: string;
						errorMessage?: string;
					}>,
				);
				if (connErr) {
					runDetached("connection-error dialog", ctx, () =>
						handleConnectionError(ctx, connErr),
					);
					return;
				}
			}

			// If the agent queued questions via the `ask` tool, present them
			// as a structured dialog and feed answers back. This takes priority
			// over the plan picker — the agent needs answers before it can
			// finalize.
			if (pendingQuestions.length > 0 && ctx.hasUI) {
				const questions = [...pendingQuestions];
				pendingQuestions = [];
				runDetached("ask dialog", ctx, () => showAskDialog(ctx, questions));
				return;
			}

			// Plan phase: auto-pop picker once the agent has built or refined
			// the plan. Two gates suppress the pop:
			//   1. Actionability — at least one phase must be planned / active
			//      / needs-attention. Fully shipped plans have nothing left to
			//      decide.
			//   2. Plan changed this turn — snapshot taken in before_agent_start
			//      must differ from the current plan structure.
			// See packages/modes/plan/picker.ts for the gate logic and the
			// snapshot lifecycle reasoning.
			const plan = currentPlan();
			if (
				shouldFirePicker({
					mode: modeState?.mode,
					stage: modeState?.stage,
					plan,
					snapshot: planTurnSnapshot,
					hasUI: ctx.hasUI,
				}) &&
				modeState
			) {
				modeState.stage = "awaiting-choice";
				persist();
				clearPlanTurnSnapshot();
				runDetached("plan picker", ctx, () => runPicker(ctx));
				return;
			}

			// Fixing phase complete — agent finished applying review fixes.
			if (modeState?.stage === "fixing") {
				modeState.stage = "exec-complete";
				persist();
				updateWidget(ctx);
				runDetached("post-fix picker", ctx, () => runPostExecPicker(ctx));
				return;
			}

			if (!modeState || modeState.stage !== "executing") return;
			// Completion check is scoped to the active phase and to *deliverable*
			// tasks only: question / followUp / manual tasks carry information
			// for the human reviewer (open questions, manual smoke steps,
			// reviewer follow-ups) and don't block the agent from finishing.
			// They surface in /ship's PR body and /park's issue body instead.
			const allTasks = activeTasks(plan);
			const deliverables = allTasks.filter(
				({ task }) => effectiveTaskKind(task) === "deliverable",
			);
			const notes = allTasks.filter(
				({ task }) => effectiveTaskKind(task) !== "deliverable",
			);
			// Gate-diagnostic helper: emits a named warning for unusual stalls
			// (e.g. executing with zero tasks/deliverables) so the user can
			// diagnose why the auto-loop didn't fire. Silent for the common
			// cases (incomplete work, wrong stage) to avoid notify spam (#149).
			const completion = diagnoseAgentEndCompletion({
				modeState,
				taskCount: allTasks.length,
				deliverableCount: deliverables.length,
				deliverablesRemaining: deliverables.filter(({ task }) => !task.done)
					.length,
			});
			if (!completion.proceed) {
				if (
					completion.diagnostic &&
					(modeState.mode === "auto" || modeState.mode === "ask")
				) {
					// No active phase at all (e.g. session resumed after a phase
					// shipped): in auto mode, advance to the next ready phase
					// rather than stopping. This covers the common case of a
					// new session starting mid-plan with stage=executing but
					// no phase currently marked active.
					if (
						completion.gate === "no-tasks" &&
						modeState.mode === "auto" &&
						plan &&
						activePhase(plan) === null
					) {
						const selfSessionId = ctx.sessionManager.getSessionId();
						const candidates = readyPhases(plan).filter((p) => {
							const d = evaluateClaim(p, selfSessionId);
							return d.kind !== "occupied";
						});
						const adopt = candidates[0];
						if (adopt) {
							notify(
								ctx,
								`auto: no active phase — advancing to \`${adopt.id}\`…`,
								"info",
							);
							await doImplement(ctx, null, "auto", false, adopt.id);
							return;
						}
					}
					notify(
						ctx,
						`auto-loop: stopped at gate "${completion.gate}" — ${
							completion.gate === "no-tasks"
								? `active phase \`${activePhase(plan)?.id ?? "unknown"}\` has no tasks; use task(add) to add at least one deliverable`
								: "active phase has no deliverables (only notes); add a deliverable task to enable auto-completion"
						}`,
						"warning",
					);
				}
				return;
			}

			// All deliverables in the active phase complete.
			const completedPhase = activePhase(plan);
			modeState.stage = "exec-complete";
			persist();
			updateWidget(ctx);

			const KIND_MARKER: Record<string, string> = {
				question: "[?]",
				manual: "[!]",
				followUp: "[~]",
			};
			const deliverableLines = deliverables
				.map(({ task }) => `- ✓ ${task.title}`)
				.join("\n");
			const notesSection =
				notes.length > 0
					? `\n\n_Notes for the human reviewer (not gating completion):_\n${notes
							.map(({ task }) => {
								const kind = effectiveTaskKind(task);
								return `- ${KIND_MARKER[kind] ?? "-"} ${task.title} _(${kind})_`;
							})
							.join("\n")}`
					: "";

			pi.sendMessage(
				{
					customType: `${EXT_ID}-complete`,
					content: `**Phase \`${completedPhase?.id ?? "(unknown)"}\` complete on \`${modeState.branch ?? "current branch"}\`!** ✓\n\n${deliverableLines}${notesSection}\n\nRun /ship to open the PR for this phase.`,
					display: true,
					details: {
						branch: modeState.branch,
						phaseId: completedPhase?.id,
						taskCount: deliverables.length,
					},
				},
				{ triggerTurn: false },
			);

			updateWidget(ctx);

			// Run either auto-loop (commit→ship→next) or the ask-mode post-exec
			// picker. Branch is decided by mode at
			// completion time, not at /implement time, so a Shift+Tab from
			// auto→hack mid-phase still does the right thing for the user's
			// current intent.
			runDetached("post-exec", ctx, async () => {
				if (postExecInFlight) return;
				postExecInFlight = true;
				try {
					await new Promise<void>((resolve) => setImmediate(resolve));

					if (modeState?.mode === "auto") {
						if (!plan) {
							notify(
								ctx,
								"auto loop skipped: no plan bound (falling back to ask-mode picker)",
								"warning",
							);
						} else {
							try {
								await runAutoPhaseLoop(ctx, plan, completedPhase);
								return;
							} catch (err) {
								notify(
									ctx,
									`auto loop failed: ${err instanceof Error ? err.message : String(err)} — dropping into ask-mode picker so you can recover`,
									"error",
								);
							}
						}
					}
					await runPostExecPicker(ctx);
				} finally {
					postExecInFlight = false;
				}
			});
		});

		// ---- Refresh footer context usage after each LLM turn ----------------

		pi.on("turn_end", () => {
			footerTui?.requestRender();
		});

		// Pin sys token count from the first real API response. chars/4 is
		// inaccurate for JSON-heavy tool schemas (2–3 chars/token); the real
		// total minus the cost of the turn-1 messages gives a much tighter
		// estimate that stays constant for the session lifetime.
		pi.on("turn_end", (_event, ctx) => {
			if (pinnedSysTokens !== null) return;
			const usage = ctx.getContextUsage();
			if (!usage || usage.tokens === null) return;

			// Sum char lengths of all message-type entries on the branch
			// (user + assistant turn 1). Custom-message entries (seed) are
			// counted separately via computeSeedChars.
			let messageChars = 0;
			for (const e of ctx.sessionManager.getBranch()) {
				if (e.type !== "message") continue;
				const content = (e as { message?: { content?: unknown } }).message
					?.content;
				if (typeof content === "string") {
					messageChars += content.length;
				} else if (content != null) {
					try {
						messageChars += JSON.stringify(content).length;
					} catch {
						// Non-serialisable content — skip rather than crash.
					}
				}
			}

			const seedChars = computeSeedChars(ctx);
			// Also subtract the compaction summary so it isn't absorbed into
			// pinnedSysTokens and then double-counted via `sum` in the footer.
			const summaryCharsAtPin = computeSummaryChars(ctx);
			const nonSysTokens = Math.ceil(
				(seedChars + messageChars + summaryCharsAtPin) / 4,
			);
			pinnedSysTokens = Math.max(0, usage.tokens - nonSysTokens);
			footerTui?.requestRender();
		});

		// ---- Mid-phase compaction trigger -------------------------------------
		//
		// Gated stack: the cheapest checks first so most turn_end events
		// Mid-phase compaction trigger — fires from `turn_end` when the working
		// portion (sys + work, i.e. total − summary) exceeds `workingTokens`.
		//
		// The actual compaction is driven by `ctx.compact()` (which fires the
		// `session_before_compact` handler registered above). This `turn_end`
		// hook is only the trigger gate; it does not write to the session itself.
		//
		// Gates (cheapest first):
		//   1. modeState exists and is auto — only modes-driven execution
		//   2. plan + active phase exist
		//   3. (tokens − summary) > workingTokens (uses ctx.getContextUsage())
		//   4. !compactionInFlight — re-entrancy guard
		//
		// On every gate failure: silent return. We never want this hook to
		// log, only act.

		// Per-session flag so the soft "summary exceeded its budget" warn
		// fires at most once. Reset by session_start (handled below).

		pi.on("turn_end", async (_event, ctx) => {
			// Cheap checks first — most turn_end events short-circuit before
			// touching the plan tree or session manager.
			if (!modeState) return;
			if (compactionInFlight) return;

			const plan = currentPlan();
			const activePhase = plan?.phases.find((p) => p.status === "active");
			const usage = ctx.getContextUsage();

			// Estimate live summary token cost so the trigger can isolate the
			// working budget. Errors here surface as 0 — we'd rather under-
			// estimate summary (and over-trigger) than crash the hook.
			let summaryUsed = 0;
			try {
				summaryUsed = Math.ceil(computeSummaryChars(ctx) / 4);
			} catch {
				summaryUsed = 0;
			}

			let seedUsed = 0;
			try {
				seedUsed = Math.ceil(computeSeedChars(ctx) / 4);
			} catch {
				seedUsed = 0;
			}

			// Soft warn (once per session) when the cumulative cross-phase
			// carry-forward (Σ phase.summary across shipped phases of the
			// active plan) exceeds the budget. Not enforced — dropping older
			// summaries silently would lose the discovery signal that
			// motivates the carry-forward in the first place. Hint to lower
			// `compaction.phaseTokens` per phase, or accept a larger seed.
			const summaryBudget = readSummaryTokensSetting(ctx);
			if (!summaryBudgetWarnFired && plan) {
				const carry = Math.ceil(computeCarryForwardSummaryChars(plan) / 4);
				if (carry > summaryBudget) {
					summaryBudgetWarnFired = true;
					notify(
						ctx,
						`carry-forward summaries (${carry} tokens) exceed compaction.summaryTokens (${summaryBudget}); consider lowering compaction.phaseTokens or accepting a larger seed`,
						"warning",
					);
				}
			}

			const fire = shouldCompactMidPhase({
				// `compactionApiAvailable` is unconditionally true: ctx.compact
				// is part of pi's documented public API and our peer dep version
				// guarantees it. The flag is kept on `MidPhaseTriggerInput` for
				// back-compat with the existing tests but no longer gates real
				// behaviour.
				compactionApiAvailable: true,
				mode: modeState.mode,
				compactionInFlight,
				hasActivePhase: !!activePhase,
				tokens: usage?.tokens,
				workingTokens: readWorkingTokensSetting(ctx),
				summaryTokens: summaryUsed,
				seedTokens: seedUsed,
			});
			if (!fire || !plan || !activePhase) return;

			// An abandoned (timed-out/aborted) compaction may still be running in
			// pi; don't stack a second one until it should have settled.
			if (Date.now() < compactionCooldownUntil) return;

			compactionInFlight = true;
			try {
				await compactPhaseSlice(ctx, plan, activePhase.id);
			} finally {
				compactionInFlight = false;
			}
		});

		// ---- Track plan text snapshot ----------------------------------------

		pi.on("turn_end", async (event, ctx) => {
			if (!modeState || modeState.mode !== "plan") return;
			const msg = event.message as { role?: string; content?: unknown };
			if (msg.role !== "assistant") return;
			let text = "";
			if (typeof msg.content === "string") text = msg.content;
			else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (
						block &&
						typeof block === "object" &&
						(block as { type?: string }).type === "text" &&
						typeof (block as { text?: unknown }).text === "string"
					) {
						text += `${(block as { text: string }).text}\n`;
					}
				}
			}
			if (text.trim().length > 0) {
				modeState.planText = text.trim();
				modeState.stage = "planning";
				persist();
				// No widget update needed — already up to date.
			}
			updateWidget(ctx);
		});

		// ---- Mode transition prompt ------------------------------------------

		/**
		 * For hack → plan transitions, ask whether to keep / lossy-compact /
		 * start a new session. Pure decision-building lives in plan/transition.ts;
		 * this wrapper resolves the active phase, calls ctx.ui.select, and
		 * returns the structured decision.
		 */
		async function runModeTransition(
			prev: Mode,
			ctx: ExtensionContext,
			opts: { canStartNewSession: boolean },
		): Promise<TransitionDecision> {
			const plan = currentPlan();
			const activePhase = plan?.phases.find((p) => p.status === "active");
			const activePhaseId = activePhase?.id ?? null;
			const built = buildTransitionOptions({
				hasUI: ctx.hasUI,
				prev,
				next: "plan",
				activePhaseId,
				canStartNewSession: opts.canStartNewSession,
			});
			if (!built) return { action: "flip" };
			const choice = await ctx.ui.select(built.title, built.options);
			return decideFromChoice(choice, activePhaseId);
		}

		// ---- Shift+Tab shortcut -----------------------------------------------

		/**
		 * Shared implementation for the hack/ask/auto → plan transition triggered
		 * by Shift+Tab. Shows the context-handling picker (keep / compact / new
		 * session), then restores the plan session if one was recorded.
		 *
		 * Extracted so hack, ask, and auto paths all get the same treatment
		 * without code duplication.
		 */
		async function shiftTabToPlan(
			prev: Mode,
			ctx: ExtensionContext,
		): Promise<void> {
			const decision = await runModeTransition(prev, ctx, {
				canStartNewSession: false,
			});
			if (decision.action === "compact") {
				const plan = currentPlan();
				if (plan && !compactionInFlight) {
					compactionInFlight = true;
					try {
						await compactPhaseSlice(ctx, plan, decision.phaseId);
					} finally {
						compactionInFlight = false;
					}
				}
			}
			const plan = currentPlan();
			const targetPath = plan?.planSessionPath;
			const currentPath = ctx.sessionManager.getSessionFile();
			if (targetPath && targetPath !== currentPath) {
				if (hasSessionControl(ctx)) {
					runDetached(`${prev}→plan session restore`, ctx, async () => {
						await ctx.switchSession(targetPath, {
							withSession: async (newCtx) => {
								setMode("plan", newCtx);
								persist();
								updateWidget(newCtx);
								notify(newCtx, "plan mode (resumed planning session)", "info");
							},
						});
					});
				} else {
					setMode("plan", ctx);
					persist();
					updateWidget(ctx);
					notify(ctx, "plan mode", "info");
				}
				return;
			}
			setMode("plan", ctx);
			notify(ctx, "plan mode", "info");
		}

		pi.registerShortcut("shift+tab", {
			description:
				"Cycle permission mode: no-mode→hack, hack→plan, plan→ask, ask/auto→plan",
			handler: async (ctx) => {
				if (!modeState) {
					modeState = {
						mode: "hack",
						stage: "idle",
						branch: null,
						defaultBranch: null,
						priorTools: pi.getActiveTools(),
						planText: null,
						currentPlanSlug: null,
					};
					persist();
					applyModeTools();
					updateWidget(ctx);
					notify(ctx, "hack mode", "info");
					return;
				}

				// hack → plan. Prompt for handling carried-over context: keep /
				// lossy-compact active phase. Session restore uses `hasSessionControl`
				// guard — degrades to in-place mode flip when command-context methods
				// are unavailable.
				if (modeState.mode === "hack") {
					await shiftTabToPlan("hack", ctx);
					return;
				}

				// plan → ask. With an actionable plan, show the picker (Implement /
				// Park / Continue) so the user has to commit to /implement rather
				// than stumble into ask/auto with stale plan text. With nothing
				// actionable (everything shipped/abandoned, or no plan at all),
				// just flip — there's no decision to offer.
				if (modeState.mode === "plan") {
					const plan = currentPlan();
					if (shouldOfferShiftTabPicker(plan, ctx.hasUI)) {
						runDetached("picker", ctx, () => runPicker(ctx));
					} else {
						const hadPhases = (plan?.phases.length ?? 0) > 0;
						setMode("ask", ctx);
						notify(
							ctx,
							hadPhases
								? "ask mode — plan has no actionable phase"
								: "ask mode",
							"info",
						);
					}
					return;
				}

				// ask → plan. Same transition logic as hack→plan: offer the context
				// picker and restore the plan session if one was recorded.
				if (modeState.mode === "ask") {
					await shiftTabToPlan("ask", ctx);
					return;
				}

				// auto → plan. Same as above — going back to plan after executing.
				await shiftTabToPlan("auto", ctx);
			},
		});

		// ---- Plan view shortcut -----------------------------------------------

		/**
		 * Open the plan in a dedicated full-screen view (like the notes editor).
		 * Navigate with ↑/↓, →/⏎/Space expand the selected phase's checklist, ←
		 * collapses it, PgUp/PgDn scroll, Esc/q closes.
		 */
		pi.registerShortcut("ctrl+shift+p", {
			description: "Open the plan view",
			handler: async (ctx) => {
				await openPlanView(ctx);
			},
		});

		// ---- Sidebar toggle ---------------------------------------------------

		pi.registerShortcut("ctrl+shift+b", {
			description: "Toggle the overlay sidebar (Info/Plan/Notes)",
			handler: async (ctx) => {
				toggleSidebar(ctx);
			},
		});

		pi.registerShortcut("ctrl+shift+n", {
			description: "Edit the sidebar Notes box",
			handler: async (ctx) => {
				await editSidebarNotes(ctx);
			},
		});

		// ---- Commands ---------------------------------------------------------

		pi.registerCommand("sidebar", {
			description:
				"Show/hide the overlay sidebar (Info/Plan/Notes). Alias: ctrl+shift+b.",
			handler: async (_args, ctx) => {
				toggleSidebar(ctx);
			},
		});

		pi.registerCommand("notes", {
			description:
				"Edit the sidebar Notes box (per-session free text). Alias: ctrl+shift+n.",
			handler: async (_args, ctx) => {
				await editSidebarNotes(ctx);
			},
		});

		pi.registerCommand("plan", {
			description:
				"Sync to the default branch and enter plan mode. " +
				"Subcommands: /plan list, /plan resume <slug>, " +
				"/plan archive <slug> (soft — abandons non-terminal phases), " +
				"/plan delete <slug> (hard — removes from disk). " +
				"Optionally seed with a description.",
			handler: async (args, ctx) => {
				const sub = args?.trim().split(/\s+/) ?? [];
				if (sub[0] === "list") {
					await doPlanList(ctx);
					return;
				}
				if (sub[0] === "resume" && sub[1]) {
					await doPlanResume(sub[1], ctx);
					return;
				}
				if (sub[0] === "delete" && sub[1]) {
					await doPlanDelete(sub[1], ctx);
					return;
				}
				if (sub[0] === "archive" && sub[1]) {
					await doPlanArchive(sub[1], ctx);
					return;
				}

				if (!isGitRepo(ctx.cwd)) {
					// Outside a git repo — just enter plan mode without syncing.
					if (!modeState) {
						modeState = {
							mode: "auto",
							stage: "idle",
							branch: null,
							defaultBranch: null,
							priorTools: pi.getActiveTools(),
							planText: null,
							currentPlanSlug: null,
						};
					}
					modeState.stage = "planning";
					setMode("plan", ctx);
					persist();
					if (args?.trim()) {
						pi.sendMessage(
							{
								customType: EXT_ID,
								content: args.trim(),
								display: false,
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					}
					notify(ctx, "plan mode (not a git repo — skipping sync)", "info");
					return;
				}

				// If a plan for this repo already has a recorded planning session
				// and we're not currently in it, switchSession to land back in
				// the planning context (typical auto→plan transition). The
				// post-switch session has its own STATE_ENTRY which session_start
				// hydrates; we just flip mode + fire the optional followUp inside
				// withSession.
				const existingSlug = modeState?.currentPlanSlug ?? null;
				const existingPlan = existingSlug ? loadPlan(existingSlug) : null;
				const targetPath = existingPlan?.planSessionPath;
				const currentPath = ctx.sessionManager.getSessionFile();
				if (targetPath && targetPath !== currentPath) {
					const description = args?.trim();
					await ctx.switchSession(targetPath, {
						withSession: async (newCtx) => {
							setMode("plan", newCtx);
							persist();
							updateWidget(newCtx);
							notify(
								newCtx,
								`plan mode (resumed planning session for ${existingSlug})`,
								"info",
							);
							if (description) {
								pi.sendMessage(
									{
										customType: EXT_ID,
										content: description,
										display: false,
									},
									{ deliverAs: "followUp", triggerTurn: true },
								);
							}
						},
					});
					return;
				}

				const defaultBranch = await syncToDefault(ctx);
				if (!defaultBranch) return;

				if (modeState) {
					restorePriorTools();
				}
				const priorTools = modeState?.priorTools ?? pi.getActiveTools();

				const planSlug = ensurePlanForRepo(ctx);

				modeState = {
					mode: "plan",
					stage: "planning",
					branch: null,
					defaultBranch,
					priorTools,
					planText: null,
					currentPlanSlug: planSlug,
				};

				persist();
				applyModeTools();
				updateWidget(ctx);
				notify(ctx, `plan mode on ${defaultBranch}`, "info");

				// Record the active session as this plan's planning session if
				// one isn't recorded yet. The current session was either created
				// by the user via `pi` or carried over via `pi -c`/`/resume`;
				// either way it's the session this plan was authored in.
				//
				// Subsequent auto→plan transitions and `/plan resume <slug>`
				// will `switchSession` back to this path.
				recordPlanSessionPathIfMissing(ctx, planSlug);

				if (args?.trim()) {
					pi.sendMessage(
						{
							customType: EXT_ID,
							content: args.trim(),
							display: false,
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}
			},
		});

		pi.registerCommand("implement", {
			description:
				"Sync to the default branch, create a feature branch, and start executing. " +
				"Preserves current mode (ask/auto → keep; hack → auto; plan → implementDefault setting). " +
				"Optionally provide a description; otherwise uses the current plan. " +
				"Pass an exact phase id (or `--phase <id>`) to target a specific phase — " +
				"useful when running multiple drivers across independent chains. " +
				"Pass `--takeover` to override another session's claim on the active phase. " +
				"Pass `--fanout` from plan mode to spawn a fleet of worker subagents, one per " +
				"independent chain (Pattern X).",
			handler: async (args, ctx) => {
				// Preserve non-plan modes: ask/auto keep their current mode so that
				// /implement from ask stays in ask (no accidental auto-flip). Hack
				// runs as auto (ImplementMode doesn't include hack). Plan falls
				// back to the configured implementDefault setting.
				const { mode: settingMode, valid: settingValid } =
					readImplementDefaultSetting(ctx);
				if (!settingValid) {
					notify(
						ctx,
						'invalid implement.default setting (expected "auto" | "ask") — falling back to "auto"',
						"warning",
					);
				}
				const implementMode = resolveImplementModeForCurrentMode(
					modeState?.mode,
					settingMode,
				);
				const raw = args ?? "";
				if (/(?:^|\s)--fanout(?:\s|$)/.test(raw)) {
					if (isWorker()) {
						notify(
							ctx,
							"workers cannot fan out further — ignoring `--fanout`",
							"warning",
						);
						return;
					}
					await runFleetOrchestrator(ctx);
					return;
				}
				// Strip optional `--takeover` flag (anywhere in the args), then
				// resolve a phase target. Accepts:
				//   `/implement <phaseId>` — first token must exactly match a phase
				//      id in the active plan.
				//   `/implement --phase <phaseId>` — explicit form, never
				//      ambiguous with description text.
				// The leftover after stripping the flag and id is treated as the
				// free-form description (existing behaviour).
				const takeover = /(?:^|\s)--takeover(?:\s|$)/.test(raw);
				let stripped = raw.replace(/(?:^|\s)--takeover(?=\s|$)/g, " ").trim();
				let targetPhaseId: string | null = null;
				const phaseFlag = stripped.match(/(?:^|\s)--phase\s+(\S+)/);
				if (phaseFlag) {
					const captured = phaseFlag[1] ?? "";
					// Reject when --phase consumed another flag (e.g.
					// `/implement --phase --takeover`). Treat the whole input as
					// description in that case so the user gets a normal error
					// rather than a baffling "no such phase \`--takeover\`".
					if (captured.length > 0 && !captured.startsWith("--")) {
						targetPhaseId = captured;
						stripped = stripped.replace(/(?:^|\s)--phase\s+\S+/, " ").trim();
					}
				} else if (stripped.length > 0) {
					// Bare-id form: only adopt as a target if the first token
					// exactly matches a phase id in the current plan. Otherwise
					// keep treating the whole string as a description so legacy
					// `/implement <free text>` invocations still work.
					const firstToken = stripped.split(/\s+/)[0] ?? "";
					const plan = currentPlan();
					if (
						plan &&
						firstToken &&
						plan.phases.some((p) => p.id === firstToken)
					) {
						targetPhaseId = firstToken;
						stripped = stripped.slice(firstToken.length).trim();
					}
				}
				const description = stripped.length > 0 ? stripped : null;

				if (!isGitRepo(ctx.cwd)) {
					if (!modeState) {
						modeState = {
							mode: implementMode,
							stage: "idle",
							branch: null,
							defaultBranch: null,
							priorTools: pi.getActiveTools(),
							planText: null,
							currentPlanSlug: null,
						};
					}
					modeState.stage = "executing";
					setMode(implementMode, ctx);
					if (description) {
						pi.sendMessage(
							{ customType: EXT_ID, content: description, display: false },
							{ deliverAs: "followUp", triggerTurn: true },
						);
					}
					notify(
						ctx,
						`${implementMode} mode (not a git repo — skipping branch creation)`,
						"info",
					);
					return;
				}

				const defaultBranch = await syncToDefault(ctx);
				if (!defaultBranch) return;

				const priorTools = modeState?.priorTools ?? pi.getActiveTools();
				if (!modeState) {
					modeState = {
						mode: "auto",
						stage: "idle",
						branch: null,
						defaultBranch,
						priorTools,
						planText: null,
						currentPlanSlug: null,
					};
				} else {
					restorePriorTools();
					modeState.defaultBranch = defaultBranch;
				}

				await doImplement(
					ctx,
					description,
					implementMode,
					takeover,
					targetPhaseId,
				);
			},
		});

		pi.registerCommand("park", {
			description:
				"Create a GitHub tracking issue from the current plan and exit plan mode.",
			handler: async (_args, ctx) => {
				if (modeState?.mode === "hack") {
					notify(ctx, "/park is not available in hack mode", "warning");
					return;
				}
				return doPark(ctx);
			},
		});

		pi.registerCommand("scrutinize", {
			description:
				"Run a sub-agent over the current plan to surface gaps, risks, and " +
				"missing tasks before you implement. Review findings and optionally " +
				"apply them as a planning follow-up.",
			handler: async (_args, ctx) => {
				if (modeState?.mode !== "plan") {
					notify(ctx, "/scrutinize is only available in plan mode", "warning");
					return;
				}
				await runScrutiny(ctx);
			},
		});

		pi.registerCommand("ship", {
			description:
				"Commit, push, and open a PR for the active phase. Flips its status to in-review.",
			handler: async (args, ctx) => {
				if (modeState?.mode === "hack") {
					notify(
						ctx,
						"/ship is auto-mode only — Shift+Tab back to auto first",
						"warning",
					);
					return;
				}
				return doShip(args, ctx);
			},
		});

		pi.registerCommand("sync", {
			description: "Sync local plan state with GitHub PR/issue state.",
			handler: async (_args, ctx) => {
				if (modeState?.mode === "hack") {
					notify(ctx, "/sync is not available in hack mode", "warning");
					return;
				}
				return doSync(ctx);
			},
		});

		pi.registerCommand("worktree", {
			description: "Manage worktrees: list, prune.",
			handler: async (args, ctx) => {
				if (modeState?.mode === "hack") {
					notify(ctx, "/worktree is not available in hack mode", "warning");
					return;
				}
				return doWorktree(args, ctx);
			},
		});

		// ---- Direct mode-flip commands (/hack, /ask, /auto) ------------------
		// These are intentionally minimal: no picker, no plan-state mutation,
		// no branch creation. They just call setMode() so the user can flip
		// without reaching for Shift+Tab. Useful in scripts, skills, and from
		// the auto-mode prompt where Shift+Tab isn't accessible.

		for (const [cmd, mode, label] of [
			["hack", "hack", "hack mode — full tools, no plan ceremony"] as const,
			[
				"ask",
				"ask",
				"ask mode — full tools, pauses at git boundaries",
			] as const,
			[
				"auto",
				"auto",
				"auto mode — autonomous commit/ship/next-phase loop",
			] as const,
		] as const) {
			pi.registerCommand(cmd, {
				description: `Switch to ${label}.`,
				handler: async (_args, ctx) => {
					if (!modeState) {
						notify(ctx, "no active session — run /plan first", "warning");
						return;
					}
					if (modeState.mode === mode) {
						notify(ctx, `already in ${mode} mode`, "info");
						return;
					}
					setMode(mode, ctx);
					notify(ctx, `${mode} mode`, "info");
				},
			});
		}

		pi.registerCommand("modes-status", {
			description: "Show the current mode and plan progress.",
			handler: async (_args, ctx) => {
				if (!modeState) {
					notify(ctx, "no active session", "info");
					return;
				}
				const plan = currentPlan();
				const tasks = allTasks(plan);
				const summary =
					tasks.length > 0
						? `\n${tasks.map(({ phase, task }) => `  ${task.done ? "✓" : "○"} Phase \`${phase.id}\` · ${task.title}`).join("\n")}`
						: "";
				const planSummary = plan ? ` | plan: ${plan.slug}` : "";
				notify(
					ctx,
					`mode: ${modeState.mode} | stage: ${modeState.stage}${modeState.branch ? ` | branch: ${modeState.branch}` : ""}${planSummary}${summary}`,
					"info",
				);
			},
		});
	},
);
