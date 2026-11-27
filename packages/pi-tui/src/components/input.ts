import type {
	EditorSelectionPoint,
	EditorSelectionRange,
	SelectionEditComponent,
	SelectionInputContext,
	SelectionInputResult,
} from "../editor-component.ts";
import { getKeybindings } from "../keybindings.ts";
import { decodeTextInput } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import { SelectionInputTransaction } from "../selection-input.ts";
import {
	getSelectionColumnAtOffset,
	getSelectionOffsetsAtColumn,
	getSelectionTextSpans,
	type SelectionAffinity,
} from "../selection-text.ts";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	renderFakeCursor,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import {
	getGraphemeSegmenter,
	isWhitespaceChar,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";

const segmenter = getGraphemeSegmenter();

interface InputState {
	value: string;
	cursor: number;
}

export interface InputOptions {
	prompt?: string;
	placeholder?: string;
	placeholderStyle?: (text: string) => string;
}

/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component, Focusable, SelectionEditComponent {
	private value: string = "";
	private cursor: number = 0; // Cursor position in the value
	private readonly prompt: string;
	private readonly placeholder: string;
	private readonly placeholderStyle: (text: string) => string;
	private renderedStartColumn = 0;
	private renderedStartOffset = 0;
	private renderedContentStart = 0;
	private renderedValue = "";
	public onSubmit?: (value: string) => void;
	public onEscape?: () => void;

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	// Bracketed paste mode buffering
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;
	private readonly selectionInput: SelectionInputTransaction;

	// Kill ring for Emacs-style kill/yank operations
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Undo support
	private undoStack = new UndoStack<InputState>();

	constructor(options: InputOptions = {}) {
		this.prompt = options.prompt ?? "> ";
		this.renderedContentStart = visibleWidth(this.prompt);
		this.placeholder = options.placeholder ?? "";
		this.placeholderStyle = options.placeholderStyle ?? ((text) => text);
		this.selectionInput = new SelectionInputTransaction(
			(data) => this.handleInput(data),
			() => this.isInPaste,
			(start, end) => this.deleteSelection(start, end),
		);
	}

	getValue(): string {
		return this.value;
	}

	getText(): string {
		return this.value;
	}

	getRenderedValueRange(): { start: number; end: number } {
		return { start: this.renderedContentStart, end: this.renderedContentStart + visibleWidth(this.renderedValue) };
	}

	getSelectionContentStart(row: number): number | undefined {
		return row === 0 ? this.renderedContentStart : undefined;
	}

	getSelectionContentEnd(row: number): number | undefined {
		return row === 0 ? this.getRenderedValueRange().end : undefined;
	}

	getSelectionOffsets(row: number, column: number): { start: number; end: number } | undefined {
		if (row !== 0) return undefined;
		const range = this.getRenderedValueRange();
		const targetColumn = Math.max(range.start, Math.min(column, range.end)) - range.start;
		const spans = getSelectionTextSpans(this.renderedValue, segmenter.segment(this.renderedValue));
		const offsets = getSelectionOffsetsAtColumn(spans, targetColumn);
		return {
			start: this.renderedStartOffset + offsets.start,
			end: this.renderedStartOffset + offsets.end,
		};
	}

	getClosestSelectionPoint(row: number, column: number): EditorSelectionPoint & { endOffset: number } {
		const contentStart = this.renderedContentStart;
		const contentEnd = this.getRenderedValueRange().end;
		const before = row < 0;
		const after = row > 0;
		const col = before ? contentStart : after ? contentEnd : Math.max(contentStart, Math.min(column, contentEnd));
		const offsets = this.getSelectionOffsets(0, col) ?? {
			start: this.renderedStartOffset,
			end: this.renderedStartOffset,
		};
		return {
			row: 0,
			col,
			offset: offsets.start,
			endOffset: offsets.end,
			...(after || (!before && column > contentEnd) ? { boundary: true } : {}),
		};
	}

	getSelectionPointForOffset(offset: number, affinity: SelectionAffinity): EditorSelectionPoint | undefined {
		const selectedOffset = Math.max(0, Math.min(offset, this.value.length));
		const start = this.renderedStartOffset;
		const end = start + this.renderedValue.length;
		let col = this.renderedContentStart;
		if (selectedOffset >= end) {
			col = this.getRenderedValueRange().end;
		} else if (selectedOffset > start) {
			const spans = getSelectionTextSpans(this.renderedValue, segmenter.segment(this.renderedValue));
			col += getSelectionColumnAtOffset(spans, selectedOffset - start, affinity);
		}
		return { row: 0, col, offset: selectedOffset };
	}

	getSelectionColumnForOffset(offset: number): number | undefined {
		const selectedOffset = Math.max(0, Math.min(offset, this.value.length));
		const start = this.renderedStartOffset;
		const end = start + this.renderedValue.length;
		if (selectedOffset < start || selectedOffset > end) return undefined;
		return this.getSelectionPointForOffset(selectedOffset, "backward")?.col;
	}

	getLineSelection(row: number): EditorSelectionRange | undefined {
		if (row !== 0) return undefined;
		return this.getSelectAllSelection();
	}

	getSelectAllSelection(): EditorSelectionRange {
		return {
			start: { row: 0, col: this.renderedContentStart, offset: 0 },
			end: {
				row: 0,
				col: this.getRenderedValueRange().end,
				offset: this.value.length,
				boundary: true,
			},
		};
	}

	getSelectionText(start: number, end: number): string {
		return this.value.slice(start, end);
	}

	moveCursorToOffset(offset: number): void {
		this.cursor = Math.max(0, Math.min(offset, this.value.length));
		this.lastAction = null;
	}

	deleteSelection(start: number, end: number): boolean {
		const selectedStart = Math.max(0, Math.min(start, this.value.length));
		const selectedEnd = Math.max(0, Math.min(end, this.value.length));
		if (selectedStart >= selectedEnd) return false;
		this.pushUndo();
		this.replaceRange(selectedStart, selectedEnd, "");
		this.lastAction = null;
		return true;
	}

	handleSelectionInput(data: string, selection: SelectionInputContext): SelectionInputResult {
		return this.selectionInput.handle(data, selection);
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}

	handleInput(data: string): void {
		// Handle bracketed paste mode
		// Start of paste: \x1b[200~
		// End of paste: \x1b[201~

		// Check if we're starting a bracketed paste
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		// If we're in a paste, buffer the data
		if (this.isInPaste) {
			// Check if this chunk contains the end marker
			this.pasteBuffer += data;

			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				// Extract the pasted content
				const pasteContent = this.pasteBuffer.substring(0, endIndex);

				// Process the complete paste
				this.handlePaste(pasteContent);

				// Reset paste state
				this.isInPaste = false;

				// Handle any remaining input after the paste marker
				const remaining = this.pasteBuffer.substring(endIndex + 6); // 6 = length of \x1b[201~
				this.pasteBuffer = "";
				if (remaining) {
					this.handleInput(remaining);
				}
			}
			return;
		}

		const kb = getKeybindings();

		// Escape/Cancel
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.onEscape) this.onEscape();
			return;
		}

		// Undo
		if (kb.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}

		// Submit
		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			if (this.onSubmit) this.onSubmit(this.value);
			return;
		}

		// Deletion
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.handleBackspace();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			this.handleForwardDelete();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.deleteWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.deleteWordForward();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToLineStart();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.deleteToLineEnd();
			return;
		}

		// Kill ring actions
		if (kb.matches(data, "tui.editor.yank")) {
			this.yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.yankPop();
			return;
		}

		// Cursor movement
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.lastAction = null;
			if (this.cursor > 0) {
				const beforeCursor = this.value.slice(0, this.cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.lastAction = null;
			if (this.cursor < this.value.length) {
				const afterCursor = this.value.slice(this.cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.lastAction = null;
			this.cursor = 0;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.lastAction = null;
			this.cursor = this.value.length;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.moveWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.moveWordForwards();
			return;
		}

		const printable = decodeTextInput(data);
		if (printable !== undefined) {
			this.insertCharacter(printable);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || (event.clickCount ?? 1) > 1 || event.button !== "left" || event.y !== 0) {
			return undefined;
		}
		this.render(event.width);
		const point = this.getClosestSelectionPoint(event.y, event.x);
		this.moveCursorToOffset(point.offset);
		return { handled: true, focus: true };
	}

	private insertCharacter(char: string): void {
		const selection = this.selectionInput.takeSelection();
		if (selection) {
			this.pushUndo();
			this.replaceRange(selection.start, selection.end, char);
			this.lastAction = "type-word";
			return;
		}

		// Undo coalescing: consecutive word chars coalesce into one undo unit
		if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
			this.pushUndo();
		}
		this.lastAction = "type-word";

		this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor);
		this.cursor += char.length;
	}

	private replaceRange(start: number, end: number, text: string): void {
		const from = Math.max(0, Math.min(start, this.value.length));
		const to = Math.max(from, Math.min(end, this.value.length));
		this.value = this.value.slice(0, from) + text + this.value.slice(to);
		this.cursor = from + text.length;
	}

	private handleBackspace(): void {
		this.lastAction = null;
		if (this.cursor > 0) {
			this.pushUndo();
			const beforeCursor = this.value.slice(0, this.cursor);
			const graphemes = [...segmenter.segment(beforeCursor)];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor);
			this.cursor -= graphemeLength;
		}
	}

	private handleForwardDelete(): void {
		this.lastAction = null;
		if (this.cursor < this.value.length) {
			this.pushUndo();
			const afterCursor = this.value.slice(this.cursor);
			const graphemes = [...segmenter.segment(afterCursor)];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + graphemeLength);
		}
	}

	private deleteToLineStart(): void {
		if (this.cursor === 0) return;
		this.pushUndo();
		const deletedText = this.value.slice(0, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(this.cursor);
		this.cursor = 0;
	}

	private deleteToLineEnd(): void {
		if (this.cursor >= this.value.length) return;
		this.pushUndo();
		const deletedText = this.value.slice(this.cursor);
		this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(0, this.cursor);
	}

	private deleteWordBackwards(): void {
		if (this.cursor === 0) return;

		// Save lastAction before cursor movement (moveWordBackwards resets it)
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordBackwards();
		const deleteFrom = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(deleteFrom, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, deleteFrom) + this.value.slice(this.cursor);
		this.cursor = deleteFrom;
	}

	private deleteWordForward(): void {
		if (this.cursor >= this.value.length) return;

		// Save lastAction before cursor movement (moveWordForwards resets it)
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordForwards();
		const deleteTo = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(this.cursor, deleteTo);
		this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, this.cursor) + this.value.slice(deleteTo);
	}

	private yank(): void {
		const text = this.killRing.peek();
		if (!text) return;

		this.pushUndo();

		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private yankPop(): void {
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndo();

		// Delete the previously yanked text (still at end of ring before rotation)
		const prevText = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor - prevText.length) + this.value.slice(this.cursor);
		this.cursor -= prevText.length;

		// Rotate and insert new entry
		this.killRing.rotate();
		const text = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private pushUndo(): void {
		this.undoStack.push({ value: this.value, cursor: this.cursor });
	}

	private undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.value = snapshot.value;
		this.cursor = snapshot.cursor;
		this.lastAction = null;
	}

	private moveWordBackwards(): void {
		if (this.cursor === 0) return;
		this.lastAction = null;
		this.cursor = findWordBackward(this.value, this.cursor);
	}

	private moveWordForwards(): void {
		if (this.cursor >= this.value.length) return;
		this.lastAction = null;
		this.cursor = findWordForward(this.value, this.cursor);
	}

	private handlePaste(pastedText: string): void {
		const selection = this.selectionInput.takeSelection();
		this.lastAction = null;
		this.pushUndo();

		// Clean the pasted text - remove newlines and carriage returns
		const cleanText = pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "").replace(/\t/g, "    ");
		this.replaceRange(selection?.start ?? this.cursor, selection?.end ?? this.cursor, cleanText);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		this.renderedValue = "";
		this.renderedStartColumn = 0;
		this.renderedStartOffset = 0;
		// Calculate visible window
		const promptWidth = visibleWidth(this.prompt);
		const availableWidth = width - promptWidth;

		if (availableWidth <= 0) {
			const prompt = truncateToWidth(this.prompt, width, "");
			this.renderedContentStart = visibleWidth(prompt);
			return [prompt];
		}
		this.renderedContentStart = promptWidth;

		if (this.value.length === 0 && this.placeholder) {
			const placeholder = truncateToWidth(this.placeholder, availableWidth, "");
			const graphemes = [...segmenter.segment(placeholder)];
			const atCursor = graphemes[0]?.segment ?? " ";
			const afterCursor = placeholder.slice(atCursor.length);
			const marker = this.focused ? CURSOR_MARKER : "";
			const cursorChar = renderFakeCursor(this.placeholderStyle(atCursor));
			const textWithCursor = marker + cursorChar + this.placeholderStyle(afterCursor);
			const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(textWithCursor)));
			return [this.prompt + textWithCursor + padding];
		}

		let visibleText = "";
		let cursorDisplay = this.cursor;
		this.renderedStartColumn = 0;
		const totalWidth = visibleWidth(this.value);

		if (totalWidth < availableWidth) {
			// Everything fits (leave room for cursor at end)
			visibleText = this.value;
		} else {
			// Need horizontal scrolling
			// Reserve one column for cursor if it's at the end
			const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
			const cursorCol = visibleWidth(this.value.slice(0, this.cursor));

			if (scrollWidth > 0) {
				const halfWidth = Math.floor(scrollWidth / 2);
				let startCol = 0;

				if (cursorCol < halfWidth) {
					// Cursor near start
					startCol = 0;
				} else if (cursorCol > totalWidth - halfWidth) {
					// Cursor near end
					startCol = Math.max(0, totalWidth - scrollWidth);
				} else {
					// Cursor in middle
					startCol = Math.max(0, cursorCol - halfWidth);
				}

				// Strict slicing drops a grapheme straddling startCol, so the
				// displayed slice actually begins at the next grapheme boundary.
				const spans = getSelectionTextSpans(this.value, segmenter.segment(this.value));
				const alignedSpan = spans.find((span) => span.cellStart >= startCol);
				this.renderedStartColumn = alignedSpan?.cellStart ?? visibleWidth(this.value);
				this.renderedStartOffset = alignedSpan?.start ?? this.value.length;
				visibleText = sliceByColumn(this.value, startCol, scrollWidth, true);
				const beforeCursor = sliceByColumn(this.value, startCol, Math.max(0, cursorCol - startCol), true);
				cursorDisplay = beforeCursor.length;
			} else {
				visibleText = "";
				cursorDisplay = 0;
			}
		}

		this.renderedValue = visibleText;

		// Build line with fake cursor
		// Insert cursor character at cursor position
		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? " "; // Character at cursor, or space if at end
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
		const marker = this.focused ? CURSOR_MARKER : "";

		// TUI draws the fake cursor in reverse video, or omits it when the hardware cursor is shown
		const cursorChar = renderFakeCursor(atCursor);
		const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;

		// Calculate visual width
		const visualLength = visibleWidth(textWithCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		const line = this.prompt + textWithCursor + padding;

		return [line];
	}
}
