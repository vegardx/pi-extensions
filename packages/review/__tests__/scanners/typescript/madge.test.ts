import {
	madgeSpec,
	parseMadgeOutput,
} from "../../../scanners/typescript/madge.js";

describe("parseMadgeOutput", () => {
	it("returns no findings for empty array", () => {
		expect(parseMadgeOutput("[]")).toEqual([]);
	});

	it("returns no findings when root is not an array", () => {
		expect(parseMadgeOutput("{}")).toEqual([]);
		expect(parseMadgeOutput("null")).toEqual([]);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseMadgeOutput("not json")).toThrow(/not valid JSON/);
	});

	it("renders a 2-cycle with closing repeat", () => {
		const raw = JSON.stringify([["a.ts", "b.ts"]]);
		const findings = parseMadgeOutput(raw);
		expect(findings).toHaveLength(1);
		const f = findings[0]!;
		expect(f.severity).toBe("IMPORTANT");
		expect(f.file).toBe("a.ts");
		expect(f.title).toBe("madge: circular dependency in a.ts (cycle of 2)");
		// madge does NOT include the closing repeat in its output —
		// we add it so the rendered description reads as a true cycle.
		expect(f.description).toBe("Cycle: a.ts → b.ts → a.ts");
	});

	it("renders a 3-cycle with closing repeat", () => {
		const raw = JSON.stringify([["a.ts", "b.ts", "c.ts"]]);
		const f = parseMadgeOutput(raw)[0]!;
		expect(f.title).toBe("madge: circular dependency in a.ts (cycle of 3)");
		expect(f.description).toBe("Cycle: a.ts → b.ts → c.ts → a.ts");
	});

	it("produces one finding per cycle", () => {
		const raw = JSON.stringify([
			["a.ts", "b.ts"],
			["x.ts", "y.ts", "z.ts"],
		]);
		const findings = parseMadgeOutput(raw);
		expect(findings).toHaveLength(2);
		expect(findings[0]!.file).toBe("a.ts");
		expect(findings[1]!.file).toBe("x.ts");
		expect(findings[1]!.title).toContain("cycle of 3");
	});

	it("skips inner arrays with fewer than 2 entries", () => {
		const raw = JSON.stringify([["alone.ts"], []]);
		expect(parseMadgeOutput(raw)).toEqual([]);
	});

	it("filters out non-string entries inside a cycle", () => {
		const raw = JSON.stringify([["a.ts", null, "b.ts", 42]]);
		const f = parseMadgeOutput(raw)[0]!;
		expect(f.description).toBe("Cycle: a.ts → b.ts → a.ts");
	});

	it("includes a suggestion to break the cycle", () => {
		const raw = JSON.stringify([["a.ts", "b.ts"]]);
		const f = parseMadgeOutput(raw)[0]!;
		expect(f.suggestedAction).toMatch(/break the cycle/i);
	});
});

describe("madgeSpec", () => {
	it("is registered for the code-simplifier lane", () => {
		expect(madgeSpec.lane).toBe("code-simplifier");
	});

	it("default-disabled (opt-in)", () => {
		expect(madgeSpec.defaultEnabled).toBe(false);
	});

	it("uses --circular --json", () => {
		const args = madgeSpec.buildArgs();
		expect(args).toContain("--circular");
		expect(args).toContain("--json");
	});
});
