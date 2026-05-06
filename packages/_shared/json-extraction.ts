/**
 * Shared JSON-extraction helper used by both `verify` and `review`
 * packages to recover valid JSON from subagent responses that may
 * include prose prefixes, code fences, or other wrapping.
 *
 * Extracted here so any improvement to the extraction strategy
 * (new fence styles, fallback heuristics, etc.) is applied to both
 * consumers in one place.
 */

/**
 * Produce a small set of candidate JSON strings from a raw subagent
 * response. Tries, in order:
 *
 *   1. The full trimmed text (many models emit bare JSON).
 *   2. Content of a ` ```json … ``` ` or ` ``` … ``` ` fence anywhere
 *      in the response — the most common misbehaviour we observe.
 *   3. Text from the first `[` onward (prose-then-array).
 *   4. Text from the first `{` onward (prose-then-object).
 *
 * Deduplicates so the same string is never tried twice. The first
 * candidate that parses successfully wins; no candidate is guaranteed
 * to produce valid JSON.
 */
export function candidateJsonPayloads(raw: string): string[] {
	const trimmed = raw.trim();
	const seen = new Set<string>();
	const out: string[] = [];
	const push = (s: string) => {
		const t = s.trim();
		if (t && !seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	};
	push(trimmed);
	// Fence anywhere in the response (no ^ / $ anchors).
	const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fence?.[1]) push(fence[1]);
	// Prose before a bare array.
	const bracketIdx = trimmed.indexOf("[");
	if (bracketIdx > 0) push(trimmed.slice(bracketIdx));
	// Prose before a bare object.
	const braceIdx = trimmed.indexOf("{");
	if (braceIdx > 0) push(trimmed.slice(braceIdx));
	return out;
}
