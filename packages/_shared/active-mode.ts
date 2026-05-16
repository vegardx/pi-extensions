/**
 * Process-global accessor for the current pi-modes mode.
 *
 * The `modes` extension owns the mode state machine
 * (`auto` / `ask` / `hack` / `plan`). Other extensions
 * occasionally need to branch on the active mode — `/commit`
 * softens its "stop after the last commit" copy when the modes
 * auto pipeline is driving it, for example.
 *
 * The contract is intentionally minimal: `modes` calls
 * `setActiveMode(mode)` whenever it transitions, and any other
 * extension can call `getActiveMode()` to read the latest value.
 * Returns `null` when modes hasn't initialised yet (e.g. modes
 * is not installed, or the user is in a fresh session before the
 * factory ran).
 *
 * This is process-global mutable state by design — the alternative
 * (event listeners, dynamic-import probes) is much more fragile
 * across extension load order. Callers that want to thread the
 * mode through a single call should prefer that (e.g.
 * `runCommit({ mode })`); this accessor is for the slash-command
 * entry points that don't have a modes-side caller to thread from.
 */

let activeMode: string | null = null;

export function setActiveMode(mode: string | null | undefined): void {
	activeMode = mode ?? null;
}

export function getActiveMode(): string | null {
	return activeMode;
}
