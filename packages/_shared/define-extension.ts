/**
 * `defineExtension(opts, factory)` — wraps an extension's factory in
 * the toggle/dep machinery used across this monorepo.
 *
 * ## What it does
 *
 *   1. Resolves whether the extension is enabled this session, with
 *      precedence:
 *
 *          env  >  project settings  >  global settings  >  default
 *
 *      The default is **`false` for every extension except `startup`**
 *      (the meta-extension that owns the `/extensions` picker; see
 *      `DEFAULT_ON_EXTENSIONS` below). Extensions are enabled via
 *      `extensionConfig.<name>.enabled = true` in either the project's
 *      `.pi/settings.json` or the user's global
 *      `~/.pi/agent/settings.json`, or via the env var
 *      `PI_EXT_<NAME>=on|off|true|false` (uppercase, dashes →
 *      underscores).
 *
 *   2. Always calls `declareExtension({...opts, enabled, loadState})`
 *      so `/extensions` can list every installed package even when
 *      it's gated off.
 *
 *   3. For enabled extensions: invokes the factory with either the
 *      real `pi` (when there are no hard `dependsOn`) or a deferred
 *      proxy (when there are). The proxy queues `register*` and `on`
 *      calls; the queue is flushed on `session_start` only after the
 *      cross-extension dep check passes.
 *
 *   4. Registers a once-per-session dep check on `session_start`
 *      (idempotent, anchored on `globalThis`). The check emits info
 *      notifies for missing `integratesWith` and error notifies for
 *      missing `dependsOn`, and flips the load state of any extension
 *      whose hard deps failed.
 *
 * ## Why default-off
 *
 * "New features = new extensions, often broken on `main`." Default-off
 * keeps experimental extensions silent until explicitly opted into,
 * makes every loaded extension a deliberate choice, and gives the
 * user an obvious bisect handle (`PI_EXT_<NAME>=off pi …`) without
 * touching settings.
 *
 * ## Why two dep fields
 *
 *   - `dependsOn` is **strict**. If the dep is missing or disabled,
 *     this extension refuses to load. Reserved for genuine hard
 *     requirements; nothing in this repo currently declares any.
 *   - `integratesWith` is **soft**. If the dep is missing or disabled,
 *     this extension still loads and the integration site (which is
 *     always behind a `pi.getCommands()` probe + dynamic import in
 *     this repo) silently does nothing. An info notify on
 *     session_start tells the user the integration is unavailable.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import type {
	BackgroundModelUseSpec,
	ConfigKeySchema,
} from "./extension-metadata.js";
import {
	declareExtension,
	type ExtensionEnabledSource,
	type ExtensionLoadState,
	getDeclaredExtensions,
	updateExtensionLoadState,
} from "./extension-metadata.js";
import { readRelevantSettingsLayered } from "./extension-settings.js";

export interface DefineExtensionOptions {
	name: string;
	path: string;
	doc?: string;
	configSchema?: readonly ConfigKeySchema[];
	/**
	 * Hard dependencies. If any listed extension is missing or
	 * disabled, this extension refuses to load and nothing it tried to
	 * register takes effect.
	 */
	dependsOn?: readonly string[];
	/**
	 * Soft integrations. Listed extensions are leveraged when present
	 * but optional. Missing ones produce an info notify; this
	 * extension still loads.
	 */
	integratesWith?: readonly string[];
	backgroundModelUse?: BackgroundModelUseSpec;
}

type AnyArgs = unknown[];

interface DeferredCall {
	method: string;
	args: AnyArgs;
}

interface PendingExtension {
	name: string;
	pi: ExtensionAPI;
	queue: DeferredCall[];
	dependsOn: readonly string[];
	flushed: boolean;
}

interface DepCheckState {
	pending: Map<string, PendingExtension>;
	sessionHandlerInstalled: boolean;
}

const DEP_STATE_KEY = "__pi_ext_define_extension_state__";

function getDepState(): DepCheckState {
	const g = globalThis as Record<string, unknown>;
	if (!g[DEP_STATE_KEY]) {
		g[DEP_STATE_KEY] = {
			pending: new Map<string, PendingExtension>(),
			sessionHandlerInstalled: false,
		} satisfies DepCheckState;
	}
	return g[DEP_STATE_KEY] as DepCheckState;
}

/**
 * Test-only: drop the deferred-registration pending map and clear the
 * once-per-session installation flag. Lets vitest cases start from a
 * clean slate without bleed-through across files.
 */
export function clearDefineExtensionState(): void {
	const state = getDepState();
	state.pending.clear();
	state.sessionHandlerInstalled = false;
}

