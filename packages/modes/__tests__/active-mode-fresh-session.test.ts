/**
 * Source-level regression canary for #136 / Copilot review on PR #217.
 *
 * On a fresh `session_start` (no persisted STATE_ENTRY) the modes
 * extension creates a default `modeState` but explicitly does NOT call
 * `persist()` yet — it waits for the user to actively change mode.
 *
 * That's intentional. The bug Copilot spotted: `persist()` is also the
 * only path that calls `setActiveMode(...)`, so on a fresh session the
 * shared `activeMode` accessor stayed `null` and `/commit` fell back to
 * the strict-copy branch on every fresh auto-mode session.
 *
 * Fix: also call `setActiveMode(modeState.mode)` immediately after the
 * fresh-session `modeState = { ... }` block, in addition to whatever
 * `persist()` does later. Cheapest test that catches a regression on
 * this is a source-level canary — testing the actual session_start
 * handler would require standing up the full factory.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_PATH = join(__dirname, "..", "index.ts");

function readSource(): string {
	return readFileSync(SOURCE_PATH, "utf8");
}

function extractFreshSessionBlock(source: string): string {
	// The fresh-session `modeState = { ... }` initialization lives in the
	// `pi.on("session_start", ...)` handler. We grab the block from the
	// `mode: defaultMode` line through the next `applyModeTools();` call,
	// which is exactly the window the fix lives in.
	const start = source.indexOf("mode: defaultMode,");
	if (start < 0) throw new Error("fresh-session modeState not found");
	const end = source.indexOf("applyModeTools();", start);
	if (end < 0)
		throw new Error("applyModeTools() not found after fresh-session block");
	return source.slice(start, end);
}

describe("session_start fresh-session active-mode propagation", () => {
	it("calls setActiveMode after creating modeState on a fresh session", () => {
		const block = extractFreshSessionBlock(readSource());
		expect(block).toMatch(/setActiveMode\(modeState\.mode\)/);
	});
});
