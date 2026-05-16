/**
 * `gh issue create` wrapper for /derp.
 *
 * Thin re-export over `@vegardx/pi-extensions-shared/gh-issue.js`
 * that bakes in derp's `pendingDir` default
 * (`~/.pi/agent/derp/pending/`). All pure helpers are re-exported
 * unchanged so existing tests keep working.
 */

import {
	defaultPendingDir,
	type GhRunner,
	type IssueCreateInput,
	type IssueCreateOutcome,
	createIssue as sharedCreateIssue,
	writePendingReport as sharedWritePendingReport,
} from "@vegardx/pi-extensions-shared/gh-issue.js";

export {
	buildIssueArgv,
	type GhRunner,
	type GhRunResult,
	type IssueCreateInput,
	type IssueCreateOutcome,
	isAuthError,
	isUnknownLabelError,
	parseIssueUrl,
	pendingFilePath,
	runGh,
} from "@vegardx/pi-extensions-shared/gh-issue.js";

const DERP_PENDING_DIR = defaultPendingDir("derp");

export function writePendingReport(
	draft: { title: string; body: string },
	host: string,
	dir?: string,
): string {
	return sharedWritePendingReport(draft, host, dir ?? DERP_PENDING_DIR);
}

export function createIssue(
	input: IssueCreateInput,
	runner?: GhRunner,
	pendingDir?: string,
): IssueCreateOutcome {
	return sharedCreateIssue(input, runner, pendingDir ?? DERP_PENDING_DIR);
}
