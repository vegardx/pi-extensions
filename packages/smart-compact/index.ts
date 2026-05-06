/**
 * pi-ext-smart-compact
 *
 * Replaces the default auto-compaction summary with a single, context-aware
 * LLM call that identifies what you are actively working on and writes a
 * summary optimised for continuing that work — rather than a generic
 * chronological recap.
 *
 * The prompt instructs the model to:
 *   1. Identify the current goal and active task from the full conversation.
 *   2. Write a structured summary that weights recent decisions, exact file
 *      paths / values, and concrete next steps over completed side-work.
 *
 * Falls back to default compaction on any error so the session is never
 * blocked.
 */

import { fileURLToPath } from "node:url";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	convertToLlm,
	type FileOperations,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";

const MAX_SUMMARY_TOKENS = 8192;

function buildFileSections(fileOps: FileOperations): string {
	const read = [...fileOps.read].sort();
	const modified = [...new Set([...fileOps.written, ...fileOps.edited])].sort();
	const readSection =
		read.length > 0 ? `\n<read-files>\n${read.join("\n")}\n</read-files>` : "";
	const modifiedSection =
		modified.length > 0
			? `\n<modified-files>\n${modified.join("\n")}\n</modified-files>`
			: "";
	return readSection + modifiedSection;
}

function buildPrompt(
	conversationText: string,
	fileOps: FileOperations,
	previousSummary?: string,
	customInstructions?: string,
): string {
	const previousContext = previousSummary
		? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>`
		: "";

	const customContext = customInstructions
		? `\n\n<custom-instructions>\n${customInstructions}\nWeight the summary emphasis according to these instructions.\n</custom-instructions>`
		: "";

	const read = [...fileOps.read].sort();
	const modified = [...new Set([...fileOps.written, ...fileOps.edited])].sort();
	const fileContext =
		read.length > 0 || modified.length > 0
			? `\n\n<file-operations-context>\n` +
				(read.length > 0 ? `Read:\n${read.join("\n")}\n` : "") +
				(modified.length > 0
					? `Modified/Created:\n${modified.join("\n")}\n`
					: "") +
				`</file-operations-context>`
			: "";

	return `You are summarizing a coding-agent session. The conversation history is being compacted to free up context window space.

Your job is NOT to write a neutral historical record. Your job is to write a summary that makes it as easy as possible to continue the work in progress right now.${previousContext}${customContext}${fileContext}

Instructions:
1. Read the full conversation and identify the CURRENT active task — what specific problem is being solved, what file or component is being worked on, what the immediate next step is.
2. Write a structured summary weighted toward continuing that work. Prioritise:
   - The current task, goal, and why this approach was chosen
   - Exact file paths, function names, variable names, error messages, and values that are still relevant
   - Decisions made and their rationale (so they are not re-litigated)
   - What was tried and did not work
   - Concrete next steps
3. De-emphasise or omit:
   - Completed work that is no longer relevant
   - Exploratory paths that were abandoned
   - Verbose reasoning chains that led to a simple conclusion

Use this format exactly:

## Current Focus
[1–2 sentences: what are we doing right now and why]

## Goal
[The user's overall objective for this session]

## Constraints & Preferences
- [Any requirements, style preferences, or hard constraints the user mentioned]

## Progress
### Done
- [x] [Completed tasks that still matter as context]

### In Progress
- [ ] [The current active task, as specifically as possible]

### Blocked
- [Any blockers or open questions, if present]

## Key Decisions
- **[Decision]**: [Rationale — keep only decisions that are still load-bearing]

## Next Steps
1. [Immediate next action]
2. [Following action]

## Critical Context
- [Exact values, file paths, error messages, API responses, or other data that MUST survive compaction to continue the work]

<conversation>
${conversationText}
</conversation>`;
}

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: "smart-compact",
		path: fileURLToPath(import.meta.url),
		doc: "Replaces default compaction with a work-focused summary that identifies what you are actively doing and optimises the summary for continuing that task.",
		configSchema: [
			{
				key: "model",
				type: "string",
				fallbackChain:
					"extensionConfig.smart-compact.model → backgroundModels.primary.normal → ctx.model",
				doc: "provider/id override for the summarization model (normal tier).",
			},
		],
		backgroundModelUse: {
			tier: "normal",
			set: "primary",
			explanation:
				"Used at every auto-compaction to summarise the conversation with a work-continuity focus.",
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal, customInstructions } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
			fileOps,
		} = preparation;

		const resolved = await resolveModel(ctx, {
			name: "smart-compact",
			tier: "normal",
			requireApiKey: true,
		});

		if (!resolved?.apiKey) {
			ctx.ui.notify(
				"smart-compact: no model/auth available, using default compaction",
				"warning",
			);
			return;
		}

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		if (allMessages.length === 0) {
			return; // nothing to summarise, let default handle it
		}

		ctx.ui.notify(
			`smart-compact: summarising ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${resolved.model.id}…`,
			"info",
		);

		const conversationText = serializeConversation(convertToLlm(allMessages));
		const prompt = buildPrompt(
			conversationText,
			fileOps,
			previousSummary,
			customInstructions,
		);

		try {
			const response = await complete(
				resolved.model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					maxTokens: MAX_SUMMARY_TOKENS,
					signal,
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (!summary) {
				if (!signal.aborted) {
					ctx.ui.notify(
						"smart-compact: empty summary returned, using default compaction",
						"warning",
					);
				}
				return;
			}

			// Append accurate file lists built from fileOps rather than relying
			// on the LLM to infer them from the conversation text.
			const fullSummary = summary + buildFileSections(fileOps);

			return {
				compaction: {
					summary: fullSummary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			if (!signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`smart-compact: failed (${message}), using default compaction`,
					"error",
				);
			}
			return; // fall back to default
		}
	});
}
