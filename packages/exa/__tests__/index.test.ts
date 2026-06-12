import { vi } from "vitest";

// Mock the exa-js module before importing
const mockSearch = vi.fn();
const mockSearchAndContents = vi.fn();
vi.mock("exa-js", () => ({
	Exa: vi.fn().mockImplementation(() => ({
		search: mockSearch,
		searchAndContents: mockSearchAndContents,
	})),
}));

// Mock defineExtension to capture the factory
let capturedFactory: ((pi: unknown) => void) | null = null;
vi.mock("@vegardx/pi-extensions-shared/define-extension.js", () => ({
	defineExtension: (_opts: unknown, factory: (pi: unknown) => void) => {
		capturedFactory = factory;
		return factory;
	},
}));

// Import after mocks are in place
await import("../index.js");

describe("exa extension", () => {
	let registeredTool: {
		name: string;
		description: string;
		parameters: unknown;
		execute: (
			id: string,
			params: Record<string, unknown>,
		) => Promise<{
			content: Array<{ type: string; text: string }>;
			details: Record<string, unknown>;
		}>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		const fakeApi = {
			registerTool: (tool: typeof registeredTool) => {
				registeredTool = tool;
			},
		};
		capturedFactory!(fakeApi);
	});

	afterEach(() => {
		delete process.env.EXA_API_KEY;
	});

	describe("tool registration", () => {
		it("registers a tool named websearch", () => {
			expect(registeredTool).toBeDefined();
			expect(registeredTool.name).toBe("websearch");
		});

		it("has a description mentioning Exa", () => {
			expect(registeredTool.description).toContain("Exa");
		});
	});

	describe("execute — missing API key", () => {
		it("returns an error when EXA_API_KEY is not set", async () => {
			delete process.env.EXA_API_KEY;
			const result = await registeredTool.execute("call-1", {
				query: "test",
			});
			expect(result.content[0]!.text).toContain("EXA_API_KEY");
			expect(result.details.error).toBe("missing-api-key");
			expect(result.details.resultCount).toBe(0);
		});
	});

	describe("execute — search without content", () => {
		beforeEach(() => {
			process.env.EXA_API_KEY = "test-key-123";
		});

		it("calls exa.search with correct params", async () => {
			mockSearch.mockResolvedValue({
				results: [
					{
						title: "Result 1",
						url: "https://example.com/1",
						publishedDate: "2024-01-15T00:00:00Z",
						author: "Author A",
					},
				],
			});

			const result = await registeredTool.execute("call-2", {
				query: "vitest testing",
				numResults: 3,
				type: "neural",
			});

			expect(mockSearch).toHaveBeenCalledWith("vitest testing", {
				numResults: 3,
				type: "neural",
				useAutoprompt: true,
			});
			expect(result.content[0]!.text).toContain("Result 1");
			expect(result.content[0]!.text).toContain("https://example.com/1");
			expect(result.content[0]!.text).toContain("2024-01-15");
			expect(result.content[0]!.text).toContain("Author A");
			expect(result.details.resultCount).toBe(1);
		});

		it("uses defaults when optional params omitted", async () => {
			mockSearch.mockResolvedValue({ results: [] });
			await registeredTool.execute("call-3", { query: "test" });
			expect(mockSearch).toHaveBeenCalledWith("test", {
				numResults: 6,
				type: "auto",
				useAutoprompt: true,
			});
		});
	});

	describe("execute — search with content", () => {
		beforeEach(() => {
			process.env.EXA_API_KEY = "test-key-123";
		});

		it("calls searchAndContents when includeContent is true", async () => {
			mockSearchAndContents.mockResolvedValue({
				results: [
					{
						title: "Docs Page",
						url: "https://docs.example.com",
						text: "This is the page content that was fetched.",
					},
				],
			});

			const result = await registeredTool.execute("call-4", {
				query: "api docs",
				includeContent: true,
			});

			expect(mockSearchAndContents).toHaveBeenCalledWith("api docs", {
				numResults: 6,
				type: "auto",
				useAutoprompt: true,
				text: { maxCharacters: 2000 },
			});
			expect(result.content[0]!.text).toContain(
				"page content that was fetched",
			);
		});
	});

	describe("execute — error handling", () => {
		beforeEach(() => {
			process.env.EXA_API_KEY = "test-key-123";
		});

		it("returns error message on network failure", async () => {
			mockSearch.mockRejectedValue(new Error("Network timeout"));
			const result = await registeredTool.execute("call-5", {
				query: "test",
			});
			expect(result.content[0]!.text).toContain("Network timeout");
			expect(result.details.error).toBe("Network timeout");
			expect(result.details.resultCount).toBe(0);
		});

		it("handles non-Error thrown values", async () => {
			mockSearch.mockRejectedValue("string error");
			const result = await registeredTool.execute("call-6", {
				query: "test",
			});
			expect(result.content[0]!.text).toContain("string error");
		});
	});

	describe("execute — result formatting", () => {
		beforeEach(() => {
			process.env.EXA_API_KEY = "test-key-123";
		});

		it("numbers results sequentially", async () => {
			mockSearch.mockResolvedValue({
				results: [
					{ title: "First", url: "https://a.com" },
					{ title: "Second", url: "https://b.com" },
					{ title: "Third", url: "https://c.com" },
				],
			});

			const result = await registeredTool.execute("call-7", {
				query: "test",
			});
			const text = result.content[0]!.text;
			expect(text).toContain("### 1. First");
			expect(text).toContain("### 2. Second");
			expect(text).toContain("### 3. Third");
		});

		it("shows (no title) for missing titles", async () => {
			mockSearch.mockResolvedValue({
				results: [{ url: "https://a.com" }],
			});

			const result = await registeredTool.execute("call-8", {
				query: "test",
			});
			expect(result.content[0]!.text).toContain("(no title)");
		});

		it("omits date/author when not present", async () => {
			mockSearch.mockResolvedValue({
				results: [{ title: "Only Title", url: "https://a.com" }],
			});

			const result = await registeredTool.execute("call-9", {
				query: "test",
			});
			const text = result.content[0]!.text;
			expect(text).not.toContain("Date:");
			expect(text).not.toContain("Author:");
		});
	});
});
