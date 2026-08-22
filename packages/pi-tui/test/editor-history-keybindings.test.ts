import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("Editor prompt history keybindings", () => {
	it("browses history directly without first moving the cursor", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.historyPrevious": "ctrl+p",
				"tui.editor.historyNext": "ctrl+n",
			}),
		);
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("older prompt");
		editor.addToHistory("newer\nmultiline prompt");

		editor.handleInput("\x10"); // Ctrl+P
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

		editor.handleInput("\x10"); // Ctrl+P
		assert.strictEqual(editor.getText(), "older prompt");

		editor.handleInput("\x0e"); // Ctrl+N
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 16 });

		editor.handleInput("\x0e"); // Ctrl+N - restores the (empty) draft
		assert.strictEqual(editor.getText(), "");
	});

	it("does not enter history from a non-empty draft", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.historyPrevious": "ctrl+p",
				"tui.editor.historyNext": "ctrl+n",
			}),
		);
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("older prompt");
		editor.setText("draft");

		editor.handleInput("\x10"); // Ctrl+P with a draft - blocked, draft untouched
		assert.strictEqual(editor.getText(), "draft");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

		// Clearing the draft re-enables recall
		editor.setText("");
		editor.handleInput("\x10"); // Ctrl+P on empty editor
		assert.strictEqual(editor.getText(), "older prompt");
	});

	it("falls through to cursor movement when the guard blocks a shared Up binding", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.historyPrevious": "up",
			}),
		);
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("prompt");
		editor.setText("ab\ncd");

		// Guard blocks history entry, but the shared default cursorUp binding must
		// still move the cursor instead of dead-ending.
		editor.handleInput("\x1b[A"); // Up with a draft - cursor to the first line
		assert.strictEqual(editor.getText(), "ab\ncd");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });

		editor.handleInput("\x1b[A"); // Up on the first line - jump to line start, no history
		assert.strictEqual(editor.getText(), "ab\ncd");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

		// Empty editor: the same key enters history via historyPrevious
		editor.setText("");
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "prompt");
	});
});
