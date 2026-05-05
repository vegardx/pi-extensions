import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { DEFAULT_MAX_PARALLEL, EXT_ID, runVerify } from "./core.js";

export type {
	PlanStep,
	RunVerifyOptions,
	RunVerifyResult,
	VerifierVerdict,
} from "./core.js";
// Re-exports for tests + downstream consumers (e.g. /develop) that don't
// want to touch the `./core` subpath import directly.
export {
	extractPlanSteps,
	findAutoModeIteration,
	parseVerdict,
	runVerify,
	VERIFY_REQUEST_ENTRY,
	VERIFY_RESULT_ENTRY,
} from "./core.js";

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Verify each step of a plan against the working tree using parallel read-only subagents.",
		configSchema: [
			{
				key: "model",
				type: "string",
				fallbackChain:
					"extensionConfig.verify.model → backgroundModels.primary.fast → ctx.model",
				doc: "provider/id override for the verifier model.",
			},
			{
				key: "maxParallel",
				type: "number",
				default: DEFAULT_MAX_PARALLEL,
				doc: "Max concurrent verifier subagents per /verify run.",
			},
		],
		backgroundModelUse: {
			tier: "fast",
			set: "primary",
			explanation:
				"Each plan step spawns one read-only subagent against this model. Bounded structured-output task; fast tier is plenty.",
		},
	});

	pi.registerCommand(EXT_ID, {
		description:
			"Verify each step of a plan against the working tree using parallel read-only subagents.",
		handler: async (args, ctx) => {
			await runVerify({ ctx, pi, arg: args ?? "" });
		},
	});
}
