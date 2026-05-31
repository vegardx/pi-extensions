/**
 * Panel "navigate" mode controller.
 *
 * The floating plan panel is always a *non-capturing* overlay, so the editor
 * keeps TUI focus at all times. When the user toggles the panel into navigate
 * mode (Ctrl+Shift+O, or while it's already navigable), keystrokes are routed
 * to the panel via a consuming input listener installed on the TUI — never by
 * moving the TUI's focus onto the overlay.
 *
 * This matters because the host restores overlay focus to the component that
 * was focused at `showOverlay` time, and the TUI delivers *all* input (Ctrl+C
 * included) only to its focused component. If that captured target is stale or
 * null, releasing the panel would leave the TUI with no input sink and freeze
 * the whole UI. Keeping the editor focused the entire time makes that freeze
 * structurally impossible: releasing navigate mode just disposes the listener.
 */

/** Byte the terminal emits for Ctrl+C; passed through so interrupt still works. */
const CTRL_C = "\x03";

/** Result an input listener may return to the host (subset we use). */
export interface NavInputResult {
	consume?: boolean;
	data?: string;
}

/** The slice of the panel component the controller drives. */
export interface NavPanel {
	focused: boolean;
	setFocused(focused: boolean): void;
	handleInput(data: string): void;
}

/** The slice of the TUI the controller needs. */
export interface NavTui {
	terminal: { columns: number };
	addInputListener(listener: (data: string) => NavInputResult): () => void;
}

export interface PanelNavOptions {
	/** Live accessor for the current panel (null when not mounted). */
	getPanel: () => NavPanel | null;
	/** Live accessor for the current TUI (null before the footer mounts). */
	getTui: () => NavTui | null;
	/** Terminal columns below which the panel isn't rendered (don't capture). */
	minCols: number | (() => number);
}

/**
 * Owns the navigate-mode input listener lifecycle. Idempotent: `enter` is a
 * no-op while active or when the panel can't be shown; `release` is a no-op
 * when inactive. The controller never touches TUI focus.
 */
export class PanelNavController {
	private dispose: (() => void) | null = null;

	constructor(private readonly opts: PanelNavOptions) {}

	/** True while a navigate-mode listener is installed. */
	get active(): boolean {
		return this.dispose !== null;
	}

	/**
	 * Enter navigate mode: route keys to the panel and swallow stray input so
	 * it can't leak into the editor (mirrors the old focus-capture semantics).
	 * Ctrl+C is passed through unconsumed. No-op when the panel isn't mounted or
	 * the terminal is too narrow to render it.
	 */
	enter(): void {
		const panel = this.opts.getPanel();
		const tui = this.opts.getTui();
		if (!panel || !tui) return;
		const minCols =
			typeof this.opts.minCols === "function"
				? this.opts.minCols()
				: this.opts.minCols;
		if (tui.terminal.columns < minCols) return;
		// Guard against a double-install leaking the previous listener.
		this.disposeListener();
		panel.setFocused(true);
		this.dispose = tui.addInputListener((data) => {
			if (data === CTRL_C) return {};
			// Esc/q inside the panel triggers onRequestUnfocus → release(), which
			// disposes this listener; the host tolerates removal mid-dispatch.
			panel.handleInput(data);
			return { consume: true };
		});
	}

	/** Leave navigate mode: dispose the listener and drop the render highlight. */
	release(): void {
		this.disposeListener();
		this.opts.getPanel()?.setFocused(false);
	}

	/** Toggle navigate mode based on the panel's current focus state. */
	toggle(): void {
		const panel = this.opts.getPanel();
		if (!panel) return;
		if (panel.focused) this.release();
		else this.enter();
	}

	private disposeListener(): void {
		if (this.dispose) {
			this.dispose();
			this.dispose = null;
		}
	}
}
