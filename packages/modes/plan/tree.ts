/**
 * Forest helpers over the v3 node model. `deliverables(plan)` (the
 * preorder flatten, defined in schema.ts next to the types) is the
 * drop-in replacement for the old `plan.phases` array; everything
 * else here is navigation and completion logic that only the tree
 * shape needs.
 */

import {
	childDeliverables,
	type Deliverable,
	deliverables,
	effectiveWorkItemKind,
	gatingTasks,
	isDeliverable,
	isGrouping,
	isWorkItem,
	ownWorkItems,
	type Plan,
	type PlanNode,
	shipsPR,
	type WorkItem,
} from "./schema.js";

export {
	childDeliverables,
	deliverables,
	gatingTasks,
	isDeliverable,
	isGrouping,
	isWorkItem,
	ownWorkItems,
	shipsPR,
};

/** Depth-first preorder walk over every node (deliverables and items). */
export function walk(
	plan: Pick<Plan, "nodes">,
	visit: (node: PlanNode, parent: Deliverable | null, depth: number) => void,
): void {
	const go = (
		nodes: readonly PlanNode[],
		parent: Deliverable | null,
		depth: number,
	): void => {
		for (const node of nodes) {
			visit(node, parent, depth);
			if (isDeliverable(node)) go(node.children, node, depth + 1);
		}
	};
	go(plan.nodes, null, 0);
}

/** Find any node (deliverable or work-item) by id, anywhere. */
export function findNode(
	plan: Pick<Plan, "nodes">,
	id: string,
): PlanNode | null {
	let found: PlanNode | null = null;
	walk(plan, (node) => {
		if (!found && node.id === id) found = node;
	});
	return found;
}

/** Find a deliverable by id, anywhere in the forest. */
export function findDeliverable(
	plan: Pick<Plan, "nodes">,
	id: string,
): Deliverable | null {
	return deliverables(plan).find((d) => d.id === id) ?? null;
}

/**
 * Containing deliverable of a node, or `null` for top-level nodes.
 */
export function parentOf(
	plan: Pick<Plan, "nodes">,
	id: string,
): Deliverable | null {
	let found: Deliverable | null = null;
	walk(plan, (node, parent) => {
		if (!found && node.id === id) found = parent;
	});
	return found;
}

/**
 * Top-level loose work-items (the old plan-level followUps). Never
 * gating; surfaced on the /park tracking issue.
 */
export function topLevelLeaves(plan: Pick<Plan, "nodes">): WorkItem[] {
	return plan.nodes.filter(isWorkItem);
}

/**
 * Is a deliverable's subtree complete?
 *
 *   - A PR-shipping leaf is complete when its status is terminal
 *     (`shipped`; `abandoned` also stops gating).
 *   - A grouping is complete when every child deliverable's subtree
 *     is complete.
 *   - Lifecycle checklists are complete when every own work-item is
 *     done.
 *   - A leaf with no gating tasks (notes-only) never gates: complete.
 */
export function subtreeComplete(d: Deliverable): boolean {
	if (d.lifecycle) {
		return ownWorkItems(d).every((t) => t.done);
	}
	if (isGrouping(d)) {
		return childDeliverables(d).every(subtreeComplete);
	}
	if (gatingTasks(d).length === 0) return true;
	return d.status === "shipped" || d.status === "abandoned";
}

/**
 * Unanswered question items anywhere in the forest (including loose
 * leaves). Used to surface pending decisions on user return.
 */
export function unansweredQuestions(
	plan: Pick<Plan, "nodes">,
): Array<{ item: WorkItem; parent: Deliverable | null }> {
	const out: Array<{ item: WorkItem; parent: Deliverable | null }> = [];
	walk(plan, (node, parent) => {
		if (
			isWorkItem(node) &&
			effectiveWorkItemKind(node) === "question" &&
			!node.done &&
			node.answer === undefined
		) {
			out.push({ item: node, parent });
		}
	});
	return out;
}
