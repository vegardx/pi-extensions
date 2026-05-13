/**
 * Tool registrations for the phase/task plan system.
 *
 * Three tools:
 *   - plan_phase: manage phases (add/update/remove/reorder/list)
 *   - plan_task:  manage tasks (add/update/toggle/remove/move)
 *   - plan_view:  read-only markdown summary
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
	defaultBranchForPhase,
	effectiveTaskKind,
	matchPhaseId,
	matchTaskId,
	PHASE_STATUSES,
	type Phase,
	type PhaseStatus,
	type Plan,
	phaseId,
	TASK_KINDS,
	type Task,
	type TaskKind,
	taskId,
} from "./schema.js";
import { loadPlan, savePlan } from "./storage.js";

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

function taskBullet(task: Task): string {
	const kind = effectiveTaskKind(task);
	if (kind === "deliverable") {
		return `- [${task.done ? "x" : " "}] **${task.title}** \`${task.id}\``;
	}
	const marker =
		kind === "question" ? "[?]" : kind === "manual" ? "[!]" : "[~]";
	return `- ${marker} **${task.title}** \`${task.id}\` _(${kind})_`;
}

function renderTaskBlock(lines: string[], tasks: Task[]): void {
	for (const t of tasks) {
		lines.push(taskBullet(t));
		if (t.body) {
			const indented = t.body
				.split("\n")
				.map((l) => `  ${l}`)
				.join("\n");
			lines.push(indented);
		}
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
	if (plan.phases.length === 0) {
		lines.push("_No phases yet._");
	} else {
		for (const phase of plan.phases) {
			const issueRef = phase.issueNumber ? ` \u2014 #${phase.issueNumber}` : "";
			const driverRef = phase.driverSessionId
				? ` \u2014 driver: \`${phase.driverSessionId.slice(0, 8)}\``
				: "";
			lines.push(
				`## ${phase.title} \`${phase.id}\` [${phase.status}]${issueRef}${driverRef}`,
			);
			if (phase.dependsOn && phase.dependsOn.length > 0) {
				lines.push("");
				lines.push(
					`depends on: ${phase.dependsOn.map((d) => `\`${d}\``).join(", ")}`,
				);
			}
			if (phase.goal) {
				lines.push("");
				lines.push(`> ${phase.goal}`);
			}
			if (phase.tasks.length > 0) {
				lines.push("");
				renderTaskBlock(lines, phase.tasks);
			}
			lines.push("");
		}
	}
	const followUps = plan.followUps ?? [];
	if (followUps.length > 0) {
		lines.push("## Follow-ups");
		lines.push("");
		renderTaskBlock(lines, followUps);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function findPhase(plan: Plan, id: string): Phase | undefined {
	return plan.phases.find((p) => matchPhaseId(p.id, id));
}

function findPhaseIndex(plan: Plan, id: string): number {
	return plan.phases.findIndex((p) => matchPhaseId(p.id, id));
}

/**
 * Where a task lives — either inside a specific phase, or at the
 * plan's standalone follow-ups list (sentinel `phaseId === "@plan"`).
 *
 * Returning a discriminated container rather than
 * `{ phase, tasks }` keeps callsites honest about which surface they
 * are mutating; "@plan" has no Phase to stamp `updatedAt` on.
 */
type TaskContainer =
	| { kind: "phase"; phase: Phase; tasks: Task[]; label: string }
	| { kind: "plan"; tasks: Task[]; label: string };

const PLAN_FOLLOWUPS_SENTINEL = "@plan";

function resolveTaskContainer(
	plan: Plan,
	phaseIdParam: string,
): TaskContainer | { error: string } {
	if (phaseIdParam === PLAN_FOLLOWUPS_SENTINEL) {
		if (!plan.followUps) plan.followUps = [];
		return {
			kind: "plan",
			tasks: plan.followUps,
			label: "plan follow-ups",
		};
	}
	const phase = findPhase(plan, phaseIdParam);
	if (!phase) return { error: `Phase \`${phaseIdParam}\` not found` };
	return {
		kind: "phase",
		phase,
		tasks: phase.tasks,
		label: `phase \`${phase.id}\``,
	};
}

function stampContainer(container: TaskContainer, plan: Plan): void {
	const now = nowIso();
	if (container.kind === "phase") {
		container.phase.updatedAt = now;
	}
	plan.updatedAt = now;
}

/**
 * Validate a `dependsOn` candidate for a phase. Returns null if
 * valid, or a user-facing error string. Enforces:
 *
 *   - at most one parent (chain-only constraint);
 *   - no self-references;
 *   - all referenced ids exist in the plan;
 *   - no cycles when applying this `dependsOn` to the named phase.
 */
