/**
 * Tool registrations for the deliverable/work-item plan system.
 *
 * Three tools:
 *   - deliverable: manage deliverables (add/update/remove/reorder/list)
 *   - task:        manage work items (add/update/toggle/remove/move)
 *   - plan:        read-only markdown summary
 *
 * All three operate on the "current plan" — the plan slug that the session
 * is currently working with. The session owner (modes/index.ts) is
 * responsible for setting / clearing the current slug; these tools just
 * read it via a getter callback.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	canTransition,
	childDeliverables,
	DELIVERABLE_STATUSES,
	type Deliverable,
	type DeliverableLifecycle,
	type DeliverableStatus,
	defaultBranchForDeliverable,
	deliverableId,
	deliverables,
	effectiveWorkItemKind,
	findLifecycle,
	gatingTasks,
	isDeliverable,
	isWorkItem,
	matchDeliverableId,
	matchWorkItemId,
	ownWorkItems,
	type Plan,
	type PlanNode,
	WORK_ITEM_KINDS,
	type WorkItem,
	type WorkItemKind,
	workItemId,
} from "./schema.js";
import { loadPlan, savePlan } from "./storage.js";
import { parentOf, topLevelLeaves } from "./tree.js";

type Details = Record<string, unknown>;
type Result = AgentToolResult<Details>;

export interface PlanToolHooks {
	/** Returns the active plan's slug, or null if no plan is active. */
	getCurrentPlanSlug(): string | null;
	/** Called after any successful mutation so modes can refresh widgets. */
	onPlanChanged(plan: Plan, ctx: ExtensionContext): void;
}

function nowIso(): string {
	return new Date().toISOString();
}

function loadOrError(slug: string | null): Plan | string {
	if (!slug) {
		return "no plan active — run /plan first to start one";
	}
	const plan = loadPlan(slug);
	if (!plan) return `plan ${slug} not found on disk`;
	return plan;
}

function err(text: string, code?: string): Result {
	return {
		content: [{ type: "text", text }],
		details: { error: code ?? text },
	};
}

function itemBullet(item: WorkItem): string {
	const kind = effectiveWorkItemKind(item);
	if (kind === "task") {
		return `- [${item.done ? "x" : " "}] **${item.title}** \`${item.id}\``;
	}
	const marker =
		kind === "question" ? "[?]" : kind === "manual" ? "[!]" : "[~]";
	const answered =
		kind === "question" && item.answer !== undefined ? " _(answered)_" : "";
	return `- ${marker} **${item.title}** \`${item.id}\` _(${kind})_${answered}`;
}

function renderItemBlock(
	lines: string[],
	items: WorkItem[],
	indent: string,
): void {
	for (const t of items) {
		lines.push(`${indent}${itemBullet(t)}`);
		if (t.body) {
			for (const l of t.body.split("\n")) lines.push(`${indent}  ${l}`);
		}
		if (t.answer !== undefined) {
			lines.push(`${indent}  → answer: ${t.answer}`);
		}
	}
}

function renderManualItemBlock(
	lines: string[],
	items: WorkItem[],
	indent: string,
): void {
	for (const item of items) {
		const box = item.done ? "[x]" : "[!]";
		lines.push(`${indent}- ${box} ${item.title}`);
		if (item.body.trim().length > 0) {
			for (const bodyLine of item.body.split("\n")) {
				lines.push(`${indent}  ${bodyLine}`);
			}
		}
	}
}

