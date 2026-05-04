import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("pi-ext-example loaded", "info");
	});

	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (args, ctx) => {
			const name = args?.trim() || "world";
			ctx.ui.notify(`Hello, ${name}!`, "info");
		},
	});

	pi.registerTool({
		name: "greet",
		label: "Greet",
		description: "Greet someone by name",
		parameters: Type.Object({
			name: Type.String({ description: "Name to greet" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return {
				content: [{ type: "text", text: `Hello, ${params.name}!` }],
				details: {},
			};
		},
	});
}