function validateDependsOn(
	plan: Plan,
	phaseIdSelf: string,
	dependsOn: string[],
): string | null {
	if (dependsOn.length > 1) {
		return (
			`Phase \`${phaseIdSelf}\` cannot depend on multiple phases ` +
			`(${dependsOn.map((d) => `\`${d}\``).join(", ")}). ` +
			"Compaction summaries carry forward through a chain; chain them " +
			"as `B \u2192 C \u2192 D` instead of `{B, C} \u2192 D`."
		);
	}
	for (const dep of dependsOn) {
		if (matchPhaseId(dep, phaseIdSelf)) {
			return `Phase \`${phaseIdSelf}\` cannot depend on itself`;
		}
		const found = findPhase(plan, dep);
		if (!found) {
			return `dependsOn references unknown phase \`${dep}\``;
		}
	}
	if (detectCycle(plan, phaseIdSelf, dependsOn)) {
		return `dependsOn would create a cycle through \`${phaseIdSelf}\``;
	}
	return null;
}

/**
 * Walks the dependency graph as it would look if `phaseIdSelf`'s
 * `dependsOn` were `candidate`. Returns true if reaching `phaseIdSelf`
 * from any of its (proposed) ancestors would close a loop.
 *
 * Implemented as a DFS from each candidate parent following each
 * phase's already-stored `dependsOn`. Self-reference is checked by
 * the caller; here we only walk transitive edges.
 */
function detectCycle(
	plan: Plan,
	phaseIdSelf: string,
	candidate: string[],
): boolean {
	const seen = new Set<string>();
	const stack = [...candidate];
	while (stack.length > 0) {
		const id = stack.pop();
		if (!id) continue;
		if (matchPhaseId(id, phaseIdSelf)) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		const phase = findPhase(plan, id);
		if (!phase) continue;
		for (const dep of phase.dependsOn ?? []) stack.push(dep);
	}
	return false;
}

/**
 * Resolve user-supplied dependsOn ids to their canonical (stored)
 * form so legacy `p-` prefixed inputs end up matching the actual
 * phase id on disk.
 */
function canonicaliseDependsOn(plan: Plan, ids: string[]): string[] {
	const out: string[] = [];
	for (const id of ids) {
		const found = findPhase(plan, id);
		out.push(found ? found.id : id);
	}
	return out;
}

