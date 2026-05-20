#!/usr/bin/env node
/**
 * Forbid value imports between sibling `pi-ext-*` packages.
 *
 * Cross-extension code is loaded dynamically with a `pi.getCommands()`
 * probe — see docs/extension-toggles.md. A static value import bypasses
 * the toggle and runs the sibling's module-level code regardless of
 * whether the user enabled it. Type-only imports (`import type ... from
 * "pi-ext-..."`) are allowed because they vanish at runtime.
 *
 * Run as part of `npm run check`. Exits non-zero on the first violation
 * with a file:line pointer; clean exits silently.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");

/**
 * @typedef {{ file: string, line: number, importPath: string, owner: string }} Violation
 */

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			walk(full, out);
		} else if (
			entry.endsWith(".ts") &&
			!entry.endsWith(".d.ts") &&
			!entry.endsWith(".test.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

function findOwningPackage(file) {
	// packages/<name>/...  → returns "<name>"
	const rel = file.slice(PACKAGES_DIR.length + 1);
	const slash = rel.indexOf("/");
	return slash > 0 ? rel.slice(0, slash) : null;
}

// `import` / `export` statements where the specifier matches `pi-ext-*`
// AND the modifier is NOT `type`. The optional `type` keyword is the
// thing we explicitly allow.
const STATIC_VALUE_IMPORT =
	/^\s*(?:import|export)\s+(?!type\b)[^"';]*from\s+["'](pi-ext-[^"']+)["']/gm;

function scan() {
	/** @type {Violation[]} */
	const violations = [];
	for (const file of walk(PACKAGES_DIR)) {
		const owner = findOwningPackage(file);
		if (!owner) continue;
		const src = readFileSync(file, "utf8");
		STATIC_VALUE_IMPORT.lastIndex = 0;
		let match;
		// biome-ignore lint/suspicious/noAssignInExpressions: regex iteration
		while ((match = STATIC_VALUE_IMPORT.exec(src)) !== null) {
			const importPath = match[1];
			// Same package importing itself by package name is rare but harmless.
			const sibling = importPath.replace(/^pi-ext-/, "").split("/")[0];
			if (sibling === owner) continue;
			const line = src.slice(0, match.index).split("\n").length;
			violations.push({ file, line, importPath, owner });
		}
	}
	return violations;
}

const violations = scan();
if (violations.length === 0) {
	process.exit(0);
}

console.error(
	`✗ ${violations.length} cross-extension static value import(s) detected.`,
);
console.error(
	"  Cross-extension calls must be dynamic + probed; static imports run the",
);
console.error(
	"  sibling's code regardless of its enabled state. Use `import type` for",
);
console.error("  type-only references, or `await import(...)` after probing.\n");
for (const v of violations) {
	const rel = v.file.slice(ROOT.length + 1);
	console.error(`  ${rel}:${v.line}  →  ${v.importPath}  (in pi-ext-${v.owner})`);
}
process.exit(1);
