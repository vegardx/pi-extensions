/**
 * Source-level regression canary for the plan→executing tool-flip in
 * `launchExecution` (#174).
 *
 * `applyExecutionMode` is unit-tested directly in `tool-filtering.test.ts`,
 * but those tests don't catch the case where someone removes the
 * `applyExecutionMode(...)` call from `launchExecution` entirely. Without
 * that call, plan-mode tool restrictions stay in place when execution
 * starts and write/edit silently disappear from the agent's tool set.
 *
 * `launchExecution` is a closure inside the modes factory and depends on
 * factory-scoped state (`modeState`, `pi`, `notify`, …). Refactoring it
 * far enough to inject all of those just for an integration test would
 * dwarf the bug it would catch. Instead, do the cheapest thing that
 * actually catches the regression: read the source and assert the call
 * is present inside the function body.
 *
 * If you legitimately rename the helper or restructure the function,
 * update the regex below alongside the source.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_PATH = join(__dirname, "..", "index.ts");

function readSource(): string {
	return readFileSync(SOURCE_PATH, "utf8");
}

function extractFunctionBody(source: string, signature: RegExp): string {
	const match = signature.exec(source);
	if (!match) throw new Error(`signature not found: ${signature}`);
	let depth = 0;
	let started = false;
	let i = match.index + match[0].length;
	const start = i;
	for (; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") {
			depth++;
			started = true;
			continue;
		}
		if (ch === "}") {
			depth--;
			if (started && depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`unterminated function body for ${signature}`);
}

/**
 * Find a balanced-parentheses call to `name` in `source` and return
 * its argument list (without the outer parens). Returns `null` when
 * the call is not found.
 */
function extractCallArgs(source: string, name: string): string | null {
	const pattern = new RegExp(`\\b${name}\\s*\\(`);
	const match = pattern.exec(source);
	if (!match) return null;
	let i = match.index + match[0].length;
	let depth = 1;
	const start = i;
	for (; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return source.slice(start, i);
		}
	}
	return null;
}

describe("launchExecution source-level guardrail", () => {
	it("calls applyExecutionMode somewhere in its body", () => {
		const body = extractFunctionBody(
			readSource(),
			/async function launchExecution\b[^{]*/,
		);
		expect(body).toMatch(/\bapplyExecutionMode\s*\(/);
	});

	it("passes setActiveTools as the third argument", () => {
		const body = extractFunctionBody(
			readSource(),
			/async function launchExecution\b[^{]*/,
		);
		const args = extractCallArgs(body, "applyExecutionMode");
		expect(args).not.toBeNull();
		expect(args).toMatch(/setActiveTools/);
	});

	it("threads implementMode (not a hardcoded mode) into the helper", () => {
		const body = extractFunctionBody(
			readSource(),
			/async function launchExecution\b[^{]*/,
		);
		// Guards against the regression "applyExecutionMode(state, 'auto', …)"
		// — the implementMode argument must be parameterised.
		const args = extractCallArgs(body, "applyExecutionMode") ?? "";
		expect(args).toContain("implementMode");
	});
});