export function registerPlanTools(
	pi: ExtensionAPI,
	hooks: PlanToolHooks,
): void {
	// ---- plan_phase ------------------------------------------------------

	pi.registerTool({
		name: "plan_phase",
		label: "Plan Phase",
		description:
			"Manage phases of the current plan. A phase is a unit of work that " +
			"ships as one PR / one issue. Actions: add, update, remove, reorder, list.",
		promptSnippet: "Add, update, remove, reorder, or list phases",
		promptGuidelines: [
			"Use plan_phase to structure the plan into phases. Each phase is a " +
				"self-contained unit that ships as one PR.",
			"A phase has a short title, a one-line goal, and a list of tasks. " +
				"Use plan_task to add tasks to a phase.",
			"Phases form a chain via `dependsOn` (at most one parent per phase). " +
				"`phases[]` order is cosmetic. On `add`, `dependsOn` defaults to " +
				"the last phase in the plan (linear chain). Pass `dependsOn` " +
				"explicitly to fork (`['<earlierPhaseId>']`) or to declare a new " +
				"root (`[]`). Independent chains can ship in parallel.",
			"Status transitions are gated by the state machine. The agent should " +
				"normally not set status directly \u2014 modes' /implement, /ship, and " +
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
					description: "Phase id (required for update/remove/reorder)",
				}),
			),
			title: Type.Optional(Type.String({ description: "Phase title" })),
			goal: Type.Optional(
				Type.String({
					description: "1-line goal \u2014 what ships when this merges",
				}),
			),
			status: Type.Optional(
				Type.Union(PHASE_STATUSES.map((s) => Type.Literal(s))),
			),
			dependsOn: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Phase ids this phase depends on. At most one parent. " +
						"On `add`, omitting this defaults to chaining off the " +
						"last existing phase (linear plans). Pass `[]` explicitly " +
						"to declare a chain root (e.g. a sibling chain in a forest).",
				}),
			),
			position: Type.Optional(
				Type.Number({ description: "0-indexed position (for reorder/add)" }),
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
				return {
					content: [{ type: "text", text: planOrError }],
					details: { error: planOrError },
				};
			}
			const plan = planOrError;

			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text:
									plan.phases.length === 0
										? "No phases yet"
										: plan.phases
												.map(
													(p, i) =>
														`${i + 1}. \`${p.id}\` [${p.status}] ${p.title}`,
												)
												.join("\n"),
							},
						],
						details: { action: "list", phases: plan.phases },
					};

				case "add": {
					if (!params.title) {
						return {
							content: [{ type: "text", text: "Error: title is required" }],
							details: { error: "title required" },
						};
					}
					const id = phaseId(params.title);
					if (findPhase(plan, id)) {
						return {
							content: [
								{
									type: "text",
									text: `Phase \`${id}\` already exists \u2014 pick a different title`,
								},
							],
							details: { error: "duplicate phase id" },
						};
					}
					const dependsOn = canonicaliseDependsOn(
						plan,
						// Ergonomic default: chain new phases off the last existing
						// phase. Plans are linear by default; if the user wants a
						// fork, they pass `dependsOn` explicitly. Empty plans get
						// `[]` (root). An explicit `dependsOn: []` overrides the
						// default (allows declaring a sibling root in a forest).
						params.dependsOn ??
							(plan.phases.length > 0
								? [plan.phases[plan.phases.length - 1].id]
								: []),
					);
					const depErr = validateDependsOn(plan, id, dependsOn);
					if (depErr) {
						return {
							content: [{ type: "text", text: depErr }],
							details: { error: depErr },
						};
					}
					const phase: Phase = {
						id,
						title: params.title,
						goal: params.goal ?? "",
						status: "planned",
						branch: defaultBranchForPhase({ id }),
						dependsOn,
						tasks: [],
						createdAt: nowIso(),
						updatedAt: nowIso(),
					};
					if (
						params.position !== undefined &&
						params.position >= 0 &&
						params.position <= plan.phases.length
					) {
						plan.phases.splice(params.position, 0, phase);
					} else {
						plan.phases.push(phase);
					}
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{ type: "text", text: `Added phase \`${id}\`: ${phase.title}` },
						],
						details: { action: "add", phase },
					};
				}

				case "update": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id is required" }],
							details: { error: "id required" },
						};
					}
					const phase = findPhase(plan, params.id);
					if (!phase) {
						return {
							content: [
								{ type: "text", text: `Phase \`${params.id}\` not found` },
							],
							details: { error: "phase not found" },
						};
					}
					if (params.title !== undefined) phase.title = params.title;
					if (params.goal !== undefined) phase.goal = params.goal;
					if (params.dependsOn !== undefined) {
						const dependsOn = canonicaliseDependsOn(plan, params.dependsOn);
						const depErr = validateDependsOn(plan, phase.id, dependsOn);
						if (depErr) {
							return {
								content: [{ type: "text", text: depErr }],
								details: { error: depErr },
							};
						}
						phase.dependsOn = dependsOn;
					}
					if (params.status !== undefined) {
						if (!canTransition(phase.status, params.status as PhaseStatus)) {
							return {
								content: [
									{
										type: "text",
										text: `Cannot transition \`${phase.id}\` from \`${phase.status}\` to \`${params.status}\``,
									},
								],
								details: { error: "invalid transition" },
							};
						}
						phase.status = params.status as PhaseStatus;
					}
					phase.updatedAt = nowIso();
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [{ type: "text", text: `Updated phase \`${phase.id}\`` }],
						details: { action: "update", phase },
					};
				}

				case "remove": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id is required" }],
							details: { error: "id required" },
						};
					}
					const idx = findPhaseIndex(plan, params.id);
					if (idx < 0) {
						return {
							content: [
								{ type: "text", text: `Phase \`${params.id}\` not found` },
							],
							details: { error: "phase not found" },
						};
					}
					const [removed] = plan.phases.splice(idx, 1);
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{ type: "text", text: `Removed phase \`${removed.id}\`` },
						],
						details: { action: "remove", phase: removed },
					};
				}

				case "reorder": {
					if (!params.id || params.position === undefined) {
						return {
							content: [
								{ type: "text", text: "Error: id and position are required" },
							],
							details: { error: "id and position required" },
						};
					}
					const idx = findPhaseIndex(plan, params.id);
					if (idx < 0) {
						return {
							content: [
								{ type: "text", text: `Phase \`${params.id}\` not found` },
							],
							details: { error: "phase not found" },
						};
					}
					const [phase] = plan.phases.splice(idx, 1);
					const target = Math.max(
						0,
						Math.min(params.position, plan.phases.length),
					);
					plan.phases.splice(target, 0, phase);
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{
								type: "text",
								text: `Moved phase \`${phase.id}\` to position ${target}`,
							},
						],
						details: { action: "reorder", phase },
					};
				}
			}
		},
	});

	// ---- plan_task -------------------------------------------------------

	pi.registerTool({
		name: "plan_task",
		label: "Plan Task",
		description:
			"Manage tasks within a phase. A task is a concrete work item with " +
			"a short title and detailed body (acceptance criteria, files, tests). " +
			"Pass `phaseId='@plan'` to manage plan-level follow-ups instead of a " +
			"specific phase. Actions: add, update, toggle, remove, move.",
		promptSnippet: "Add, update, toggle, remove, or move tasks",
		promptGuidelines: [
			"Use plan_task to add detail to a phase. The title is short (scannable); " +
				"put context, acceptance criteria, files, and test notes in `body`.",
			"Set `kind` when adding a task. `deliverable` (default) gates phase " +
				"completion. `followUp`, `question`, and `manual` are informational " +
				"\u2014 they surface in PR/issue bodies but never block /ship.",
			"Pass `phaseId='@plan'` to attach a follow-up to the plan itself; " +
				"these surface on the parent /park issue.",
			"During implementation, call plan_task(toggle, taskId) to mark each task done.",
			"To move a task between phases (or to/from `@plan`), use action='move' " +
				"with targetPhaseId.",
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
				description: "Phase id, or `@plan` for plan-level follow-ups",
			}),
			taskId: Type.Optional(
				Type.String({
					description: "Task id (required for update/toggle/remove/move)",
				}),
			),
			title: Type.Optional(Type.String({ description: "Task title" })),
			body: Type.Optional(
				Type.String({
					description:
						"Task body \u2014 context, acceptance criteria, files, tests",
				}),
			),
			kind: Type.Optional(
				Type.Union(
					TASK_KINDS.map((k) => Type.Literal(k)),
					{
						description:
							"Task kind. `deliverable` (default) gates phase completion; " +
							"`followUp`/`question`/`manual` are informational.",
					},
				),
			),
			targetPhaseId: Type.Optional(
				Type.String({
					description:
						"Destination phase (for move). `@plan` moves to plan-level follow-ups.",
				}),
			),
			position: Type.Optional(
				Type.Number({ description: "0-indexed position within phase" }),
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
				return {
					content: [{ type: "text", text: planOrError }],
					details: { error: planOrError },
				};
			}
			const plan = planOrError;
			const container = resolveTaskContainer(plan, params.phaseId);
			if ("error" in container) {
				return {
					content: [{ type: "text", text: container.error }],
					details: { error: "phase not found" },
				};
			}
			const containerIdForDetails =
				container.kind === "phase"
					? container.phase.id
					: PLAN_FOLLOWUPS_SENTINEL;

			switch (params.action) {
				case "add": {
					if (!params.title) {
						return {
							content: [{ type: "text", text: "Error: title is required" }],
							details: { error: "title required" },
						};
					}
					const id = taskId(params.title);
					if (container.tasks.some((t) => matchTaskId(t.id, id))) {
						return {
							content: [
								{
									type: "text",
									text: `Task \`${id}\` already exists in ${container.label}`,
								},
							],
							details: { error: "duplicate task id" },
						};
					}
					const task: Task = {
						id,
						title: params.title,
						body: params.body ?? "",
						done: false,
						kind: (params.kind as TaskKind | undefined) ?? "deliverable",
						createdAt: nowIso(),
						updatedAt: nowIso(),
					};
					if (
						params.position !== undefined &&
						params.position >= 0 &&
						params.position <= container.tasks.length
					) {
						container.tasks.splice(params.position, 0, task);
					} else {
						container.tasks.push(task);
					}
					stampContainer(container, plan);
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{
								type: "text",
								text: `Added task \`${task.id}\` to ${container.label}`,
							},
						],
						details: {
							action: "add",
							task,
							phaseId: containerIdForDetails,
						},
					};
				}

				case "update": {
					if (!params.taskId) {
						return {
							content: [{ type: "text", text: "Error: taskId is required" }],
							details: { error: "taskId required" },
						};
					}
					const task = container.tasks.find((t) =>
						matchTaskId(t.id, params.taskId as string),
					);
					if (!task) {
						return {
							content: [
								{
									type: "text",
									text: `Task \`${params.taskId}\` not found in ${container.label}`,
								},
							],
							details: { error: "task not found" },
						};
					}
					if (params.title !== undefined) task.title = params.title;
					if (params.body !== undefined) task.body = params.body;
					if (params.kind !== undefined) task.kind = params.kind as TaskKind;
					task.updatedAt = nowIso();
					stampContainer(container, plan);
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [{ type: "text", text: `Updated task \`${task.id}\`` }],
						details: {
							action: "update",
							task,
							phaseId: containerIdForDetails,
						},
					};
				}

				case "toggle": {
					if (!params.taskId) {
						return {
							content: [{ type: "text", text: "Error: taskId is required" }],
							details: { error: "taskId required" },
						};
					}
					const task = container.tasks.find((t) =>
						matchTaskId(t.id, params.taskId as string),
					);
					if (!task) {
						return {
							content: [
								{
									type: "text",
									text: `Task \`${params.taskId}\` not found`,
								},
							],
							details: { error: "task not found" },
						};
					}
					task.done = !task.done;
					task.updatedAt = nowIso();
					stampContainer(container, plan);
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [
							{
								type: "text",
								text: `${task.done ? "\u2713" : "\u25cb"} \`${task.id}\``,
							},
						],
						details: {
							action: "toggle",
							task,
							phaseId: containerIdForDetails,
						},
					};
				}

				case "remove": {
					if (!params.taskId) {
						return {
							content: [{ type: "text", text: "Error: taskId is required" }],
							details: { error: "taskId required" },
						};
					}
					const idx = container.tasks.findIndex((t) =>
						matchTaskId(t.id, params.taskId as string),
					);
					if (idx < 0) {
						return {
							content: [
								{
									type: "text",
									text: `Task \`${params.taskId}\` not found`,
								},
							],
							details: { error: "task not found" },
						};
					}
					const [removed] = container.tasks.splice(idx, 1);
					stampContainer(container, plan);
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					return {
						content: [{ type: "text", text: `Removed task \`${removed.id}\`` }],
						details: {
							action: "remove",
							task: removed,
							phaseId: containerIdForDetails,
						},
					};
				}

				case "move": {
					if (!params.taskId || !params.targetPhaseId) {
						return {
							content: [
								{
									type: "text",
									text: "Error: taskId and targetPhaseId are required",
								},
							],
							details: { error: "taskId and targetPhaseId required" },
						};
					}
					const targetContainer = resolveTaskContainer(
						plan,
						params.targetPhaseId,
					);
					if ("error" in targetContainer) {
						return {
							content: [
								{
									type: "text",
									text: `Target phase \`${params.targetPhaseId}\` not found`,
								},
							],
							details: { error: "target phase not found" },
						};
					}
					const idx = container.tasks.findIndex((t) =>
						matchTaskId(t.id, params.taskId as string),
					);
					if (idx < 0) {
						return {
							content: [
								{
									type: "text",
									text: `Task \`${params.taskId}\` not found`,
								},
							],
							details: { error: "task not found" },
						};
					}
					const [task] = container.tasks.splice(idx, 1);
					if (
						params.position !== undefined &&
						params.position >= 0 &&
						params.position <= targetContainer.tasks.length
					) {
						targetContainer.tasks.splice(params.position, 0, task);
					} else {
						targetContainer.tasks.push(task);
					}
					task.updatedAt = nowIso();
					stampContainer(container, plan);
					stampContainer(targetContainer, plan);
					savePlan(plan);
					hooks.onPlanChanged(plan, ctx);
					const targetIdForDetails =
						targetContainer.kind === "phase"
							? targetContainer.phase.id
							: PLAN_FOLLOWUPS_SENTINEL;
					return {
						content: [
							{
								type: "text",
								text: `Moved \`${task.id}\` from ${container.label} to ${targetContainer.label}`,
							},
						],
						details: {
							action: "move",
							task,
							fromPhaseId: containerIdForDetails,
							toPhaseId: targetIdForDetails,
						},
					};
				}
			}
		},
	});

	// ---- plan_view -------------------------------------------------------

	pi.registerTool({
		name: "plan_view",
		label: "Plan View",
		description:
			"Show a markdown summary of the current plan: phases, tasks, and " +
			"statuses. Read-only.",
		promptSnippet: "Show the current plan",
		promptGuidelines: [
			"Use plan_view to recall the plan structure when you've lost context.",
		],
		parameters: Type.Object({}),

		async execute(): Promise<Result> {
			const slug = hooks.getCurrentPlanSlug();
			const planOrError = loadOrError(slug);
			if (typeof planOrError === "string") {
				return {
					content: [{ type: "text", text: planOrError }],
					details: { error: planOrError },
				};
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
