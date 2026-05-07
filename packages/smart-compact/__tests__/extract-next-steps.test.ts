import { extractNextSteps } from "../index.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const FILE_SECTIONS = `
<read-files>
src/foo.ts
src/bar.ts
</read-files>
<modified-files>
src/foo.ts
</modified-files>`;

function buildSummary({
	nextStepsContent = "1. First step\n2. Second step",
	trailingSection = "## Critical Context\n- Some context",
	fileSections = "",
}: {
	nextStepsContent?: string;
	trailingSection?: string;
	fileSections?: string;
} = {}): string {
	return `## Current Focus
We are refactoring the auth module.

## Goal
Improve test coverage.

## Constraints & Preferences
- TypeScript strict mode

## Progress
### Done
- [x] Set up test harness

### In Progress
- [ ] Write unit tests for login flow

### Blocked
- None

## Key Decisions
- **Use vitest**: Already in the repo.

## Next Steps
${nextStepsContent}

${trailingSection}${fileSections}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("extractNextSteps", () => {
	it("returns the Next Steps text from a normal summary", () => {
		const result = extractNextSteps(buildSummary());
		expect(result).toBe("1. First step\n2. Second step");
	});

	it("returns the Next Steps text when it is the last markdown heading (no trailing ## section)", () => {
		const summary = buildSummary({ trailingSection: "" });
		const result = extractNextSteps(summary);
		expect(result).toBe("1. First step\n2. Second step");
	});

	it("stops before appended <read-files> XML when ## Critical Context is absent", () => {
		const summary = buildSummary({
			trailingSection: "",
			fileSections: FILE_SECTIONS,
		});
		const result = extractNextSteps(summary);
		expect(result).toBe("1. First step\n2. Second step");
		expect(result).not.toContain("<read-files>");
	});

	it("stops before appended file XML even when next steps is the very last section", () => {
		// Minimal summary: only the Next Steps heading followed immediately by XML
		const summary = `## Next Steps\n1. Do the thing\n${FILE_SECTIONS}`;
		const result = extractNextSteps(summary);
		expect(result).toBe("1. Do the thing");
		expect(result).not.toContain("<read-files>");
	});

	it("returns undefined when the section is absent", () => {
		const summary = `## Goal\nSome goal\n\n## Progress\nDone stuff.`;
		expect(extractNextSteps(summary)).toBeUndefined();
	});

	it("returns undefined when the Next Steps section is present but empty", () => {
		const summary = buildSummary({ nextStepsContent: "" });
		expect(extractNextSteps(summary)).toBeUndefined();
	});

	it("returns undefined when the Next Steps section contains only whitespace", () => {
		const summary = buildSummary({ nextStepsContent: "   \n  " });
		expect(extractNextSteps(summary)).toBeUndefined();
	});

	it("preserves multi-line step content including blank lines between items", () => {
		const steps = "1. First step\n\n2. Second step\n\n3. Third step";
		const result = extractNextSteps(buildSummary({ nextStepsContent: steps }));
		expect(result).toBe(steps);
	});
});
