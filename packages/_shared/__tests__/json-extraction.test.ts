import { candidateJsonPayloads } from "../json-extraction.js";

describe("candidateJsonPayloads", () => {
	it("returns bare JSON as first candidate", () => {
		const raw = '{"title":"a","body":"b"}';
		expect(candidateJsonPayloads(raw)[0]).toBe(raw);
	});

	it("extracts from a ```json fence", () => {
		const raw = 'Here:\n```json\n{"title":"a","body":"b"}\n```';
		const candidates = candidateJsonPayloads(raw);
		expect(candidates).toContain('{"title":"a","body":"b"}');
	});

	it("extracts from a plain ``` fence", () => {
		const raw = 'Sure:\n```\n{"x":1}\n```\nDone.';
		const candidates = candidateJsonPayloads(raw);
		expect(candidates).toContain('{"x":1}');
	});

	it("handles prose before the object only", () => {
		const raw = 'Here you go: {"title":"t","body":"b"}';
		// The "from first {" candidate covers this case.
		const parseable = candidateJsonPayloads(raw).find((c) => {
			try {
				JSON.parse(c);
				return true;
			} catch {
				return false;
			}
		});
		expect(parseable).toBeDefined();
	});

	it("handles prose after the object only", () => {
		const raw = '{"title":"t","body":"b"}\n\nLet me know if you need changes!';
		const parseable = candidateJsonPayloads(raw).find((c) => {
			try {
				JSON.parse(c);
				return true;
			} catch {
				return false;
			}
		});
		expect(parseable).toBeDefined();
	});

	it("handles prose before AND after the object", () => {
		const raw =
			'Here is the formatted issue:\n{"title":"a bug","body":"broken"}\n\nLet me know!';
		const parseable = candidateJsonPayloads(raw).find((c) => {
			try {
				JSON.parse(c);
				return true;
			} catch {
				return false;
			}
		});
		expect(parseable).toBeDefined();
	});

	it("does not confuse nested braces — picks outermost object", () => {
		const raw = 'Prefix\n{"title":"t","body":{"nested":true}}\nSuffix';
		const candidates = candidateJsonPayloads(raw);
		const parsed = candidates
			.map((c) => {
				try {
					return JSON.parse(c);
				} catch {
					return null;
				}
			})
			.find(Boolean);
		expect(parsed).not.toBeNull();
		expect(parsed.title).toBe("t");
	});

	it("deduplicates identical candidates", () => {
		// Bare JSON — no prose, no fence — only one candidate should exist.
		const raw = '{"x":1}';
		const candidates = candidateJsonPayloads(raw);
		const unique = new Set(candidates);
		expect(unique.size).toBe(candidates.length);
	});

	it("handles a bare array with prose before and after", () => {
		const raw = "Result:\n[1,2,3]\nDone.";
		const parseable = candidateJsonPayloads(raw).find((c) => {
			try {
				JSON.parse(c);
				return true;
			} catch {
				return false;
			}
		});
		expect(parseable).toBeDefined();
	});
});
