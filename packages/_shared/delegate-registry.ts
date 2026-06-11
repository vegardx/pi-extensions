/**
 * Cross-extension registry of delegate targets.
 *
 * The `subagent` extension owns the generic `delegate` tool; other
 * extensions (modes, review, …) contribute named targets by calling
 * {@link registerDelegateTarget} at factory time. Consumers that want
 * to know whether a capability exists (e.g. commit probing for the
 * reviewer) call {@link getDelegateTarget} instead of probing commands
 * or dynamically importing sibling packages.
 *
 * Stored on `globalThis` (same pattern as define-extension's dep
 * state) because each extension is bundled separately — module-level
 * state would give every bundle its own private map.
 *
 * Note on toggles: a target registers at module load even when the
 * provider's extension later fails its dependency check; presence in
 * the registry means "code is loaded", not "extension is enabled".
 * Providers gate runtime behaviour via `isAvailable`.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

export interface DelegateTargetExecuteArgs {
	/** The natural-language task/question for the target. */
	message: string;
	/** Target-specific structured parameters (validated by `paramsSchema`). */
	params?: unknown;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	/** Hard cap on the whole execution; targets derive stage budgets from it. */
	timeoutMs?: number;
}

export interface DelegateTargetResult {
	/** Distilled answer that crosses back into the caller's context. */
	text: string;
	/** Structured payload for TS-side consumers (never enters the LLM context). */
	details?: unknown;
}

export interface DelegateTarget {
	name: string;
	/** One-line capability description listed in delegate errors/docs. */
	description: string;
	/** Optional schema for `params`; documentation + host-side validation. */
	paramsSchema?: TSchema;
	/**
	 * Runtime availability gate (e.g. explorer only in plan mode).
	 * Missing means always available.
	 */
	isAvailable?(ctx: ExtensionContext): boolean;
	/**
	 * Run the delegated work. Expected to return failures as `text` +
	 * `details.error` rather than throwing; the host still guards.
	 */
	execute(args: DelegateTargetExecuteArgs): Promise<DelegateTargetResult>;
}

const REGISTRY_KEY = "__pi_ext_delegate_registry__";

function getRegistry(): Map<string, DelegateTarget> {
	const g = globalThis as Record<string, unknown>;
	if (!g[REGISTRY_KEY]) {
		g[REGISTRY_KEY] = new Map<string, DelegateTarget>();
	}
	return g[REGISTRY_KEY] as Map<string, DelegateTarget>;
}

/** Register (or replace — last wins) a named delegate target. */
export function registerDelegateTarget(target: DelegateTarget): void {
	getRegistry().set(target.name, target);
}

export function getDelegateTarget(name: string): DelegateTarget | undefined {
	return getRegistry().get(name);
}

/** All registered targets, registration order. */
export function listDelegateTargets(): DelegateTarget[] {
	return Array.from(getRegistry().values());
}

/** Targets whose `isAvailable` passes for `ctx` (missing = available). */
export function availableDelegateTargets(
	ctx: ExtensionContext,
): DelegateTarget[] {
	return listDelegateTargets().filter((t) => t.isAvailable?.(ctx) ?? true);
}

/** Test-only: reset the registry to empty. */
export function clearDelegateTargets(): void {
	getRegistry().clear();
}
