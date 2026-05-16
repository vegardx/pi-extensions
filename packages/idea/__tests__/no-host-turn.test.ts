import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * /idea's whole reason to exist is "do not interrupt the active
 * session". The only API in pi that actually triggers a host turn
 * from an extension is `pi.sendMessage`. If anyone adds a call to
 * that API anywhere in the package, this test fails on purpose.
 */

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "__tests__") continue;
		const full = join(dir, name);
		const s = statSync(full);
		if (s.isDirectory()) yield* walk(full);
		else if (s.isFile() && full.endsWith(".ts")) yield full;
	}
}

describe("idea invariants", () => {
	it("does not call pi.sendMessage anywhere", () => {
		const offenders: string[] = [];
		for (const file of walk(PKG_ROOT)) {
			const content = readFileSync(file, "utf8");
			if (/\bsendMessage\s*\(/.test(content)) {
				offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});
});
