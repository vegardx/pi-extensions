import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type BackgroundSet,
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
 *   3. `settings.json → backgroundModels.<set>.<tier>` — the user's
 *      "what does fast/normal/heavy mean for me" configuration under
 *      the requested set (`primary` by default; `secondary` for
 *      cross-checking consumers like `verify`).
 *   4. `settings.json → backgroundModels.primary.<tier>` — fallback
 *      when the requested set is `secondary` and the tier isn't
 *      configured under it. Lets users who only configure `primary`
 *      still get sensible behavior from `secondary` consumers.
 *   5. `ctx.model` — the active session model. Always has auth by
 *      definition, even if using it for background work is expensive.
 *   6. Nothing usable → return `null`; the caller disables the
 *      feature for this session and `notify()`s once.
 *
 * No hard-coded provider/model IDs anywhere.
 *
 * Extensions declare the *tier* they want (`fast`, `normal`, `heavy`)
 * and the *set* (`primary`, `secondary`) at the call site — both are
 * stable labels, provider/model choice is the user's.
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
	 * Which background-model set to read from. Most extensions use
	 * `primary` (the default). Consumers like `verify` use `secondary`
	 * so users can configure two model families and cross-check one
	 * with the other; `secondary` falls back to `primary` for any tier
	 * not configured under it.
	 */
	set?: BackgroundSet;
	/**
	 * Optional extra override — e.g. a CLI-flag / in-session command
	 * value. Wins over everything in settings.json. Shape is the usual
	 * `"provider/id"` string.
	 */
	explicit?: string;
	/**
	 * If true, candidates whose auth is successful but without an
	 * `apiKey` are treated as unusable — the resolver continues down
	 * the chain instead of returning them.
	 *
	 * pi's `ResolvedRequestAuth` allows `{ ok: true, apiKey: undefined,
	 * headers: undefined }` (e.g. providers that authenticate purely
	 * via headers, or configs with missing credentials that still
	 * report ok). Callers that directly pass `apiKey` to a completion
	 * call cannot use such a result. Callers that hand the model spec
	 * off to something else that does its own auth (subagent RPC clients)
	 * don't need this.
	 *
	 * Default: false. Preserves the headers-only auth path for callers
	 * that don't care.
	 */
	requireApiKey?: boolean;
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
	const set: BackgroundSet = opts.set ?? "primary";

	const candidates: Array<string | undefined> = [
		opts.explicit,
		getExtensionModelOverride(settings, opts.name),
		getTierModel(settings, opts.tier, set),
	];

	for (const spec of candidates) {
		if (!spec) continue;
		const model = lookup(ctx, spec);
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) continue;
		if (opts.requireApiKey && !auth.apiKey) continue;
		return { model, apiKey: auth.apiKey, headers: auth.headers };
	}

	// Fall back to the active session model. We don't need to call
	// `getApiKeyAndHeaders` first because if `ctx.model` is set the user
	// already has working auth for it — but we do call it anyway so the
	// caller gets the same `{ apiKey, headers }` shape regardless of
	// source.
	if (ctx.model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok && (!opts.requireApiKey || auth.apiKey)) {
			return {
				model: ctx.model,
				apiKey: auth.apiKey,
				headers: auth.headers,
			};
		}
	}

	return null;
}

export async function resolveModelWithin(
	ctx: ExtensionContext,
	opts: ResolveOptions,
	timeoutMs: number,
): Promise<ResolvedBackgroundModel | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([resolveModel(ctx, opts), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
