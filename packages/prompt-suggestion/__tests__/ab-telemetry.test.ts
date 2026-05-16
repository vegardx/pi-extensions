import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AbSample, appendAbSample } from "../ab-telemetry.js";

function tmp(): string {
	return join(mkdtempSync(join(tmpdir(), "ab-telemetry-")), "log.jsonl");
}

describe("appendAbSample", () => {
	it("writes a single JSONL record and returns true", () => {
		const path = tmp();
		const sample: AbSample = {
			at: 1234,
			source: "inline",
			suggestion: "open the PR",
			latencyMs: 0,
			notes: "main-agent sentinel",
		};
		expect(appendAbSample(path, sample)).toBe(true);
		const raw = readFileSync(path, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(JSON.parse(raw.trimEnd())).toEqual(sample);
	});

	it("appends multiple records on subsequent calls", () => {
		const path = tmp();
		appendAbSample(path, {
			at: 1,
			source: "inline",
			suggestion: "a",
			latencyMs: 0,
		});
		appendAbSample(path, {
			at: 2,
			source: "predictor",
			suggestion: "b",
			latencyMs: 50,
			model: "openai/gpt-4o-mini",
		});
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!).source).toBe("inline");
		expect(JSON.parse(lines[1]!).source).toBe("predictor");
	});

	it("creates parent directories on first append", () => {
		const dir = mkdtempSync(join(tmpdir(), "ab-telemetry-"));
		const path = join(dir, "deeply", "nested", "log.jsonl");
		expect(
			appendAbSample(path, {
				at: 1,
				source: "inline",
				suggestion: "x",
				latencyMs: 0,
			}),
		).toBe(true);
		expect(readFileSync(path, "utf8")).toContain('"source":"inline"');
	});

	it("returns false on unwritable path (and never throws)", () => {
		// Path with a NUL byte is rejected by Node's fs.
		const ok = appendAbSample("/dev/null/\u0000bad", {
			at: 1,
			source: "inline",
			suggestion: null,
			latencyMs: 0,
		});
		expect(ok).toBe(false);
	});

	it("encodes a null suggestion (negative case for A/B)", () => {
		const path = tmp();
		appendAbSample(path, {
			at: 1,
			source: "predictor",
			suggestion: null,
			latencyMs: 200,
			notes: "no-actionable-suggestion",
		});
		const parsed = JSON.parse(readFileSync(path, "utf8").trimEnd());
		expect(parsed.suggestion).toBeNull();
		expect(parsed.notes).toBe("no-actionable-suggestion");
	});
});
