import { PlanPanelComponent } from "../plan/panel.js";
import {
	type NavInputResult,
	type NavTui,
	PanelNavController,
} from "../plan/panel-nav.js";
import type { Phase, PhaseStatus, Plan } from "../plan/schema.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as ConstructorParameters<typeof PlanPanelComponent>[0]["theme"];

const KEY = { up: "\x1b[A", down: "\x1b[B", escape: "\x1b" };
const CTRL_C = "\x03";

function makePhase(title: string, status: PhaseStatus): Phase {
	return {
		id: title.toLowerCase(),
		title,
		goal: "",
		status,
		branch: `feat/${title.toLowerCase()}`,
		tasks: [],
		dependsOn: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function makePlan(phases: Phase[]): Plan {
	return {
		slug: "test-plan",
		title: "Test plan",
		repo: { path: "/tmp/test" },
		schemaVersion: 3,
		phases,
		followUps: [],
		seenIn: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

/** Records keystrokes that reach it, standing in for the core editor. */
class FakeEditor {
	readonly keys: string[] = [];
	handleInput(data: string): void {
		this.keys.push(data);
	}
}

/**
 * Mirrors the host TUI's input dispatch: input listeners run first and a
 * `consume` short-circuits delivery; otherwise input falls through to the
 * focused component. Critically, `focusedComponent` is the *only* sink — if it
 * were ever left null (the old freeze), `dispatch` would drop every key.
 */
class FakeTui implements NavTui {
	readonly terminal: { columns: number };
	focusedComponent: FakeEditor | null;
	private readonly listeners = new Set<(data: string) => NavInputResult>();

	constructor(columns: number, focused: FakeEditor) {
		this.terminal = { columns };
		this.focusedComponent = focused;
	}

	addInputListener(listener: (data: string) => NavInputResult): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	dispatch(data: string): void {
		let current = data;
		for (const listener of this.listeners) {
			const result = listener(current);
			if (result?.consume) return;
			if (result?.data !== undefined) current = result.data;
		}
		if (current.length === 0) return;
		this.focusedComponent?.handleInput(current);
	}
}

function setup(columns = 120) {
	const plan = makePlan([
		makePhase("A", "planned"),
		makePhase("B", "planned"),
		makePhase("C", "planned"),
	]);
	const editor = new FakeEditor();
	const tui = new FakeTui(columns, editor);
	let controller: PanelNavController;
	const panel = new PlanPanelComponent({
		plan,
		theme,
		requestRender: () => {},
		onRequestUnfocus: () => controller.release(),
	});
	panel.setViewportHeight(40);
	panel.render(40);
	controller = new PanelNavController({
		getPanel: () => panel,
		getTui: () => tui,
		minCols: 100,
	});
	return { controller, panel, tui, editor };
}

describe("PanelNavController", () => {
	it("never leaves the TUI unfocused across a focus → navigate → Esc cycle", () => {
		const { controller, panel, tui, editor } = setup();

		controller.enter();
		expect(controller.active).toBe(true);
		expect(panel.focused).toBe(true);
		expect(tui.listenerCount).toBe(1);
		// Entering navigate mode must not move TUI focus off the editor.
		expect(tui.focusedComponent).toBe(editor);

		// Esc releases; the editor is still the (live, non-null) input sink. This
		// is the regression: the old handle.unfocus() path could restore focus to
		// a null/stale target and freeze the UI.
		tui.dispatch(KEY.escape);
		expect(controller.active).toBe(false);
		expect(panel.focused).toBe(false);
		expect(tui.listenerCount).toBe(0);
		expect(tui.focusedComponent).toBe(editor);

		// Input flows to the editor again after release.
		tui.dispatch("x");
		expect(editor.keys).toContain("x");
	});

	it("routes navigation keys to the panel and swallows them", () => {
		const { controller, panel, tui, editor } = setup();
		controller.enter();

		const start = panel.selectedIndex;
		tui.dispatch(KEY.down);
		expect(panel.selectedIndex).toBe(start + 1);
		// Nav keys are consumed — they must not leak into the editor.
		expect(editor.keys).toEqual([]);
	});

	it("passes Ctrl+C through to the editor instead of swallowing it", () => {
		const { controller, tui, editor } = setup();
		controller.enter();

		tui.dispatch(CTRL_C);
		expect(editor.keys).toContain(CTRL_C);
		// Ctrl+C does not exit navigate mode (only Esc/q does).
		expect(controller.active).toBe(true);
	});

	it("guards against double-install leaking listeners", () => {
		const { controller, tui } = setup();
		controller.enter();
		controller.enter();
		expect(tui.listenerCount).toBe(1);
	});

	it("disposes the listener on release and tolerates repeated release", () => {
		const { controller, tui } = setup();
		controller.enter();
		controller.release();
		controller.release();
		expect(controller.active).toBe(false);
		expect(tui.listenerCount).toBe(0);
	});

	it("does not capture input when the terminal is too narrow to render the panel", () => {
		const { controller, panel, tui } = setup(80);
		controller.enter();
		expect(controller.active).toBe(false);
		expect(panel.focused).toBe(false);
		expect(tui.listenerCount).toBe(0);
	});

	it("toggles in and out of navigate mode", () => {
		const { controller, panel } = setup();
		controller.toggle();
		expect(panel.focused).toBe(true);
		expect(controller.active).toBe(true);
		controller.toggle();
		expect(panel.focused).toBe(false);
		expect(controller.active).toBe(false);
	});
});
