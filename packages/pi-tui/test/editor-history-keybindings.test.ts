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
		editor.setText("draft");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[D");

		editor.handleInput("\x10"); // Ctrl+P
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

		editor.handleInput("\x10"); // Ctrl+P
		assert.strictEqual(editor.getText(), "older prompt");

		editor.handleInput("\x0e"); // Ctrl+N
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 16 });

		editor.handleInput("\x0e"); // Ctrl+N
		assert.strictEqual(editor.getText(), "draft");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
	});

	it("clears stored history and resets recall state via clearHistory()", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("first prompt");
		editor.addToHistory("second prompt");

		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "second prompt");

		editor.clearHistory();
		editor.setText("");
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "");

		editor.addToHistory("new project prompt");
		editor.handleInput("\x1b[A");
		assert.strictEqual(editor.getText(), "new project prompt");
	});
});
