/**
 * Polish step for /derp.
 *
 * Thin wrapper around
 * `@vegardx/pi-extensions-shared/polish-runner.js` that bakes in
 * derp's system-prompt path, read-only tool set, and the
 * `DerpContext → task` rendering.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type SubagentRunner,
	polishReport as sharedPolish,
} from "@vegardx/pi-extensions-shared/polish-runner.js";
import type { DerpContext } from "./context.js";
import { buildPolishTask } from "./template.js";

export type {
	PolishOutcome,
	SubagentRunner,
} from "@vegardx/pi-extensions-shared/polish-runner.js";

const SYSTEM_PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"system-prompt.md",
);

const DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface PolishInput {
	ctx: DerpContext;
	provider: string;
	model: string;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export async function polishReport(
	input: PolishInput,
	runner?: SubagentRunner,
) {
	return sharedPolish(
		{
			tag: "derp",
			task: buildPolishTask(input.ctx),
			systemPromptPath: SYSTEM_PROMPT_PATH,
			tools: DEFAULT_TOOLS,
			provider: input.provider,
			model: input.model,
			cwd: input.cwd,
			timeoutMs: input.timeoutMs,
			signal: input.signal,
		},
		runner,
	);
}
