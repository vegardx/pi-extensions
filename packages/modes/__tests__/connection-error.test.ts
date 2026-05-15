/**
 * Unit tests for connection-error detection helpers (#139).
 */

import {
	CONNECTION_ERROR_PATTERNS,
	findConnectionError,
	isConnectionError,
} from "../plan/connection-error.js";

// ---- isConnectionError ---------------------------------------------------

describe("isConnectionError", () => {
	it.each(
		CONNECTION_ERROR_PATTERNS,
	)("returns true for pattern %s", (pattern) => {
		expect(isConnectionError(`Failed: ${pattern}`)).toBe(true);
	});

	it("returns false for a clean stop reason string", () => {
		expect(isConnectionError("Request succeeded")).toBe(false);
	});

	it("returns false for an unrelated error string", () => {
		expect(isConnectionError("SyntaxError: Unexpected token")).toBe(false);
	});

	it("returns true when pattern appears mid-string", () => {
		expect(isConnectionError("read ECONNRESET while streaming")).toBe(true);
	});
});

// ---- findConnectionError -------------------------------------------------

type SparseMessage = {
	role: string;
	stopReason?: string;
	errorMessage?: string;
};

function assistant(stopReason: string, errorMessage?: string): SparseMessage {
	return { role: "assistant", stopReason, errorMessage };
}

function user(): SparseMessage {
	return { role: "user" };
}

describe("findConnectionError", () => {
	it("(a) returns errorMessage when last assistant has connection error", () => {
		const messages = [
			user(),
			assistant("error", "connect ECONNREFUSED 127.0.0.1:8080"),
		];
		expect(findConnectionError(messages)).toBe(
			"connect ECONNREFUSED 127.0.0.1:8080",
		);
	});

	it("(b) returns null when stopReason is error but not a connection error", () => {
		const messages = [
			user(),
			assistant("error", "SyntaxError: Unexpected token at position 42"),
		];
		expect(findConnectionError(messages)).toBeNull();
	});

	it("(b) returns null when stopReason is stop (no error)", () => {
		const messages = [user(), assistant("stop")];
		expect(findConnectionError(messages)).toBeNull();
	});

	it("(b) returns null for empty messages array", () => {
		expect(findConnectionError([])).toBeNull();
	});

	it("finds error when it is not the last message", () => {
		// Later user message follows the failing assistant turn.
		const messages = [
			assistant(
				"error",
				"request to https://api.example.com failed, reason: fetch failed",
			),
			user(),
		];
		// The user message doesn't match; the assistant one does — found.
		expect(findConnectionError(messages)).toBe(
			"request to https://api.example.com failed, reason: fetch failed",
		);
	});

	it("prefers the last matching assistant message over earlier ones", () => {
		const messages = [
			assistant("error", "ETIMEDOUT first"),
			user(),
			assistant("error", "ECONNRESET last"),
		];
		expect(findConnectionError(messages)).toBe("ECONNRESET last");
	});

	it("ignores assistant messages with no errorMessage", () => {
		const messages = [
			user(),
			assistant("error", undefined),
			assistant("stop", "ECONNREFUSED in stop — ignored"),
		];
		expect(findConnectionError(messages)).toBeNull();
	});
});