/**
 * Test seam — overrides the cwd used to read project settings during
 * resolution. When unset (the production case) `process.cwd()` is
 * used. Tests set this to a fixture directory so the resolver reads
 * deterministic JSON.
 */
let cwdOverride: string | undefined;
let agentDirOverride: string | undefined;

export function __setDefineExtensionCwd(
	cwd: string | undefined,
	agentDir?: string,
): void {
	cwdOverride = cwd;
	agentDirOverride = agentDir;
}

/** Test seam — overrides `process.env` lookup for env-var resolution. */
let envOverride: NodeJS.ProcessEnv | undefined;

export function __setDefineExtensionEnv(
	env: NodeJS.ProcessEnv | undefined,
): void {
	envOverride = env;
}

function envVarName(extName: string): string {
	return `PI_EXT_${extName.replace(/-/g, "_").toUpperCase()}`;
}

function parseEnvFlag(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	const v = raw.trim().toLowerCase();
	if (v === "1" || v === "on" || v === "true" || v === "yes") return true;
	if (v === "0" || v === "off" || v === "false" || v === "no") return false;
	return undefined;
}

interface EnabledResolution {
	enabled: boolean;
	source: ExtensionEnabledSource;
	loadState: ExtensionLoadState;
}

// `startup` is the meta-extension that owns the `/extensions` picker
// and the session-start summary toast. If it were off by default like
// every other extension, a fresh install would have no way to discover
// or re-enable anything without hand-editing settings.json. So `startup`
// alone defaults to enabled — settings still win (you can still set
// `extensionConfig.startup.enabled = false` to silence it), and the env
// override still works for bisecting (`PI_EXT_STARTUP=false`).
const DEFAULT_ON_EXTENSIONS = new Set(["startup"]);

function resolveEnabled(name: string): EnabledResolution {
	const env = envOverride ?? process.env;
	const fromEnv = parseEnvFlag(env[envVarName(name)]);
	if (fromEnv !== undefined) {
		return {
			enabled: fromEnv,
			source: "env",
			loadState: fromEnv ? "loaded" : "disabled-by-env",
		};
	}

	const cwd = cwdOverride ?? process.cwd();
	const layered = readRelevantSettingsLayered(cwd, agentDirOverride);
	const projVal = layered.project.extensionConfig?.[name]?.enabled;
	if (typeof projVal === "boolean") {
		return {
			enabled: projVal,
			source: "project",
			loadState: projVal ? "loaded" : "disabled-by-config",
		};
	}
	const globVal = layered.global.extensionConfig?.[name]?.enabled;
	if (typeof globVal === "boolean") {
		return {
			enabled: globVal,
			source: "global",
			loadState: globVal ? "loaded" : "disabled-by-config",
		};
	}
	const defaultEnabled = DEFAULT_ON_EXTENSIONS.has(name);
	return {
		enabled: defaultEnabled,
		source: "default",
		loadState: defaultEnabled ? "loaded" : "disabled-by-config",
	};
}

// Methods deferred until after the post-load dep check passes for
// extensions with `dependsOn`. Note that `on` is intentionally NOT
// deferred — if we queued listener registration, any
// `on("session_start", ...)` handler in the factory body would only
// be installed *after* the session_start event has already fired,
// and the extension would silently miss its own per-session init.
// Listener registration is harmless even if deps later fail: any
// `pi.register*` calls the listener makes still go through the
// proxy below and stay queued, so no real registration leaks.
const DEFERRED_METHODS = new Set([
	"registerCommand",
	"registerTool",
	"registerShortcut",
	"registerFlag",
	"registerMessageRenderer",
	"registerProvider",
]);

function makeDeferredAPI(
	real: ExtensionAPI,
	queue: DeferredCall[],
): ExtensionAPI {
	return new Proxy(real, {
		get(target, prop, receiver) {
			const orig = Reflect.get(target, prop, receiver);
			if (typeof prop === "string" && DEFERRED_METHODS.has(prop)) {
				return (...args: AnyArgs) => {
					queue.push({ method: prop, args });
				};
			}
			if (typeof orig === "function") {
				return orig.bind(target);
			}
			return orig;
		},
	}) as ExtensionAPI;
}

function flushQueue(real: ExtensionAPI, queue: DeferredCall[]): void {
	for (const call of queue) {
		const fn = (real as unknown as Record<string, unknown>)[call.method];
		if (typeof fn !== "function") continue;
		(fn as (...a: AnyArgs) => unknown).apply(real, call.args);
	}
}

