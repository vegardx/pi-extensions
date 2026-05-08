/**
 * Minimal YAML frontmatter parser for handover files.
 *
 * Only handles flat key-value pairs with string values (optionally quoted).
 * No dependency on a full YAML library — handover frontmatter is simple
 * and controlled by us.
 */

export interface HandoverMeta {
	date: string;
	session_id: string;
	repo?: string;
	branch?: string;
	cwd?: string;
}

export interface ParsedHandover {
	meta: HandoverMeta;
	body: string;
}

/**
 * Parse a handover file's content into structured metadata and body.
 * Returns `null` if the file doesn't have valid frontmatter.
 */
export function parseHandover(content: string): ParsedHandover | null {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith("---")) return null;

	const endIdx = trimmed.indexOf("\n---", 3);
	if (endIdx === -1) return null;

	const fmBlock = trimmed.slice(3, endIdx).trim();
	const body = trimmed.slice(endIdx + 4).trim();

	const meta: Record<string, string> = {};
	for (const line of fmBlock.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value = line.slice(colonIdx + 1).trim();
		// Strip surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		meta[key] = value;
	}

	if (!meta.date || !meta.session_id) return null;

	return {
		meta: {
			date: meta.date,
			session_id: meta.session_id,
			repo: meta.repo || undefined,
			branch: meta.branch || undefined,
			cwd: meta.cwd || undefined,
		},
		body,
	};
}
