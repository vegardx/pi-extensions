import { vi } from "vitest";
import {
	readCompactionNumber,
	readCompactionTimeoutMs,
	readDefaultModeSetting,
	readExploreSettings,
	readImplementDefaultSetting,
	readPhaseTokensSetting,
	readPlanMaxContextTokensSetting,
	readResearchTimeoutMs,
	readSummaryTokensSetting,
	readWorkingTokensSetting,
} from "../settings.js";

// Mock readRelevantSettings to control returned config.
vi.mock("@vegardx/pi-extensions-shared/extension-settings.js", () => ({
	readRelevantSettings: vi.fn(() => ({})),
}));

import { readRelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";

const mockSettings = readRelevantSettings as ReturnType<typeof vi.fn>;

function ctx(cwd = "/test"): { cwd: string; hasUI: boolean } {
	return { cwd, hasUI: true } as any;
}

describe("readCompactionNumber", () => {
	it("returns fallback when no config", () => {
		mockSettings.mockReturnValue({});
		expect(readCompactionNumber(ctx(), "workingTokens", 150000)).toBe(150000);
	});

	it("reads a valid number from compaction config", () => {
		mockSettings.mockReturnValue({
			extensionConfig: {
				modes: { compaction: { workingTokens: 200000 } },
			},
		});
		expect(readCompactionNumber(ctx(), "workingTokens", 150000)).toBe(200000);
	});

	it("rejects non-positive numbers", () => {
		mockSettings.mockReturnValue({
			extensionConfig: {
				modes: { compaction: { workingTokens: -5 } },
			},
		});
		expect(readCompactionNumber(ctx(), "workingTokens", 150000)).toBe(150000);
	});

	it("floors fractional numbers", () => {
		mockSettings.mockReturnValue({
			extensionConfig: {
				modes: { compaction: { workingTokens: 123456.78 } },
			},
		});
		expect(readCompactionNumber(ctx(), "workingTokens", 150000)).toBe(123456);
	});
});

describe("readDefaultModeSetting", () => {
	it("returns plan when unset", () => {
		mockSettings.mockReturnValue({});
		expect(readDefaultModeSetting(ctx())).toEqual({
			mode: "plan",
			valid: true,
		});
	});

	it("returns configured mode", () => {
		mockSettings.mockReturnValue({
			extensionConfig: { modes: { mode: { default: "auto" } } },
		});
		expect(readDefaultModeSetting(ctx())).toEqual({
			mode: "auto",
			valid: true,
		});
	});

	it("rejects invalid mode", () => {
		mockSettings.mockReturnValue({
			extensionConfig: { modes: { mode: { default: "invalid" } } },
		});
		expect(readDefaultModeSetting(ctx())).toEqual({
			mode: "plan",
			valid: false,
		});
	});
});

describe("readImplementDefaultSetting", () => {
	it("returns auto when unset", () => {
		mockSettings.mockReturnValue({});
		expect(readImplementDefaultSetting(ctx())).toEqual({
			mode: "auto",
			valid: true,
		});
	});

	it("returns configured mode", () => {
		mockSettings.mockReturnValue({
			extensionConfig: { modes: { implement: { default: "ask" } } },
		});
		expect(readImplementDefaultSetting(ctx())).toEqual({
			mode: "ask",
			valid: true,
		});
	});
});

describe("readPlanMaxContextTokensSetting", () => {
	it("returns null when unset", () => {
		mockSettings.mockReturnValue({});
		expect(readPlanMaxContextTokensSetting(ctx())).toBeNull();
	});

	it("returns value when set", () => {
		mockSettings.mockReturnValue({
			extensionConfig: {
				modes: { compaction: { planMaxContextTokens: 200000 } },
			},
		});
		expect(readPlanMaxContextTokensSetting(ctx())).toBe(200000);
	});
});

describe("readExploreSettings", () => {
	it("returns defaults when unset", () => {
		mockSettings.mockReturnValue({});
		const notify = vi.fn();
		const result = readExploreSettings(ctx(), notify);
		expect(result.parallelism).toBe(2);
		expect(result.queueDepthThreshold).toBe(4);
		expect(notify).not.toHaveBeenCalled();
	});

	it("warns on invalid values", () => {
		mockSettings.mockReturnValue({
			extensionConfig: {
				modes: { explore: { parallelism: "bad" } },
			},
		});
		const notify = vi.fn();
		const result = readExploreSettings(ctx(), notify);
		expect(result.parallelism).toBe(2); // fallback
		expect(notify).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining("not a valid positive number"),
			"warning",
		);
	});
});

describe("readResearchTimeoutMs", () => {
	it("returns default when unset", () => {
		mockSettings.mockReturnValue({});
		expect(readResearchTimeoutMs(ctx())).toBe(120000);
	});

	it("returns configured value", () => {
		mockSettings.mockReturnValue({
			extensionConfig: { modes: { research: { timeoutMs: 60000 } } },
		});
		expect(readResearchTimeoutMs(ctx())).toBe(60000);
	});
});
