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
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	canTransition,
	defaultBranchForPhase,
	PHASE_STATUSES,
	type Phase,
	type PhaseStatus,
	type Plan,
	phaseId,
	type Task,
	taskId,
} from "./schema.js";
import { loadPlan, savePlan } from "./storage.js";

type Details = Record<string, unknown>;
type Result = AgentToolResult<Details>;

export interface PlanToolHooks {
	/** Returns the active plan's slug, or null if no plan is active. */
	getCurrentPlanSlug(): string | null;
	/** Called after any successful mutation so modes can refresh widgets. */
	onPlanChanged(plan: Plan): void;
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
		return lines.join("\n");
	}
	for (const phase of plan.phases) {
		const issueRef = phase.issueNumber ? ` — #${phase.issueNumber}` : "";
		lines.push(
			`## ${phase.title} \`${phase.id}\` [${phase.status}]${issueRef}`,
		);
		if (phase.goal) {
			lines.push("");
			lines.push(`> ${phase.goal}`);
		}
		if (phase.tasks.length > 0) {
			lines.push("");
			for (const t of phase.tasks) {
				lines.push(`- [${t.done ? "x" : " "}] **${t.title}** \`${t.id}\``);
				if (t.body) {
					const indented = t.body
						.split("\n")
						.map((l) => `  ${l}`)
						.join("\n");
					lines.push(indented);
				}
			}
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function findPhase(plan: Plan, id: string): Phase | undefined {
	return plan.phases.find((p) => p.id === id);
}

function findTask(phase: Phase, id: string): Task | undefined {
	return phase.tasks.find((t) => t.id === id);
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
			"Phases are linear (1 → 2 → 3). Use action='reorder' with position " +
				"to change order.",
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
					description: "Phase id (required for update/remove/reorder)",
				}),
			),
			title: Type.Optional(Type.String({ description: "Phase title" })),
			goal: Type.Optional(
				Type.String({
					description: "1-line goal — what ships when this merges",
				}),
			),
			status: Type.Optional(
				Type.Union(PHASE_STATUSES.map((s) => Type.Literal(s))),
			),
			position: Type.Optional(
				Type.Number({ description: "0-indexed position (for reorder/add)" }),
			),
		}),

		async execute(_toolCallId, params): Promise<Result> {
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
									text: `Phase \`${id}\` already exists — pick a different title`,
								},
							],
							details: { error: "duplicate phase id" },
						};
					}
					const phase: Phase = {
						id,
						title: params.title,
						goal: params.goal ?? "",
						status: "planned",
						branch: defaultBranchForPhase({ id }),
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
					hooks.onPlanChanged(plan);
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
					hooks.onPlanChanged(plan);
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
					const idx = plan.phases.findIndex((p) => p.id === params.id);
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
					hooks.onPlanChanged(plan);
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
					const idx = plan.phases.findIndex((p) => p.id === params.id);
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
					hooks.onPlanChanged(plan);
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
			"Actions: add, update, toggle, remove, move.",
		promptSnippet: "Add, update, toggle, remove, or move tasks",
		promptGuidelines: [
			"Use plan_task to add detail to a phase. The title is short (scannable); " +
				"put context, acceptance criteria, files, and test notes in `body`.",
			"During implementation, call plan_task(toggle, taskId) to mark each task done.",
			"To move a task between phases, use action='move' with targetPhaseId.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("add"),
				Type.Literal("update"),
				Type.Literal("toggle"),
				Type.Literal("remove"),
				Type.Literal("move"),
			]),
			phaseId: Type.String({ description: "Phase id" }),
			taskId: Type.Optional(
				Type.String({
					description: "Task id (required for update/toggle/remove/move)",
				}),
			),
			title: Type.Optional(Type.String({ description: "Task title" })),
			body: Type.Optional(
				Type.String({
					description: "Task body — context, acceptance criteria, files, tests",
				}),
			),
			targetPhaseId: Type.Optional(
				Type.String({ description: "Destination phase (for move)" }),
			),
			position: Type.Optional(
				Type.Number({ description: "0-indexed position within phase" }),
			),
		}),

		async execute(_toolCallId, params): Promise<Result> {
			const slug = hooks.getCurrentPlanSlug();
			const planOrError = loadOrError(slug);
			if (typeof planOrError === "string") {
				return {
					content: [{ type: "text", text: planOrError }],
					details: { error: planOrError },
				};
			}
			const plan = planOrError;
			const phase = findPhase(plan, params.phaseId);
			if (!phase) {
				return {
					content: [
						{ type: "text", text: `Phase \`${params.phaseId}\` not found` },
					],
					details: { error: "phase not found" },
				};
			}

			switch (params.action) {
				case "add": {
					if (!params.title) {
						return {
							content: [{ type: "text", text: "Error: title is required" }],
							details: { error: "title required" },
						};
					}
					const id = taskId(params.title);
					if (findTask(phase, id)) {
						return {
							content: [
								{
									type: "text",
									text: `Task \`${id}\` already exists in phase \`${phase.id}\``,
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
						createdAt: nowIso(),
						updatedAt: nowIso(),
					};
					if (
						params.position !== undefined &&
						params.position >= 0 &&
						params.position <= phase.tasks.length
					) {
						phase.tasks.splice(params.position, 0, task);
					} else {
						phase.tasks.push(task);
					}
					phase.updatedAt = nowIso();
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan);
					return {
						content: [
							{
								type: "text",
								text: `Added task \`${task.id}\` to phase \`${phase.id}\``,
							},
						],
						details: { action: "add", task, phaseId: phase.id },
					};
				}

				case "update": {
					if (!params.taskId) {
						return {
							content: [{ type: "text", text: "Error: taskId is required" }],
							details: { error: "taskId required" },
						};
					}
					const task = findTask(phase, params.taskId);
					if (!task) {
						return {
							content: [
								{
									type: "text",
									text: `Task \`${params.taskId}\` not found in phase \`${phase.id}\``,
								},
							],
							details: { error: "task not found" },
						};
					}
					if (params.title !== undefined) task.title = params.title;
					if (params.body !== undefined) task.body = params.body;
					task.updatedAt = nowIso();
					phase.updatedAt = nowIso();
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan);
					return {
						content: [{ type: "text", text: `Updated task \`${task.id}\`` }],
						details: { action: "update", task, phaseId: phase.id },
					};
				}

				case "toggle": {
					if (!params.taskId) {
						return {
							content: [{ type: "text", text: "Error: taskId is required" }],
							details: { error: "taskId required" },
						};
					}
					const task = findTask(phase, params.taskId);
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
					phase.updatedAt = nowIso();
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan);
					return {
						content: [
							{
								type: "text",
								text: `${task.done ? "✓" : "○"} \`${task.id}\``,
							},
						],
						details: { action: "toggle", task, phaseId: phase.id },
					};
				}

				case "remove": {
					if (!params.taskId) {
						return {
							content: [{ type: "text", text: "Error: taskId is required" }],
							details: { error: "taskId required" },
						};
					}
					const idx = phase.tasks.findIndex((t) => t.id === params.taskId);
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
					const [removed] = phase.tasks.splice(idx, 1);
					phase.updatedAt = nowIso();
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan);
					return {
						content: [{ type: "text", text: `Removed task \`${removed.id}\`` }],
						details: { action: "remove", task: removed, phaseId: phase.id },
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
					const target = findPhase(plan, params.targetPhaseId);
					if (!target) {
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
					const idx = phase.tasks.findIndex((t) => t.id === params.taskId);
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
					const [task] = phase.tasks.splice(idx, 1);
					if (
						params.position !== undefined &&
						params.position >= 0 &&
						params.position <= target.tasks.length
					) {
						target.tasks.splice(params.position, 0, task);
					} else {
						target.tasks.push(task);
					}
					task.updatedAt = nowIso();
					phase.updatedAt = nowIso();
					target.updatedAt = nowIso();
					plan.updatedAt = nowIso();
					savePlan(plan);
					hooks.onPlanChanged(plan);
					return {
						content: [
							{
								type: "text",
								text: `Moved \`${task.id}\` from \`${phase.id}\` to \`${target.id}\``,
							},
						],
						details: {
							action: "move",
							task,
							fromPhaseId: phase.id,
							toPhaseId: target.id,
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
