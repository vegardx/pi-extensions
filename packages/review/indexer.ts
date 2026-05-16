/**
 * Indexer lane — runs FIRST in the auto-review pipeline (before any
 * reviewer fan-out). Builds a compact JSON sketch of the diff that is
 * threaded into every reviewer's task payload as additional context.
 *
 * The indexer is a one-shot read-only subagent (same shape as a
 * reviewer); only the prompt and output schema differ. Failures are
 * captured in `error` and the report falls back to a `null` sketch
 * (downstream reviewers still run, just without the index context).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateJsonPayloads } from "@vegardx/pi-extensions-shared/json-extraction.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";

const INDEXER_PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"indexer.md",
);

export type IndexRiskKind =
	| "auth"
	| "network"
	| "fs"
	| "crypto"
	| "shell"
	| "sql"
	| "concurrency"
	| "public-api"
	| "other";

export interface IndexEntryPoint {
	file: string;
	line?: number;
	reason: string;
}

export interface IndexModule {
	name: string;
	files: string[];
	summary: string;
}

export interface IndexHotFile {
	file: string;
	additions: number;
	deletions: number;
	note?: string;
}

export interface IndexRiskSurface {
	kind: IndexRiskKind;
	where: string;
	note?: string;
}

/**
 * Structured map of the diff. The orchestrator and every reviewer
 * lane gets this as pre-computed evidence; lanes that don't care can
 * ignore the relevant sections.
 */
export interface IndexSketch {
	entryPoints: IndexEntryPoint[];
	modules: IndexModule[];
	hotFiles: IndexHotFile[];
	riskSurfaces: IndexRiskSurface[];
	openQuestions: string[];
}

const RISK_KINDS: readonly IndexRiskKind[] = [
	"auth",
	"network",
	"fs",
	"crypto",
	"shell",
	"sql",
	"concurrency",
	"public-api",
	"other",
];

export interface IndexerInvocation {
	/** Pre-assembled markdown task payload (diff + scope + file list). */
	task: string;
	provider: string;
	model: string;
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface IndexerOutcome {
	sketch: IndexSketch | null;
	/** Populated when the indexer subagent failed or emitted unparseable output. */
	error?: string;
}

/**
 * Build the indexer task payload. Mirrors `buildTaskFor`'s shape
 * (diff + scope + file list) so the indexer prompt can stay focused
 * on output schema rather than re-explaining the input shape.
 */
export function buildIndexerTask(rc: {
	scopeLabel: string;
	files: readonly string[];
	changedFiles: number;
	additions: number;
	deletions: number;
	diff: string;
}): string {
	const lines: string[] = [
		`Scope: ${rc.scopeLabel}. ${rc.changedFiles} changed files, ` +
			`+${rc.additions} / -${rc.deletions}.`,
		"",
		"Files in scope:",
		...rc.files.slice(0, 200).map((f) => `- ${f}`),
	];
	if (rc.files.length > 200) {
		lines.push(
			`… and ${rc.files.length - 200} more (read via tools as needed).`,
		);
	}
	lines.push("");
	lines.push("Unified diff:");
	lines.push("```diff");
	lines.push(rc.diff.trimEnd());
	lines.push("```");
	lines.push("");
	lines.push("Emit a single JSON object per your system prompt.");
	return lines.join("\n");
}

function isFiniteInt(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n);
}

function asString(o: Record<string, unknown>, k: string): string | undefined {
	const v = o[k];
	return typeof v === "string" ? v : undefined;
}

function parseEntryPoint(raw: unknown): IndexEntryPoint | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	const file = asString(o, "file");
	const reason = asString(o, "reason");
	if (!file || !reason) return null;
	const line = isFiniteInt(o.line) ? o.line : undefined;
	return line !== undefined ? { file, line, reason } : { file, reason };
}

function parseModule(raw: unknown): IndexModule | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	const name = asString(o, "name");
	const summary = asString(o, "summary");
	if (!name || !summary) return null;
	const filesRaw = o.files;
	const files = Array.isArray(filesRaw)
		? filesRaw.filter((f): f is string => typeof f === "string")
		: [];
	return { name, files, summary };
}

