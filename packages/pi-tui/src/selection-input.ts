import type { SelectionInputContext, SelectionInputResult } from "./editor-component.ts";
import { getKeybindings } from "./keybindings.ts";
import { decodeTextInput } from "./keys.ts";

const BRACKETED_PASTE_START = "\x1b[200~";

export class SelectionInputTransaction {
	private selection: SelectionInputContext | undefined;
	private dispatching = false;
	private replacementUsed = false;
	private readonly dispatchInput: (data: string) => void;
	private readonly isInPaste: () => boolean;
	private readonly deleteSelection: (start: number, end: number) => boolean;

	constructor(
		dispatchInput: (data: string) => void,
		isInPaste: () => boolean,
		deleteSelection: (start: number, end: number) => boolean,
	) {
		this.dispatchInput = dispatchInput;
		this.isInPaste = isInPaste;
		this.deleteSelection = deleteSelection;
	}

	canHandle(data: string): boolean {
		if (this.isInPaste() || data.includes(BRACKETED_PASTE_START)) return true;
		const keybindings = getKeybindings();
		return keybindings.matches(data, "tui.editor.deleteCharBackward") ||
			keybindings.matches(data, "tui.editor.deleteCharForward") ||
			decodeTextInput(data) !== undefined;
	}

	handle(data: string, selection: SelectionInputContext): SelectionInputResult {
		if (!this.canHandle(data)) return { handled: false };
		if (this.isInPaste()) return this.dispatch(data, selection, this.selection !== undefined);
		this.selection = undefined;
		if (data.includes(BRACKETED_PASTE_START)) return this.dispatch(data, selection, true);

		const keybindings = getKeybindings();
		if (
			keybindings.matches(data, "tui.editor.deleteCharBackward") ||
			keybindings.matches(data, "tui.editor.deleteCharForward")
		) {
			const deleted = this.deleteSelection(selection.start, selection.end);
			return { handled: true, clearSelection: deleted };
		}
		return this.dispatch(data, selection, true);
	}

	takeSelection(): SelectionInputContext | undefined {
		if ((!this.dispatching && !this.isInPaste()) || !this.selection) return undefined;
		const selection = this.selection;
		this.selection = undefined;
		this.replacementUsed = true;
		return selection;
	}

	private dispatch(data: string, selection: SelectionInputContext, replace: boolean): SelectionInputResult {
		if (replace && (!this.isInPaste() || !this.selection)) this.selection = selection;
		if (this.selection?.generation !== selection.generation) this.selection = undefined;
		this.replacementUsed = false;
		this.dispatching = true;
		try {
			this.dispatchInput(data);
		} finally {
			this.dispatching = false;
		}
		const clearSelection = this.replacementUsed;
		if (!this.isInPaste()) this.selection = undefined;
		return { handled: true, clearSelection };
	}
}
