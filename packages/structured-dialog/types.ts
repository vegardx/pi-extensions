/**
 * Generic types for the structured-dialog component. Domain-agnostic —
 * callers map their domain objects (findings, questions, etc.) into
 * these shapes before handing them to the dialog.
 */

/** A single option the user can pick for an item. */
export interface DialogOption {
	/** Machine-readable key returned in the result. */
	value: string;
	/** Human-readable label shown in the picker. */
	label: string;
	/** Optional short description rendered below the label. */
	description?: string;
	/**
	 * Advantages of this option — rendered in success colour in the
	 * right-pane when the option is highlighted.
	 */
	pros?: string[];
	/**
	 * Disadvantages of this option — rendered in warning colour in the
	 * right-pane when the option is highlighted.
	 */
	cons?: string[];
	/**
	 * Per-option preview pane content. Takes priority over the item-level
	 * `DialogItem.preview` when the option is highlighted.
	 */
	preview?: DialogPreview;
}

/**
 * A preview block shown alongside an item. Can be a code snippet
 * (with optional syntax highlighting hint), markdown, or plain text.
 */
export interface DialogPreview {
	kind: "code" | "markdown" | "text";
	content: string;
	/** For `kind: "code"` — language hint for syntax highlighting. */
	language?: string;
	/** Optional title shown above the preview pane. */
	title?: string;
}

/** A single item in the dialog — one tab. */
export interface DialogItem {
	/** Unique identifier for this item. */
	id: string;
	/** Short label shown in the tab bar. */
	label: string;
	/** Full description/prompt shown when this tab is active. */
	prompt: string;
	/**
	 * Available actions the user can pick. Can be empty when only a
	 * text input is used.
	 */
	options: DialogOption[];
	/** Optional preview pane content. */
	preview?: DialogPreview;
	/** Optional metadata rendered below the prompt (key-value pairs). */
	metadata?: Array<{ key: string; value: string }>;
	/**
	 * Optional severity/badge string rendered before the label in the
	 * tab bar (e.g. "CRITICAL", "NOTE"). Purely cosmetic.
	 */
	badge?: string;
	/**
	 * When present, an editable text field is rendered below the options.
	 * Selecting an option pre-fills the text field with the option label.
	 * The text field content becomes `DialogAnswer.text`.
	 */
	textInput?: DialogTextInput;
}

/** Configuration for an always-visible text input field on an item. */
export interface DialogTextInput {
	/** Placeholder shown when the field is empty. */
	placeholder?: string;
	/** Initial text pre-filled into the field. */
	prefill?: string;
}

/** Per-item answer recorded by the user. */
export interface DialogAnswer {
	/** Matches `DialogItem.id`. */
	id: string;
	/** The selected option's `value` (empty string when answered via text only). */
	value: string;
	/** The selected option's `label` (for display). */
	label: string;
	/** Free-text content from the text input field. */
	text?: string;
}

/** The complete result returned when the dialog closes. */
export interface DialogResult {
	/** All items that were presented. */
	items: DialogItem[];
	/** Answers for items the user acted on. */
	answers: DialogAnswer[];
	/** True when the user pressed Escape / cancelled. */
	cancelled: boolean;
}

/** Configuration for the structured dialog. */
export interface StructuredDialogConfig {
	/** Items to present. Each becomes a tab. */
	items: DialogItem[];
	/**
	 * Display mode. Default: "fullscreen".
	 * - "fullscreen": replaces the editor entirely.
	 * - "overlay": renders as a floating modal.
	 */
	mode?: "fullscreen" | "overlay";
	/**
	 * Whether unanswered items block submit. Default: false.
	 * When true, the submit tab shows a warning for skipped items
	 * but still allows submission.
	 */
	requireAll?: boolean;
	/** Title shown at the top of the dialog. */
	title?: string;
}
