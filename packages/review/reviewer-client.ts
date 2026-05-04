import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@mariozechner/pi-coding-agent";
import {
	parseReviewerOutput,
	type RawFinding,
	type ReviewerRole,
} from "./findings.js";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

function promptFileFor(role: ReviewerRole): string {
	return join(PROMPTS_DIR, `${role}.md`);
}

export interface ReviewerInvocation {
	role: ReviewerRole;
	/** Task payload: a pre-assembled markdown message with diff / file list. */
	task: string;
	provider: string;
	model: string;
	cwd: string;
	/** Abort signal — wired to the active agent turn when one exists. */
	signal?: AbortSignal;
}

export interface ReviewerOutcome {
	role: ReviewerRole;
	findings: RawFinding[];
	/** Populated when the reviewer failed to start, crashed, or emitted non-JSON. */
	error?: string;
}

/**
 * Spawn one reviewer subagent, send it the task, collect its JSON reply,
 * then tear it down. Unlike nitpick's long-lived reviewer, /review fires
 * each role as a one-shot — we don't need per-turn continuity.
 */
export async function runReviewer(
	input: ReviewerInvocation,
): Promise<ReviewerOutcome> {
	const cliPath = process.argv[1];
	if (!cliPath) {
		return {
			role: input.role,
			findings: [],
			error: "could not locate pi cli entry point",
		};
	}
	const client = new RpcClient({
		cliPath,
		cwd: input.cwd,
		provider: input.provider,
		model: input.model,
		args: [
			"--no-session",
			"--tools",
			"read,grep,find,ls",
			"--append-system-prompt",
			promptFileFor(input.role),
		],
	});

	const aborted = new Promise<never>((_resolve, reject) => {
		if (!input.signal) return;
		if (input.signal.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const onAbort = () => reject(new Error("aborted"));
		input.signal.addEventListener("abort", onAbort, { once: true });
	});

	try {
		await Promise.race([client.start(), aborted]);
	} catch (err) {
		await tryStop(client);
		return {
			role: input.role,
			findings: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}

	try {
		await Promise.race([client.prompt(input.task), aborted]);
		await Promise.race([client.waitForIdle(), aborted]);
		const raw = (await client.getLastAssistantText()) ?? "";
		const parsed = parseReviewerOutput(raw);
		if (parsed === null) {
			return {
				role: input.role,
				findings: [],
				error: `reviewer output was not valid JSON:\n${raw.slice(0, 500)}`,
			};
		}
		return { role: input.role, findings: parsed };
	} catch (err) {
		return {
			role: input.role,
			findings: [],
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		await tryStop(client);
	}
}

async function tryStop(client: RpcClient): Promise<void> {
	try {
		await client.stop();
	} catch {
		/* best-effort shutdown */
	}
}
