import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	getExtensionModelOverride,
	getTierModel,
	readRelevantSettings,
	type Tier,
} from "./extension-settings.js";

/**
 * Shared background-model resolver used by every extension in this
 * monorepo that needs to call an LLM on a side task (auto-title,
 * ghost-text prediction, subagent review).
 *
 * ## Resolution order (high → low)
 *
 *   1. `opts.explicit` — caller-provided override (CLI flag,
 *      in-session command, legacy env var, …). Optional.
 *   2. `settings.json → extensionConfig.<name>.model` — full
 *      `"provider/id"` override, the total escape hatch.
 *   3. `settings.json → backgroundModels.<tier>` — the user's
 *      "what does fast/normal/heavy mean for me" configuration.
 *   4. `ctx.model` — the active session model. Always has auth by
 *      definition, even if using it for background work is expensive.
 *   5. Nothing usable → return `null`; the caller disables the
 *      feature for this session and `notify()`s once.
 *
 * No hard-coded provider/model IDs anywhere.
 *
 * Extensions declare the *tier* they want (`fast`, `normal`, `heavy`)
 * at the call site — tier is a stable label, provider/model choice is
 * the user's.
 */

export interface ResolvedBackgroundModel {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface ResolveOptions {
	/** The extension's short name, used as the key under `extensionConfig`. */
	name: string;
	/** Which tier this call wants if no per-extension override is set. */
	tier: Tier;
	/**
	 * Optional extra override — e.g. a CLI-flag / in-session command
	 * value. Wins over everything in settings.json. Shape is the usual
	 * `"provider/id"` string.
	 */
	explicit?: string;
}

/**
 * Parse a `"provider/id"` spec. Returns `null` for anything that
 * doesn't split cleanly into two non-empty sides.
 */
export function parseModelSpec(
	spec: string,
): { provider: string; modelId: string } | null {
	const idx = spec.indexOf("/");
	if (idx <= 0 || idx === spec.length - 1) return null;
	return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}

/** Look up a model from a `"provider/id"` spec via the registry. */
function lookup(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
	const parsed = parseModelSpec(spec);
	if (!parsed) return undefined;
	return ctx.modelRegistry.find(parsed.provider, parsed.modelId);
}

/**
 * Walk the resolution order and return the first usable model with
 * auth, or `null` if nothing resolves.
 */
export async function resolveModel(
	ctx: ExtensionContext,
	opts: ResolveOptions,
): Promise<ResolvedBackgroundModel | null> {
	const settings = readRelevantSettings(ctx.cwd);

	const candidates: Array<string | undefined> = [
		opts.explicit,
		getExtensionModelOverride(settings, opts.name),
		getTierModel(settings, opts.tier),
	];

	for (const spec of candidates) {
		if (!spec) continue;
		const model = lookup(ctx, spec);
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) continue;
		return { model, apiKey: auth.apiKey, headers: auth.headers };
	}

	// Fall back to the active session model. We don't need to call
	// `getApiKeyAndHeaders` first because if `ctx.model` is set the user
	// already has working auth for it — but we do call it anyway so the
	// caller gets the same `{ apiKey, headers }` shape regardless of
	// source.
	if (ctx.model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok) {
			return {
				model: ctx.model,
				apiKey: auth.apiKey,
				headers: auth.headers,
			};
		}
	}

	return null;
}
