/**
 * pi-ext-subagent — host of the generic `delegate` tool.
 *
 * This extension registers no targets of its own; providers (modes'
 * researcher/explorer, review's reviewer, …) contribute targets via
 * `registerDelegateTarget` in `@vegardx/pi-extensions-shared`. It is
 * default-ON (see DEFAULT_ON_EXTENSIONS in define-extension) so the
 * tool is present whenever any provider is.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { defineExtension } from "@vegardx/pi-extensions-shared/define-extension.js";
import {
	DEFAULT_DELEGATE_MAX_CHARS,
	DEFAULT_DELEGATE_MAX_CONCURRENT,
	EXT_ID,
} from "./config.js";
import { buildDelegateTool } from "./delegate-tool.js";
import { DelegateJobs } from "./jobs.js";
import { Semaphore } from "./semaphore.js";

export default defineExtension(
	{
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc:
			"Generic `delegate` tool: route questions/tasks to pluggable " +
			"specialist targets registered by other extensions (researcher, " +
			"explorer, reviewer, …).",
		configSchema: [
			{
				key: "delegate.maxAnswerChars",
				type: "number",
				default: DEFAULT_DELEGATE_MAX_CHARS,
				doc: "Safety backstop (characters) on a delegated answer before it crosses back into the caller's context. Subagents are still prompted to be concise and complete; this only catches runaways. Default 6000.",
			},
			{
				key: "delegate.maxConcurrent",
				type: "number",
				default: DEFAULT_DELEGATE_MAX_CONCURRENT,
				doc: "Cap on concurrent delegate executions (blocking and async combined). Backpressure for a burst of parallel calls. Must be >= 1; fractional or smaller values fall back to the default. Default 10.",
			},
		],
	},
	(pi: ExtensionAPI) => {
		const semaphore = new Semaphore();
		const jobs = new DelegateJobs({
			semaphore,
			surface: ({ jobId, to, ok, text }) => {
				pi.sendMessage(
					{
						customType: `${EXT_ID}-delegate-result`,
						content: `[delegate ${to} job ${jobId} ${ok ? "finished" : "failed"}]\n\n${text}`,
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
		});
		pi.registerTool(
			buildDelegateTool({ semaphore, submitJob: (req) => jobs.submit(req) }),
		);
	},
);