function renderDeliverableBlock(
	lines: string[],
	d: Deliverable,
	depth: number,
): void {
	const issueRef = d.issueNumber ? ` — #${d.issueNumber}` : "";
	const driverRef = d.driverSessionId
		? ` — driver: \`${d.driverSessionId.slice(0, 8)}\``
		: "";
	const lifecycleMarker = d.lifecycle ? ` [${d.lifecycle}]` : "";
	const groupMarker = childDeliverables(d).length > 0 ? " _(grouping)_" : "";
	const heading = "#".repeat(Math.min(3 + depth, 6));
	lines.push(
		`${heading} ${d.title} \`${d.id}\`${lifecycleMarker} [${d.status}]${issueRef}${driverRef}${groupMarker}`,
	);
	if (d.dependsOn && d.dependsOn.length > 0) {
		lines.push("");
		lines.push(`depends on: ${d.dependsOn.map((x) => `\`${x}\``).join(", ")}`);
	}
	if (d.body) {
		lines.push("");
		lines.push(`> ${d.body}`);
	}
	const items = ownWorkItems(d);
	if (items.length > 0) {
		lines.push("");
		// Lifecycle items render with `[!]` regardless of declared kind —
		// they're a manual checklist visually.
		if (d.lifecycle) {
			renderManualItemBlock(lines, items, "");
		} else {
			renderItemBlock(lines, items, "");
		}
	}
	lines.push("");
	for (const child of childDeliverables(d)) {
		renderDeliverableBlock(lines, child, depth + 1);
	}
}

function planSummaryMarkdown(plan: Plan): string {
	const lines: string[] = [];
	lines.push(`# ${plan.title} (\`${plan.slug}\`)`);
	lines.push("");
	if (plan.parentIssueNumber) {
		lines.push(`Tracking issue: #${plan.parentIssueNumber}`);
		lines.push("");
	}
	const topDeliverables = plan.nodes.filter(isDeliverable);
	if (topDeliverables.length === 0) {
		lines.push("_No deliverables yet._");
	} else {
		const pre = topDeliverables.filter((d) => d.lifecycle === "pre");
		const regular = topDeliverables.filter((d) => !d.lifecycle);
		const post = topDeliverables.filter((d) => d.lifecycle === "post");

		if (pre.length > 0) {
			lines.push("## Preflight (manual; complete before regular deliverables)");
			lines.push("");
			for (const d of pre) renderDeliverableBlock(lines, d, 0);
		}
		if (regular.length > 0) {
			lines.push("## Deliverables");
			lines.push("");
			for (const d of regular) renderDeliverableBlock(lines, d, 0);
		}
		if (post.length > 0) {
			lines.push("## Handover (manual; complete after last deliverable ships)");
			lines.push("");
			for (const d of post) renderDeliverableBlock(lines, d, 0);
		}
	}
	const leaves = topLevelLeaves(plan);
	if (leaves.length > 0) {
		lines.push("## Loose items");
		lines.push("");
		renderItemBlock(lines, leaves, "");
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function findDeliverableNode(plan: Plan, id: string): Deliverable | undefined {
	return deliverables(plan).find((d) => matchDeliverableId(d.id, id));
}

/** The array a deliverable lives in (its parent's children, or plan.nodes). */
function siblingsOf(plan: Plan, d: Deliverable): PlanNode[] {
	const parent = parentOf(plan, d.id);
	return parent ? parent.children : plan.nodes;
}

/**
 * Where a work-item lives — inside a specific deliverable, or at the
 * plan's top level (sentinel `deliverableId === "@plan"`, the loose
 * leaves).
 */
type ItemContainer =
	| { kind: "deliverable"; deliverable: Deliverable; label: string }
	| { kind: "plan"; label: string };

const PLAN_SENTINEL = "@plan";

function resolveItemContainer(
	plan: Plan,
	deliverableIdParam: string,
): ItemContainer | { error: string } {
	if (deliverableIdParam === PLAN_SENTINEL) {
		return { kind: "plan", label: "plan loose items" };
	}
	const d = findDeliverableNode(plan, deliverableIdParam);
	if (!d) return { error: `Deliverable \`${deliverableIdParam}\` not found` };
	return {
		kind: "deliverable",
		deliverable: d,
		label: `deliverable \`${d.id}\``,
	};
}

function containerItems(plan: Plan, container: ItemContainer): WorkItem[] {
	return container.kind === "deliverable"
		? ownWorkItems(container.deliverable)
		: topLevelLeaves(plan);
}

function containerNodes(plan: Plan, container: ItemContainer): PlanNode[] {
	return container.kind === "deliverable"
		? container.deliverable.children
		: plan.nodes;
}

function stampContainer(container: ItemContainer, plan: Plan): void {
	const now = nowIso();
	if (container.kind === "deliverable") {
		container.deliverable.updatedAt = now;
	}
	plan.updatedAt = now;
}

/**
 * Validate a `dependsOn` candidate. Returns null if valid, or a
 * user-facing error string. Enforces: at most one parent, no
 * self-reference, targets exist, no cycles.
 */
function validateDependsOn(
	plan: Plan,
	selfId: string,
	dependsOn: string[],
): string | null {
	if (dependsOn.length > 1) {
		return (
			`Deliverable \`${selfId}\` cannot depend on multiple deliverables ` +
			`(${dependsOn.map((d) => `\`${d}\``).join(", ")}). ` +
			"Compaction summaries carry forward through a chain; chain them " +
			"as `B → C → D` instead of `{B, C} → D`."
		);
	}
	for (const dep of dependsOn) {
		if (matchDeliverableId(dep, selfId)) {
			return `Deliverable \`${selfId}\` cannot depend on itself`;
		}
		const found = findDeliverableNode(plan, dep);
		if (!found) {
			return `dependsOn references unknown deliverable \`${dep}\``;
		}
	}
	if (detectCycle(plan, selfId, dependsOn)) {
		return `dependsOn would create a cycle through \`${selfId}\``;
	}
	return null;
}

