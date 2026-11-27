import type { AutocompleteProvider } from "./autocomplete.ts";
import type { Component } from "./tui.ts";

export interface EditorSelectionPoint {
	row: number;
	col: number;
	offset: number;
	boundary?: boolean;
}

export interface EditorSelectionRange {
	start: EditorSelectionPoint;
	end: EditorSelectionPoint;
}

export interface SelectionInputContext {
	start: number;
	end: number;
	generation: number;
}

export interface SelectionInputResult {
	handled: boolean;
	clearSelection?: boolean;
}

export interface SelectionEditComponent {
	getText(): string;
	getClosestSelectionPoint(row: number, column: number): EditorSelectionPoint & { endOffset: number };
	getSelectionContentStart(row: number): number | undefined;
	getSelectionContentEnd(row: number): number | undefined;
	getSelectionText(start: number, end: number): string;
	deleteSelection(start: number, end: number): boolean;
	moveCursorToOffset(offset: number): void;
	handleSelectionInput?(data: string, selection: SelectionInputContext): SelectionInputResult;
	getSelectionPointForOffset?(offset: number, affinity: "forward" | "backward"): EditorSelectionPoint | undefined;
	getSelectionNewlineOffset?(row: number): number | undefined;
	getLineSelection?(row: number): EditorSelectionRange | undefined;
	getSelectAllSelection?(): EditorSelectionRange | undefined;
}

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// =========================================================================

	/** Get the current text content */
	getText(): string;

	/** Set the text content */
	setText(text: string): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	// =========================================================================
	// Callbacks (required)
	// =========================================================================

	/** Called when user submits (e.g., Enter key) */
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	// =========================================================================
	// History support (optional)
	// =========================================================================

	/** Add text to history for up/down navigation */
	addToHistory?(text: string): void;

	// =========================================================================
	// Advanced text manipulation (optional)
	// =========================================================================

	/** Insert text at current cursor position */
	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	// =========================================================================
	// Autocomplete support (optional)
	// =========================================================================

	/** Set the autocomplete provider */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// =========================================================================
	// Appearance (optional)
	// =========================================================================

	/** Border color function */
	borderColor?: (str: string) => string;

	/** Set horizontal padding */
	setPaddingX?(padding: number): void;

	/** Set max visible items in autocomplete dropdown */
	setAutocompleteMaxVisible?(maxVisible: number): void;
}