interface SessionMissingReport {
	extName: string;
	missing: { name: string; reason: "not-installed" | "disabled" }[];
}

function buildHardDepReports(): SessionMissingReport[] {
	const state = getDepState();
	const all = getDeclaredExtensions();
	const byName = new Map(all.map((m) => [m.name, m]));

	const reports: SessionMissingReport[] = [];
	for (const pending of state.pending.values()) {
		const missing: SessionMissingReport["missing"] = [];
		for (const dep of pending.dependsOn) {
			const meta = byName.get(dep);
			if (!meta) {
				missing.push({ name: dep, reason: "not-installed" });
				continue;
			}
			if (meta.loadState !== "loaded" || meta.enabled === false) {
				missing.push({ name: dep, reason: "disabled" });
			}
		}
		if (missing.length > 0) {
			reports.push({ extName: pending.name, missing });
		}
	}
	return reports;
}

function formatHardDepNotice(report: SessionMissingReport): string {
	const items = report.missing
		.map((m) =>
			m.reason === "not-installed"
				? `${m.name} (not installed)`
				: `${m.name} (currently disabled)`,
		)
		.join(", ");
	return `✗ ${report.extName} refused to load: requires ${items}`;
}

function formatSoftDepNotices(): string[] {
	const all = getDeclaredExtensions();
	const byName = new Map(all.map((m) => [m.name, m]));

	const notices: string[] = [];
	for (const ext of all) {
		if (ext.loadState !== "loaded") continue;
		if (!ext.integratesWith?.length) continue;
		for (const dep of ext.integratesWith) {
			const meta = byName.get(dep);
			if (!meta) {
				notices.push(
					`ℹ ${ext.name}'s ${dep} integration unavailable (${dep} not installed)`,
				);
			} else if (meta.loadState !== "loaded" || meta.enabled === false) {
				notices.push(
					`ℹ ${ext.name}'s ${dep} integration unavailable (${dep} currently disabled)`,
				);
			}
		}
	}
	return notices;
}

function installSessionHandler(pi: ExtensionAPI): void {
	const state = getDepState();
	if (state.sessionHandlerInstalled) return;
	state.sessionHandlerInstalled = true;

	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		const reports = buildHardDepReports();
		const refusedNames = new Set(reports.map((r) => r.extName));

		for (const r of reports) {
			updateExtensionLoadState(r.extName, "disabled-by-missing-deps", false);
			ctx.ui.notify(formatHardDepNotice(r), "error");
		}

		// Flush queues for everyone whose hard deps passed.
		const pendingState = getDepState();
		for (const pending of pendingState.pending.values()) {
			if (pending.flushed) continue;
			if (refusedNames.has(pending.name)) {
				pending.flushed = true; // intentionally never flush
				continue;
			}
			flushQueue(pending.pi, pending.queue);
			pending.flushed = true;
		}

		for (const notice of formatSoftDepNotices()) {
			ctx.ui.notify(notice, "info");
		}
	});
}

/**
 * Wrap an extension factory in toggle + dep resolution. Returns a
 * function with pi's expected `(pi: ExtensionAPI) => void | Promise<void>`
 * shape so it can be used as `export default defineExtension(...)`.
 */
export function defineExtension(
	opts: DefineExtensionOptions,
	factory: (pi: ExtensionAPI) => void | Promise<void>,
): (pi: ExtensionAPI) => void | Promise<void> {
	return (pi: ExtensionAPI) => {
		const resolution = resolveEnabled(opts.name);
		declareExtension({
			name: opts.name,
			path: opts.path,
			doc: opts.doc,
			configSchema: opts.configSchema,
			backgroundModelUse: opts.backgroundModelUse,
			dependsOn: opts.dependsOn,
			integratesWith: opts.integratesWith,
			enabled: resolution.enabled,
			enabledSource: resolution.source,
			loadState: resolution.loadState,
		});

		if (!resolution.enabled) return;

		const hasHardDeps = !!opts.dependsOn?.length;
		if (!hasHardDeps) {
			// Soft-deps still want the once-per-session notify pass, so
			// install the handler regardless if any extension uses
			// integratesWith. Cheap: idempotent guard inside.
			if (opts.integratesWith?.length) installSessionHandler(pi);
			return factory(pi);
		}

		const queue: DeferredCall[] = [];
		const deferredPi = makeDeferredAPI(pi, queue);
		getDepState().pending.set(opts.name, {
			name: opts.name,
			pi,
			queue,
			dependsOn: opts.dependsOn ?? [],
			flushed: false,
		});
		installSessionHandler(pi);
		return factory(deferredPi);
	};
}
