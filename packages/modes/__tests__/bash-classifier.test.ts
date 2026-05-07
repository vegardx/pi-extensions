import { parseClassifyResponse } from "../bash-classifier.js";

describe("parseClassifyResponse", () => {
	it("parses a clean allow response", () => {
		const r = parseClassifyResponse(
			'{"verdict":"allow","reason":"read-only git history","tool":null}',
		);
		expect(r.verdict).toBe("allow");
		expect(r.reason).toBe("read-only git history");
		expect(r.tool).toBeUndefined();
	});

	it("parses a redirect response with a tool", () => {
		const r = parseClassifyResponse(
			'{"verdict":"redirect","reason":"reads a file — use the read tool","tool":"read"}',
		);
		expect(r.verdict).toBe("redirect");
		expect(r.tool).toBe("read");
	});

	it("ignores tool on a non-redirect verdict", () => {
		const r = parseClassifyResponse(
			'{"verdict":"allow","reason":"safe","tool":"grep"}',
		);
		expect(r.verdict).toBe("allow");
		expect(r.tool).toBeUndefined();
	});

	it("parses a block response", () => {
		const r = parseClassifyResponse(
			'{"verdict":"block","reason":"installs packages","tool":null}',
		);
		expect(r.verdict).toBe("block");
		expect(r.reason).toBe("installs packages");
	});

	it("strips markdown code fences", () => {
		const r = parseClassifyResponse(
			'```json\n{"verdict":"allow","reason":"safe","tool":null}\n```',
		);
		expect(r.verdict).toBe("allow");
	});

	it("strips plain code fences", () => {
		const r = parseClassifyResponse(
			'```\n{"verdict":"block","reason":"writes a file","tool":null}\n```',
		);
		expect(r.verdict).toBe("block");
	});

	it("blocks on invalid verdict value", () => {
		const r = parseClassifyResponse(
			'{"verdict":"maybe","reason":"unclear","tool":null}',
		);
		expect(r.verdict).toBe("block");
	});

	it("blocks on unparseable JSON", () => {
		expect(parseClassifyResponse("not json at all").verdict).toBe("block");
		expect(parseClassifyResponse("").verdict).toBe("block");
		expect(parseClassifyResponse("{}").verdict).toBe("block");
	});

	it("ignores unknown tool values on redirect", () => {
		const r = parseClassifyResponse(
			'{"verdict":"redirect","reason":"use something","tool":"vim"}',
		);
		expect(r.verdict).toBe("redirect");
		expect(r.tool).toBeUndefined();
	});

	it("accepts all valid redirect tools", () => {
		for (const tool of ["read", "grep", "find", "ls"] as const) {
			const r = parseClassifyResponse(
				`{"verdict":"redirect","reason":"use it","tool":"${tool}"}`,
			);
			expect(r.tool).toBe(tool);
		}
	});
});