function detectCycle(plan: Plan, selfId: string, candidate: string[]): boolean {
	const seen = new Set<string>();
	const stack = [...candidate];
	while (stack.length > 0) {
		const id = stack.pop();
		if (!id) continue;
		if (matchDeliverableId(id, selfId)) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		const d = findDeliverableNode(plan, id);
		if (!d) continue;
		for (const dep of d.dependsOn ?? []) stack.push(dep);
	}
	return false;
}

/**
 * Resolve user-supplied dependsOn ids to their canonical (stored)
 * form so legacy `p-` prefixed inputs match the actual id on disk.
 */
function canonicaliseDependsOn(plan: Plan, ids: string[]): string[] {
	const out: string[] = [];
	for (const id of ids) {
		const found = findDeliverableNode(plan, id);
		out.push(found ? found.id : id);
	}
	return out;
}

export function registerPlanTools(
	pi: ExtensionAPI,
	hooks: PlanToolHooks,
): void {
	// ---- deliverable --------------------------------------------------

	pi.registerTool({
		name: "deliverable",
		label: "Deliverable",
		description:
			"Manage deliverables of the current plan. A deliverable either ships " +
			"as one PR (it has its own task items) or groups child deliverables " +
			"(nesting = decomposition; children can run in parallel). " +
			"Actions: add, update, remove, reorder, list.",
		promptSnippet: "Add, update, remove, reorder, or list deliverables",
		promptGuidelines: [
			"Use deliverable to structure the plan. A deliverable with its own " +
				"task items ships as one PR; a deliverable with child deliverables " +
				"is a grouping that completes when its subtree ships. Never mix " +
				"gating tasks and child deliverables on the same node.",
			"Nesting is decomposition: pass `parentId` to add a child under a " +
				"grouping. Children are parallel by default — sequence them with " +
				"`dependsOn` (at most one parent; the stacking edge for stacked " +
				"PRs). Cross-subtree dependsOn is allowed.",
			"A deliverable has a short title and a `body` (what ships when it " +
				"merges). Use task to add work items.",
			"Status transitions are gated by the state machine. The agent should " +
				"normally not set status directly — modes' /implement, /ship, and " +
				"/sync handle transitions automatically.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("add"),
				Type.Literal("update"),
				Type.Literal("remove"),
				Type.Literal("reorder"),
				Type.Literal("list"),
			]),
			id: Type.Optional(
				Type.String({
					description: "Deliverable id (required for update/remove/reorder)",
				}),
			),
			title: Type.Optional(Type.String({ description: "Deliverable title" })),
			body: Type.Optional(
				Type.String({
					description: "What ships when this merges — context, criteria",
				}),
			),
			status: Type.Optional(
				Type.Union(DELIVERABLE_STATUSES.map((s) => Type.Literal(s))),
			),
			dependsOn: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Deliverable ids this one depends on (the stacking edge). At " +
						"most one parent. On `add`, omitting this defaults to chaining " +
						"off the last sibling (linear plans). Pass `[]` explicitly to " +
						"declare a root (parallel sibling).",
				}),
			),
			parentId: Type.Optional(
				Type.String({
					description:
						"Nest the new deliverable under this grouping (add only). " +
						"Omit for top-level.",
				}),
			),
			position: Type.Optional(
				Type.Number({ description: "0-indexed position (for reorder/add)" }),
			),
			lifecycle: Type.Optional(
				Type.Union([Type.Literal("pre"), Type.Literal("post")], {
					description:
						"Manual checklist at the plan boundary. `pre` blocks regular " +
						"work until ticked; `post` surfaces after the last deliverable " +
						"ships. Top-level only, at most one of each; never claims a " +
						"branch, never ships a PR.",
				}),
			),
		}),

		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<Result> {
			const slug = hooks.getCurrentPlanSlug();
			const planOrError = loadOrError(slug);
			if (typeof planOrError === "string") {
				return err(planOrError);
			}
			const plan = planOrError;

			switch (params.action) {
				case "list": {
					const flat = deliverables(plan);
					return {
						content: [
							{
								type: "text",
								text:
									flat.length === 0
										? "No deliverables yet"
										: flat
												.map(
													(d, i) =>
														`${i + 1}. \`${d.id}\` [${d.status}] ${d.title}`,
												)
												.join("\n"),
							},
						],
						details: { action: "list", deliverables: flat },
					};
				}

				case "add": {
					if (!params.title) {
						return err("Error: title is required", "title required");
					}
					const id = deliverableId(params.title);
					if (findDeliverableNode(plan, id)) {
						return err(
							`Deliverable \`${id}\` already exists — pick a different title`,
							"duplicate deliverable id",
						);
					}
					const lifecycle = params.lifecycle as
						| DeliverableLifecycle
						| undefined;
					if (lifecycle && findLifecycle(plan, lifecycle)) {
						return err(
							`Plan already has a \`${lifecycle}\` deliverable — at most one is allowed`,
							`duplicate ${lifecycle} deliverable`,
						);
					}
					if (lifecycle && params.parentId) {
						return err(
							"Lifecycle deliverables must be top-level (no parentId)",
							"lifecycle must be top-level",
						);
					}
					let parent: Deliverable | undefined;
					if (params.parentId) {
						parent = findDeliverableNode(plan, params.parentId);
						if (!parent) {
							return err(
								`Parent deliverable \`${params.parentId}\` not found`,
								"parent not found",
							);
						}
						if (parent.lifecycle) {
							return err(
								`Cannot nest under lifecycle deliverable \`${parent.id}\``,
								"lifecycle cannot nest",
							);
						}
						if (gatingTasks(parent).length > 0) {
							return err(
								`Deliverable \`${parent.id}\` has its own gating tasks — ` +
									"a deliverable either ships itself or groups children, " +
									"never both. Move its tasks into a child first.",
								"gating xor violated",
							);
						}
					}
					const siblings = parent ? parent.children : plan.nodes;
					const siblingDeliverables = siblings.filter(isDeliverable);
					const dependsOn = canonicaliseDependsOn(
						plan,
						// Ergonomic default: chain new deliverables off the last
						// sibling. Pass `dependsOn: []` explicitly to declare a
						// parallel root. Lifecycle checklists never join the chain.
						params.dependsOn ??
							(lifecycle
								? []
								: siblingDeliverables.length > 0
									? [siblingDeliverables[siblingDeliverables.length - 1].id]
									: []),
					);
					const depErr = validateDependsOn(plan, id, dependsOn);
					if (depErr) return err(depErr);
					const d: Deliverable = {
						type: "deliverable",
						id,
						title: params.title,
						body: params.body ?? "",
						status: "planned",
						// Lifecycle checklists never claim a feature branch.
						...(lifecycle
							? { lifecycle }
							: { branch: defaultBranchForDeliverable({ id }) }),
						dependsOn,
						children: [],
						createdAt: nowIso(),
						updatedAt: nowIso(),
					};
					if (
						params.position !== undefined &&
						params.position >= 0 &&
						params.position <= siblings.length
					) {
						siblings.splice(params.position, 0, d);
					} else {
						siblings.push(d);
					}
					if (parent) parent.updatedAt = nowIso();
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{
								type: "text",
								text: `Added deliverable \`${id}\`${parent ? ` under \`${parent.id}\`` : ""}: ${d.title}`,
							},
						],
						details: { action: "add", deliverable: d },
					};
				}

				case "update": {
					if (!params.id) {
						return err("Error: id is required", "id required");
					}
					const d = findDeliverableNode(plan, params.id);
					if (!d) {
						return err(
							`Deliverable \`${params.id}\` not found`,
							"deliverable not found",
						);
					}
					if (params.title !== undefined) d.title = params.title;
					if (params.body !== undefined) d.body = params.body;
					if (params.lifecycle !== undefined) {
						const next = params.lifecycle as DeliverableLifecycle;
						if (d.lifecycle !== next) {
							if (findLifecycle(plan, next)) {
								return err(
									`Plan already has a \`${next}\` deliverable — at most one is allowed`,
									`duplicate ${next} deliverable`,
								);
							}
							if (parentOf(plan, d.id)) {
								return err(
									"Lifecycle deliverables must be top-level",
									"lifecycle must be top-level",
								);
							}
							if (childDeliverables(d).length > 0) {
								return err(
									`Cannot make \`${d.id}\` a lifecycle checklist — it has child deliverables`,
									"lifecycle cannot nest",
								);
							}
							d.lifecycle = next;
							delete d.branch;
						}
					}
					if (params.dependsOn !== undefined) {
						const dependsOn = canonicaliseDependsOn(plan, params.dependsOn);
						const depErr = validateDependsOn(plan, d.id, dependsOn);
						if (depErr) return err(depErr);
						d.dependsOn = dependsOn;
					}
					if (params.status !== undefined) {
						if (d.status !== (params.status as DeliverableStatus)) {
							if (
								!canTransition(d.status, params.status as DeliverableStatus)
							) {
								return err(
									`Cannot transition \`${d.id}\` from \`${d.status}\` to \`${params.status}\``,
									"invalid transition",
								);
							}
							d.status = params.status as DeliverableStatus;
						}
						// else: already in target state — idempotent, skip mutation
					}
					d.updatedAt = nowIso();
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{ type: "text", text: `Updated deliverable \`${d.id}\`` },
						],
						details: { action: "update", deliverable: d },
					};
				}

				case "remove": {
					if (!params.id) {
						return err("Error: id is required", "id required");
					}
					const d = findDeliverableNode(plan, params.id);
					if (!d) {
						return err(
							`Deliverable \`${params.id}\` not found`,
							"deliverable not found",
						);
					}
					const siblings = siblingsOf(plan, d);
					const idx = siblings.indexOf(d);
					siblings.splice(idx, 1);
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{ type: "text", text: `Removed deliverable \`${d.id}\`` },
						],
						details: { action: "remove", deliverable: d },
					};
				}

				case "reorder": {
					if (!params.id || params.position === undefined) {
						return err(
							"Error: id and position are required",
							"id and position required",
						);
					}
					const d = findDeliverableNode(plan, params.id);
					if (!d) {
						return err(
							`Deliverable \`${params.id}\` not found`,
							"deliverable not found",
						);
					}
					const siblings = siblingsOf(plan, d);
					const idx = siblings.indexOf(d);
					siblings.splice(idx, 1);
					const target = Math.max(
						0,
						Math.min(params.position, siblings.length),
					);
					siblings.splice(target, 0, d);
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{
								type: "text",
								text: `Moved deliverable \`${d.id}\` to position ${target}`,
							},
						],
						details: { action: "reorder", deliverable: d },
					};
				}
			}
		},
	});

	// ---- task ---------------------------------------------------------

	pi.registerTool({
		name: "task",
		label: "Task",
		description:
			"Manage work items within a deliverable. A work item is a concrete " +
			"checklist line with a short title and detailed body. Pass " +
			"`phaseId='@plan'` to manage plan-level loose items (followups/" +
			"questions only). Actions: add, update, toggle, remove, move.",
		promptSnippet: "Add, update, toggle, remove, or move work items",
		promptGuidelines: [
			"Use task to add detail to a deliverable. The title is short " +
				"(scannable); put context, acceptance criteria, files, and test " +
				"notes in `body`.",
			"Set `kind` when adding. `task` (default) gates the deliverable's " +
				"completion. `followup`, `question`, and `manual` are informational " +
				"— they surface in PR/issue bodies but never block /ship.",
			"Answer a question with task(update, …, answer: '…') — this records " +
				"the decision and timestamps it.",
			"Pass `phaseId='@plan'` for plan-level loose items; gating `task` " +
				"items are not allowed there.",
			"During implementation, call task(toggle, phaseId, taskId) to mark " +
				"each item done.",
			"To move an item between deliverables (or to/from `@plan`), use " +
				"action='move' with targetPhaseId.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("add"),
				Type.Literal("update"),
				Type.Literal("toggle"),
				Type.Literal("remove"),
				Type.Literal("move"),
			]),
			phaseId: Type.String({
				description: "Deliverable id, or `@plan` for plan-level loose items",
			}),
			taskId: Type.Optional(
				Type.String({
					description: "Work-item id (required for update/toggle/remove/move)",
				}),
			),
			title: Type.Optional(Type.String({ description: "Work-item title" })),
			body: Type.Optional(
				Type.String({
					description:
						"Work-item body — context, acceptance criteria, files, tests",
				}),
			),
			kind: Type.Optional(
				Type.Union(
					WORK_ITEM_KINDS.map((k) => Type.Literal(k)),
					{
						description:
							"Work-item kind. `task` (default) gates deliverable " +
							"completion; `followup`/`question`/`manual` are informational.",
					},
				),
			),
			answer: Type.Optional(
				Type.String({
					description:
						"For `question` items (update action): record the decision. " +
						"Stamps decidedAt.",
				}),
			),
			targetPhaseId: Type.Optional(
				Type.String({
					description:
						"Destination deliverable (for move). `@plan` moves to plan-level loose items.",
				}),
			),
			position: Type.Optional(
				Type.Number({ description: "0-indexed position within the container" }),
			),
		}),

		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<Result> {
			const slug = hooks.getCurrentPlanSlug();
			const planOrError = loadOrError(slug);
			if (typeof planOrError === "string") {
				return err(planOrError);
			}
			const plan = planOrError;
			const container = resolveItemContainer(plan, params.phaseId);
			if ("error" in container) {
				return err(container.error, "deliverable not found");
			}
			const containerIdForDetails =
				container.kind === "deliverable"
					? container.deliverable.id
					: PLAN_SENTINEL;

			switch (params.action) {
				case "add": {
					if (!params.title) {
						return err("Error: title is required", "title required");
					}
					const kind = (params.kind as WorkItemKind | undefined) ?? "task";
					if (container.kind === "plan" && kind === "task") {
						return err(
							"Plan-level loose items can't be gating `task` items — " +
								"attach the task to a deliverable, or use kind " +
								"`followup`/`question`/`manual`.",
							"plan-level task forbidden",
						);
					}
					if (
						container.kind === "deliverable" &&
						kind === "task" &&
						childDeliverables(container.deliverable).length > 0
					) {
						return err(
							`Deliverable \`${container.deliverable.id}\` is a grouping ` +
								"(has child deliverables) — gating tasks belong on its " +
								"children, not the grouping itself.",
							"gating xor violated",
						);
					}
					const id = workItemId(params.title);
					if (
						containerItems(plan, container).some((t) =>
							matchWorkItemId(t.id, id),
						)
					) {
						return err(
							`Work item \`${id}\` already exists in ${container.label}`,
							"duplicate work-item id",
						);
					}
					const item: WorkItem = {
						type: "work-item",
						id,
						title: params.title,
						body: params.body ?? "",
						done: false,
						kind,
						createdAt: nowIso(),
						updatedAt: nowIso(),
					};
					const nodes = containerNodes(plan, container);
					if (
						params.position !== undefined &&
						params.position >= 0 &&
						params.position <= nodes.length
					) {
						nodes.splice(params.position, 0, item);
					} else {
						nodes.push(item);
					}
					stampContainer(container, plan);
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{
								type: "text",
								text: `Added work item \`${item.id}\` to ${container.label}`,
							},
						],
						details: {
							action: "add",
							task: item,
							phaseId: containerIdForDetails,
						},
					};
				}

				case "update": {
					if (!params.taskId) {
						return err("Error: taskId is required", "taskId required");
					}
					const item = containerItems(plan, container).find((t) =>
						matchWorkItemId(t.id, params.taskId as string),
					);
					if (!item) {
						return err(
							`Work item \`${params.taskId}\` not found in ${container.label}`,
							"task not found",
						);
					}
					if (params.title !== undefined) item.title = params.title;
					if (params.body !== undefined) item.body = params.body;
					if (params.kind !== undefined) {
						item.kind = params.kind as WorkItemKind;
					}
					if (params.answer !== undefined) {
						item.answer = params.answer;
						item.decidedAt = nowIso();
					}
					item.updatedAt = nowIso();
					stampContainer(container, plan);
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{ type: "text", text: `Updated work item \`${item.id}\`` },
						],
						details: {
							action: "update",
							task: item,
							phaseId: containerIdForDetails,
						},
					};
				}

				case "toggle": {
					if (!params.taskId) {
						return err("Error: taskId is required", "taskId required");
					}
					const item = containerItems(plan, container).find((t) =>
						matchWorkItemId(t.id, params.taskId as string),
					);
					if (!item) {
						return err(
							`Work item \`${params.taskId}\` not found`,
							"task not found",
						);
					}
					item.done = !item.done;
					item.updatedAt = nowIso();
					stampContainer(container, plan);
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{
								type: "text",
								text: `${item.done ? "✓" : "○"} \`${item.id}\``,
							},
						],
						details: {
							action: "toggle",
							task: item,
							phaseId: containerIdForDetails,
						},
					};
				}

				case "remove": {
					if (!params.taskId) {
						return err("Error: taskId is required", "taskId required");
					}
					const nodes = containerNodes(plan, container);
					const idx = nodes.findIndex(
						(n) =>
							isWorkItem(n) && matchWorkItemId(n.id, params.taskId as string),
					);
					if (idx < 0) {
						return err(
							`Work item \`${params.taskId}\` not found`,
							"task not found",
						);
					}
					const [removed] = nodes.splice(idx, 1);
					stampContainer(container, plan);
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{ type: "text", text: `Removed work item \`${removed.id}\`` },
						],
						details: {
							action: "remove",
							task: removed,
							phaseId: containerIdForDetails,
						},
					};
				}

				case "move": {
					if (!params.taskId || !params.targetPhaseId) {
						return err(
							"Error: taskId and targetPhaseId are required",
							"taskId and targetPhaseId required",
						);
					}
					const targetContainer = resolveItemContainer(
						plan,
						params.targetPhaseId,
					);
					if ("error" in targetContainer) {
						return err(
							`Target deliverable \`${params.targetPhaseId}\` not found`,
							"target deliverable not found",
						);
					}
					const nodes = containerNodes(plan, container);
					const idx = nodes.findIndex(
						(n) =>
							isWorkItem(n) && matchWorkItemId(n.id, params.taskId as string),
					);
					if (idx < 0) {
						return err(
							`Work item \`${params.taskId}\` not found`,
							"task not found",
						);
					}
					const item = nodes[idx] as WorkItem;
					if (
						targetContainer.kind === "plan" &&
						effectiveWorkItemKind(item) === "task"
					) {
						return err(
							"Plan-level loose items can't be gating `task` items — " +
								"change its kind first.",
							"plan-level task forbidden",
						);
					}
					if (
						targetContainer.kind === "deliverable" &&
						effectiveWorkItemKind(item) === "task" &&
						childDeliverables(targetContainer.deliverable).length > 0
					) {
						return err(
							`Deliverable \`${targetContainer.deliverable.id}\` is a ` +
								"grouping — gating tasks belong on its children.",
							"gating xor violated",
						);
					}
					nodes.splice(idx, 1);
					const targetNodes = containerNodes(plan, targetContainer);
					if (
						params.position !== undefined &&
						params.position >= 0 &&
						params.position <= targetNodes.length
					) {
						targetNodes.splice(params.position, 0, item);
					} else {
						targetNodes.push(item);
					}
					item.updatedAt = nowIso();
					stampContainer(container, plan);
					stampContainer(targetContainer, plan);
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					const targetIdForDetails =
						targetContainer.kind === "deliverable"
							? targetContainer.deliverable.id
							: PLAN_SENTINEL;
					return {
						content: [
							{
								type: "text",
								text: `Moved \`${item.id}\` from ${container.label} to ${targetContainer.label}`,
							},
						],
						details: {
							action: "move",
							task: item,
							fromPhaseId: containerIdForDetails,
							toPhaseId: targetIdForDetails,
						},
					};
				}
			}
		},
	});

	// ---- plan ---------------------------------------------------------

	pi.registerTool({
		name: "plan",
		label: "Plan",
		description:
			"Show a markdown summary of the current plan: deliverables (nested), " +
			"work items, and statuses. Read-only.",
		promptSnippet: "Show the current plan",
		promptGuidelines: [
			"Use plan to recall the plan structure when you've lost context.",
		],
		parameters: Type.Object({}),

		async execute(): Promise<Result> {
			const slug = hooks.getCurrentPlanSlug();
			const planOrError = loadOrError(slug);
			if (typeof planOrError === "string") {
				return err(planOrError);
			}
			return {
				content: [{ type: "text", text: planSummaryMarkdown(planOrError) }],
				details: { plan: planOrError },
			};
		},
	});
}

/** Exposed for tests. */
export const _testing = { planSummaryMarkdown };
