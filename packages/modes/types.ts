/**
 * Core types and pure helpers for the modes extension.
 *
 * These are extracted from index.ts so other modules within the
 * package can import them without circular dependencies.
 */

// ---- Types ----------------------------------------------------------------

export type Mode = "plan" | "auto" | "ask" | "hack";

export const ALL_MODES: readonly Mode[] = [
	"plan",
	"auto",
	"ask",
	"hack",
] as const;

export type ImplementMode = "auto" | "ask";

export const IMPLEMENT_MODES: readonly ImplementMode[] = [
	"auto",
	"ask",
] as const;

export type Stage =
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
export interface ModeState {
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

// ---- Pure helpers ---------------------------------------------------------

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
	const planTools = ["deliverable", "task", "plan"];
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
