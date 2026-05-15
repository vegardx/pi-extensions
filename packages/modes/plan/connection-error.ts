/**
 * Helpers for detecting transient network / connection errors in agent
 * messages and deciding whether the retry dialog should fire.
 */

/** Node.js / fetch patterns that indicate a transient connectivity failure. */
export const CONNECTION_ERROR_PATTERNS = [
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNRESET",
	"network",
	"fetch failed",
	"Connection error",
	"socket",
] as const;

/**
 * Returns true when `errorMessage` matches any known transient-network
 * pattern. Case-sensitive; patterns are chosen to match common Node.js /
 * fetch error strings verbatim.
 */
export function isConnectionError(errorMessage: string): boolean {
	return CONNECTION_ERROR_PATTERNS.some((p) => errorMessage.includes(p));
}

/**
 * Walks `messages` from the end looking for an assistant message with
 * `stopReason === "error"` whose `errorMessage` matches a transient
 * network pattern.
 *
 * Returns the `errorMessage` string if found, `null` otherwise.
 */
export function findConnectionError(
	messages: ReadonlyArray<{
		role: string;
		stopReason?: string;
		errorMessage?: string;
	}>,
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (
			m.role === "assistant" &&
			m.stopReason === "error" &&
			m.errorMessage &&
			isConnectionError(m.errorMessage)
		) {
			return m.errorMessage;
		}
	}
	return null;
}