function parseHotFile(raw: unknown): IndexHotFile | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	const file = asString(o, "file");
	if (!file) return null;
	const additions = isFiniteInt(o.additions) ? o.additions : 0;
	const deletions = isFiniteInt(o.deletions) ? o.deletions : 0;
	const note = asString(o, "note");
	return note !== undefined
		? { file, additions, deletions, note }
		: { file, additions, deletions };
}

function parseRiskSurface(raw: unknown): IndexRiskSurface | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	const kindRaw = asString(o, "kind");
	const where = asString(o, "where");
	if (!where) return null;
	const kind: IndexRiskKind =
		kindRaw && (RISK_KINDS as readonly string[]).includes(kindRaw)
			? (kindRaw as IndexRiskKind)
			: "other";
	const note = asString(o, "note");
	return note !== undefined ? { kind, where, note } : { kind, where };
}

/**
 * Permissive parser: tolerates indexer output that wraps JSON in code
 * fences or includes leading prose. Rejects anything that doesn't
 * look like the documented schema. Pure — exported for unit tests.
 */
export function parseIndexerOutput(rawText: string): IndexSketch | null {
	for (const candidate of candidateJsonPayloads(rawText)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			continue;
		const o = parsed as Record<string, unknown>;
		const arr = (k: string): unknown[] =>
			Array.isArray(o[k]) ? (o[k] as unknown[]) : [];
		return {
			entryPoints: arr("entryPoints")
				.map(parseEntryPoint)
				.filter((x): x is IndexEntryPoint => x !== null),
			modules: arr("modules")
				.map(parseModule)
				.filter((x): x is IndexModule => x !== null),
			hotFiles: arr("hotFiles")
				.map(parseHotFile)
				.filter((x): x is IndexHotFile => x !== null),
			riskSurfaces: arr("riskSurfaces")
				.map(parseRiskSurface)
				.filter((x): x is IndexRiskSurface => x !== null),
			openQuestions: arr("openQuestions").filter(
				(q): q is string => typeof q === "string",
			),
		};
	}
	return null;
}

/**
 * Render an `IndexSketch` for embedding in a reviewer's task payload.
 * Returns an empty string for a `null` sketch (caller can simply skip
 * the section in that case).
 */
export function renderIndexSketchForReviewer(
	sketch: IndexSketch | null,
): string {
	if (!sketch) return "";
	const empty =
		sketch.entryPoints.length === 0 &&
		sketch.modules.length === 0 &&
		sketch.hotFiles.length === 0 &&
		sketch.riskSurfaces.length === 0 &&
		sketch.openQuestions.length === 0;
	if (empty) return "";
	return [
		"## Index (pre-computed map of the diff)",
		"",
		"The indexer agent ran before you and produced this structured map.",
		"Use it to find your starting points; you are not bound to its",
		"sections. Flag genuine issues regardless of whether the index",
		"highlighted the surface.",
		"",
		"```json",
		JSON.stringify(sketch, null, 2),
		"```",
	].join("\n");
}

/**
 * Spawn the indexer subagent. Same lifecycle as `runReviewer` — the
 * call is best-effort: errors are captured but never thrown. A
 * failed indexer run yields `{ sketch: null, error }` and the
 * pipeline continues without index context.
 */
export async function runIndexer(
	input: IndexerInvocation,
): Promise<IndexerOutcome> {
	const out = await runSubagent({
		tag: "indexer",
		task: input.task,
		systemPromptPath: INDEXER_PROMPT_PATH,
		provider: input.provider,
		model: input.model,
		cwd: input.cwd,
		signal: input.signal,
		timeoutMs: input.timeoutMs,
	});
	if (out.error) return { sketch: null, error: out.error };
	if (!out.rawText || out.rawText.trim().length === 0) {
		return { sketch: null, error: "indexer produced no output" };
	}
	const sketch = parseIndexerOutput(out.rawText);
	if (!sketch) {
		return {
			sketch: null,
			error: `indexer output not parseable: ${out.rawText.slice(0, 300)}`,
		};
	}
	return { sketch };
}
