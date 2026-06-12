/**
 * Factory for the common notify pattern used across extensions.
 *
 * Every extension repeats the same 3-line `notify(ctx, msg, level)` helper
 * that guards on `ctx.hasUI` and prefixes with the extension name. This
 * factory eliminates that repetition.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type NotifyFn = (
	ctx: ExtensionContext,
	msg: string,
	level?: "info" | "warning" | "error",
) => void;

/**
 * Create a notify function prefixed with the extension name.
 *
 * ```ts
 * const notify = makeNotify("review");
 * notify(ctx, "started scan", "info");
 * // → ctx.ui.notify("review: started scan", "info")
 * ```
 */
export function makeNotify(prefix: string): NotifyFn {
	return (
		ctx: ExtensionContext,
		msg: string,
		level: "info" | "warning" | "error" = "info",
	): void => {
		if (ctx.hasUI) ctx.ui.notify(`${prefix}: ${msg}`, level);
	};
}
