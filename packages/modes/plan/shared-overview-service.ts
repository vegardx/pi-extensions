import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModelWithin } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";

const PROMPTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompts",
);

const OVERVIEW_AGENT_PROMPT = join(PROMPTS_DIR, "explore-overview-agent.md");
const OVERVIEW_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_MS = 1_500;
const MODEL_RESOLVE_TIMEOUT_MS = 5_000;
const FAILURE_COOLDOWN_MS = 30_000;

export interface SharedOverviewServiceOptions {
	timeoutMs?: number;
	waitMs?: number;
}

/**
 * Session/cwd-scoped codebase overview for clean explore children.
 *
 * The overview is deliberately lazy and best-effort. Plan mode must not
 * launch hidden background agents on session start, and child explore work
 * must not block indefinitely waiting for a shared overview. If the overview
 * is slow or unavailable, children proceed with the bare question.
 */
export class SharedOverviewService {
	private cwd: string | null = null;
	private overview: string | null = null;
	private building: Promise<string | null> | null = null;
	private failedUntil = 0;
	private readonly timeoutMs: number;
	private readonly waitMs: number;

	constructor(opts: SharedOverviewServiceOptions = {}) {
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
	}

	ensureStarted(_ctx: ExtensionContext): void {
		// Intentionally no-op. This used to kick off a hidden subagent when
		// entering plan mode, which made ordinary editing/session transitions
		// vulnerable to an unrelated stuck child pi process.
	}

	async get(ctx: ExtensionContext): Promise<string | null> {
		if (this.cwd !== ctx.cwd) this.reset(ctx.cwd);
		if (this.overview) return this.overview;
		if (Date.now() < this.failedUntil) return null;

		if (!this.building) {
			this.building = this.build(ctx).finally(() => {
				this.building = null;
			});
		}
		return this.waitForOverview(this.building);
	}

	reset(cwd: string | null = null): void {
		this.cwd = cwd;
		this.overview = null;
		this.building = null;
		this.failedUntil = 0;
	}

	private async waitForOverview(
		building: Promise<string | null>,
	): Promise<string | null> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), this.waitMs);
			timer.unref?.();
		});
		try {
			return await Promise.race([building, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async build(ctx: ExtensionContext): Promise<string | null> {
		const resolved = await resolveModelWithin(
			ctx,
			{ name: "modes", tier: "fast" },
			MODEL_RESOLVE_TIMEOUT_MS,
		);
		if (!resolved) return this.markFailed();

		const signal = AbortSignal.timeout(this.timeoutMs);
		const result = await runSubagent({
			tag: "explore-overview",
			task: "Index this repository for future clean codebase-explore subagents.",
			systemPromptPath: OVERVIEW_AGENT_PROMPT,
			tools: OVERVIEW_TOOLS,
			provider: resolved.model.provider,
			model: resolved.model.id,
			cwd: ctx.cwd,
			signal,
			timeoutMs: this.timeoutMs,
		});
		if (result.error) return this.markFailed();
		const text = result.rawText.trim();
		if (!text) return this.markFailed();
		this.overview = text;
		return text;
	}

	private markFailed(): null {
		this.failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
		return null;
	}
}
