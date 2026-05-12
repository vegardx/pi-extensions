/**
 * notify() — sub-agent → orchestrator push channel.
 *
 * This extension is loaded into the codebase-exploration sub-agent
 * process via `--extension`. The tool's handler is intentionally a
 * no-op: the parent observes every `notify(...)` call as a
 * `tool_execution_start` event on the RPC stream and lifts the args
 * into the `ExploreMailbox` notifications buffer. Returning a real
 * result here is just so the sub-agent's tool-call loop terminates
 * cleanly.
 *
 * Keep the schema and parameter names stable — the parent decodes
 * args by name (`text`, `kind`).
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const notifyTool = defineTool({
	name: "notify",
	label: "Notify Orchestrator",
	description:
		"Push a short message back to the orchestrator mid-turn. Use this when " +
		"you uncover something the orchestrator should know before you've " +
		"finished the current question (e.g. an unrelated bug, a missing " +
		"abstraction, a follow-up worth queuing). Keep it terse — one or two " +
		"sentences. The orchestrator sees notifications on its next mailbox " +
		"check, independent of the answer you're building.",
	parameters: Type.Object({
		text: Type.String({
			description: "The message to surface to the orchestrator.",
		}),
		kind: Type.Optional(
			Type.String({
				description:
					"Optional category tag (e.g. 'finding', 'warning', 'suggestion').",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		// Short ack only — the parent already lifts the full text from
		// `tool_execution_start` args. Echoing it here would just bloat the
		// sub-agent's own context with each notify.
		return {
			content: [
				{
					type: "text",
					text: "notified",
				},
			],
			details: { text: params.text, kind: params.kind },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(notifyTool);
}
