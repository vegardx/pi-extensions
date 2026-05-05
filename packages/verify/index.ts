import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { EXT_ID, runVerify } from "./core.js";

export type {
	PlanStep,
	RunVerifyOptions,
	RunVerifyResult,
	VerifierVerdict,
} from "./core.js";
// Re-exports for tests + downstream consumers (e.g. /develop) that don't
// want to touch the `./core` subpath import directly.
export {
	BASE_VERIFY_TIMEOUT_MS,
	buildVerifySubagentInput,
	extractPlanSteps,
	findAutoModeIteration,
	MAX_VERIFY_TIMEOUT_MS,
	PER_STEP_TIMEOUT_MS,
	parseVerdict,
	parseVerdictArray,
	runVerify,
	VERIFY_REQUEST_ENTRY,
	VERIFY_RESULT_ENTRY,
	verifyTimeoutMs,
} from "./core.js";

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Verify each step of a plan against the working tree using a single read-only subagent that returns one verdict per step.",
		configSchema: [
			{
				key: "model",
				type: "string",
				fallbackChain:
					"extensionConfig.verify.model → backgroundModels.primary.fast → ctx.model",
				doc: "provider/id override for the verifier model.",
			},
		],
		backgroundModelUse: {
			tier: "fast",
			set: "primary",
			explanation:
				"One read-only subagent walks the whole plan and returns a JSON array of verdicts. Bounded structured-output task; fast tier is plenty.",
		},
	});

	pi.registerCommand(EXT_ID, {
		description:
			"Verify each step of a plan against the working tree using a single read-only subagent.",
		handler: async (args, ctx) => {
			await runVerify({ ctx, pi, arg: args ?? "" });
		},
	});
}
