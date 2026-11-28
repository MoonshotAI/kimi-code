import assert from "node:assert";
import { describe, it } from "node:test";
import { AltScreenSearchComponent } from "../src/alt-screen-search.ts";
import { Editor, type EditorTheme } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type {
	EditorSelectionPoint,
	EditorSelectionRange,
	SelectionEditComponent,
} from "../src/editor-component.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { Container, type TuiMouseEvent, type TuiMouseEventResult, type TuiMouseEventType } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function highlightedText(line: string): string[] {
	return [...line.matchAll(/\x1b\[7m([\s\S]*?)\x1b\[27m/g)]
		.map((match) => stripTerminalSequences(match[1]!))
		.filter((text) => text.length > 0);
}

function mouse(type: TuiMouseEventType, x: number, y: number, width = 80, height = 10): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...(type === "click" ? { clickCount: 1 } : {}),
	};
}

function searchQuery(tui: TuiAltScreen): string {
	const search = tui.getFocusedComponent();
	assert.ok(search instanceof AltScreenSearchComponent);
	return search.getText();
}

const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

const settingsTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: selectTheme,
};

class StructuralSelectionFixture implements SelectionEditComponent {
	private text = "abcd";
	readonly inputs: string[] = [];

	getText(): string {
		return this.text;
	}

	getClosestSelectionPoint(row: number, column: number): EditorSelectionPoint & { endOffset: number } {
		const offset = Math.max(0, Math.min(this.text.length, column));
		return {
			row: 0,
			col: offset,
			offset,
			endOffset: Math.min(this.text.length, offset + 1),
			...(row !== 0 || column > this.text.length ? { boundary: true } : {}),
		};
	}

	getSelectionContentStart(row: number): number | undefined {
		return row === 0 ? 0 : undefined;
	}

	getSelectionContentEnd(row: number): number | undefined {
		return row === 0 ? this.text.length : undefined;
	}

	getSelectionText(start: number, end: number): string {
		return this.text.slice(start, end);
	}

	deleteSelection(start: number, end: number): boolean {
		if (start >= end) return false;
		this.text = this.text.slice(0, start) + this.text.slice(end);
		return true;
	}

	moveCursorToOffset(_offset: number): void {}

	render(_width: number): string[] {
		return [this.text];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

class RichStructuralSelectionFixture extends StructuralSelectionFixture {
	getLineSelection(_row: number): EditorSelectionRange {
		return this.getSelectAllSelection();
	}

	getSelectAllSelection(): EditorSelectionRange {
		return {
			start: { row: 0, col: 0, offset: 0 },
			end: { row: 0, col: this.getText().length, offset: this.getText().length, boundary: true },
		};
	}
}

class MouseAwareStructuralSelectionFixture extends StructuralSelectionFixture {
	readonly mouseEvents: TuiMouseEventType[] = [];

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		this.mouseEvents.push(event.type);
		return { handled: true, focus: true, capture: true };
	}
}

class InputOverlay extends Container {
	readonly input = new Input();

	constructor() {
		super();
		this.addChild(this.input);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

/** A settings submenu that routes keys to its nested list, like the coding agent's theme submenu. */
class SubmenuHost extends Container {
	readonly list = new SelectList(
		[
			{ value: "first", label: "First" },
			{ value: "second", label: "Second" },
		],
		5,
		selectTheme,
	);

	constructor(done: (value?: string) => void) {
		super();
		this.list.onSelect = (item) => done(item.value);
		this.list.onCancel = () => done();
		this.addChild(this.list);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

describe("mouse-aware components", () => {
	it("positions a single-line input cursor on single click while leaving selection gestures unhandled", () => {
		const input = new Input();
		input.setValue("hello");
		input.render(20);

		assert.strictEqual(input.handleMouse(mouse("press", 4, 0, 20, 1)), undefined);
		assert.strictEqual(input.handleMouse({ ...mouse("click", 4, 0, 20, 1), clickCount: 2 }), undefined);
		assert.strictEqual(input.handleMouse(mouse("click", 4, 0, 20, 1))?.handled, true);
		input.handleInput("X");
		assert.strictEqual(input.getValue(), "heXllo");
	});

	it("positions the input cursor relative to a custom prompt", () => {
		const input = new Input({ prompt: " " });
		input.setValue("hello");
		input.render(20);

		assert.strictEqual(input.handleMouse(mouse("click", 3, 0, 20, 1))?.handled, true);
		input.handleInput("X");
		assert.strictEqual(input.getValue(), "heXllo");
	});

	it("routes search field clicks to the embedded input", () => {
		let query = "";
		const component = new AltScreenSearchComponent((value) => {
			query = value;
		});
		component.render(40);
		component.handleInput("hello");

		assert.strictEqual(component.handleMouse(mouse("click", 4, 1, 40, 3))?.handled, true);
		component.handleInput("X");
		assert.strictEqual(query, "heXllo");
	});

	it("selects and activates list rows", () => {
		const list = new SelectList(
			[
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
				{ value: "d", label: "D" },
				{ value: "e", label: "E" },
			],
			3,
			selectTheme,
		);
		let selected: string | undefined;
		list.onSelect = (item) => {
			selected = item.value;
		};

		assert.strictEqual(list.handleMouse(mouse("press", 1, 2, 40, 3))?.handled, true);
		assert.strictEqual(list.getSelectedItem()?.value, "c");
		assert.strictEqual(list.handleMouse(mouse("click", 1, 2, 40, 3))?.handled, true);
		assert.strictEqual(selected, "c");
	});

	it("activates settings rows", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			[
				{ id: "mode", label: "Mode", currentValue: "one", values: ["one", "two"] },
				{ id: "other", label: "Other", currentValue: "off", values: ["off", "on"] },
				{ id: "third", label: "Third", currentValue: "low", values: ["low", "high"] },
				{ id: "fourth", label: "Fourth", currentValue: "x", values: ["x", "y"] },
			],
			3,
			settingsTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
		);

		list.handleMouse(mouse("press", 1, 2, 40, 5));
		list.handleMouse(mouse("click", 1, 2, 40, 5));
		assert.deepStrictEqual(changes, [{ id: "third", value: "high" }]);
	});

	for (const row of [0, 4]) {
		it(`ignores hover and clicks visible select-list row ${row} after scrolling`, () => {
			const list = new SelectList(
				Array.from({ length: 12 }, (_, i) => ({ value: `item-${i}`, label: `Item ${i}` })),
				5,
				selectTheme,
			);
			const changes: string[] = [];
			let selected: string | undefined;
			list.onSelectionChange = (item) => changes.push(item.value);
			list.onSelect = (item) => {
				selected = item.value;
			};
			list.setSelectedIndex(5);
			list.handleMouse({ ...mouse("wheel", 1, row), wheelDelta: 1 });
			assert.strictEqual(list.getSelectedItem()?.value, "item-6");
			assert.deepStrictEqual(changes, ["item-6"]);
			const before = list.render(80);
			assert.match(before[row], new RegExp(`Item ${4 + row}$`));

			for (const y of [0, 1, 2, 3, 4, row]) {
				assert.strictEqual(list.handleMouse({ ...mouse("move", 1, y), button: "none" }), undefined);
				assert.deepStrictEqual(list.render(80), before);
			}
			assert.strictEqual(list.getSelectedItem()?.value, "item-6");
			assert.deepStrictEqual(changes, ["item-6"]);
			assert.strictEqual(selected, undefined);

			list.handleMouse(mouse("press", 1, row));
			list.render(80);
			list.handleMouse(mouse("click", 1, row));
			assert.strictEqual(selected, `item-${4 + row}`);
			assert.deepStrictEqual(changes, ["item-6", `item-${4 + row}`]);
		});

		it(`ignores hover and clicks visible settings row ${row} after scrolling`, () => {
			const changes: Array<{ id: string; value: string }> = [];
			const list = new SettingsList(
				Array.from({ length: 12 }, (_, i) => ({
					id: `item-${i}`,
					label: `Item ${i}`,
					description: `Description ${i}`,
					currentValue: "off",
					values: ["off", "on"],
				})),
				5,
				settingsTheme,
				(id, value) => changes.push({ id, value }),
				() => {},
				{ enableSearch: true },
			);
			list.selectItem("item-5");
			list.handleMouse({ ...mouse("wheel", 1, row + 2), wheelDelta: 1 });
			const before = list.render(80);
			assert.match(before[4], /^> Item 6/);
			assert.match(before[row + 2], new RegExp(`Item ${4 + row} `));

			for (const y of [0, 1, 2, 3, 4, row]) {
				assert.strictEqual(list.handleMouse({ ...mouse("move", 1, y + 2), button: "none" }), undefined);
				assert.deepStrictEqual(list.render(80), before);
			}
			assert.deepStrictEqual(changes, []);

			list.handleMouse(mouse("press", 1, row + 2));
			list.render(80);
			list.handleMouse(mouse("click", 1, row + 2));
			assert.deepStrictEqual(changes, [{ id: `item-${4 + row}`, value: "on" }]);
		});
	}

	it("keeps a delegating overlay focused when its nested input is clicked", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const overlay = new InputOverlay();
		overlay.input.setValue("hi");
		tui.start();
		tui.showOverlay(overlay, { anchor: "top-left", width: 20 });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<0;5;1m");
		terminal.sendInput("!");
		await terminal.waitForRender();

		assert.strictEqual(overlay.input.getValue(), "hi!");
		assert.strictEqual(tui.getFocusedComponent(), overlay);
		tui.stop();
	});

	it("does not move the editor caret with the refocusing gesture", async (context) => {
		context.mock.timers.enable({ apis: ["Date"] });
		context.mock.timers.setTime(1_000);
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { refocusMouseGuardMs: 300 });
		const editor = new Editor(tui, editorTheme);
		editor.setText("hello");
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		terminal.sendInput("\x1b[<0;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		terminal.sendInput("X");
		assert.strictEqual(editor.getText(), "helloX");

		context.mock.timers.setTime(1_300);
		terminal.sendInput("\x1b[<0;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		terminal.sendInput("Y");
		assert.strictEqual(editor.getText(), "heYlloX");
		tui.stop();
	});

	it("keeps a settings list focused when a click in its submenu closes the submenu", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal);
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			[
				{ id: "theme", label: "Theme", currentValue: "first", submenu: (_value, done) => new SubmenuHost(done) },
				{ id: "other", label: "Other", currentValue: "off", values: ["off", "on"] },
			],
			5,
			settingsTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
		);
		tui.addChild(list);
		tui.setFocus(list);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\r");
		await terminal.waitForRender();
		// Press and release on the submenu's second row selects it and closes the submenu.
		terminal.sendInput("\x1b[<0;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(changes, [{ id: "theme", value: "second" }]);
		assert.strictEqual(tui.getFocusedComponent(), list);

		// Keys reach the visible list again instead of the closed submenu.
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		assert.deepStrictEqual(changes, [
			{ id: "theme", value: "second" },
			{ id: "other", value: "on" },
		]);
		tui.stop();
	});

	it("positions and focuses the multiline editor through alternate-screen dispatch", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, editorTheme);
		editor.setText("hello");
		tui.addChild(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		terminal.sendInput("X");
		await terminal.waitForRender();

		assert.strictEqual(editor.getText(), "heXllo");
		assert.strictEqual(tui.getFocusedComponent(), editor);
		tui.stop();
	});

	it("translates clicks by the cropped line offset of an over-tall component", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, editorTheme);
		editor.setText("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10");
		tui.setLayoutRoot(editor);
		tui.start();
		tui.setFocus(editor);
		await terminal.waitForRender();

		// The editor renders 7 rows into 5, so the layout crops the top row to
		// keep the cursor row visible; the second screen row displays "l7".
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		terminal.sendInput("X");
		await terminal.waitForRender();

		assert.strictEqual(editor.getText(), "l1\nl2\nl3\nl4\nl5\nl6\nlX7\nl8\nl9\nl10");
		tui.stop();
	});

	it("dispatches cropped rows within the uncropped height to container subclasses", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, editorTheme);
		editor.setText("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10");
		// A Container subclass with its own handleMouse (like the app's
		// GutterContainer) receives dispatch instead of being skipped.
		const wrapper = new (class extends Container {
			override handleMouse(event: TuiMouseEvent) {
				return super.handleMouse(event);
			}
		})();
		wrapper.addChild(editor);
		tui.setLayoutRoot(wrapper);
		tui.start();
		tui.setFocus(editor);
		await terminal.waitForRender();

		// The wrapper renders 7 rows into 5 and is cropped by one row; the last
		// screen row displays "l10".
		terminal.sendInput("\x1b[<0;2;5M");
		terminal.sendInput("\x1b[<0;2;5m");
		terminal.sendInput("X");
		await terminal.waitForRender();

		assert.strictEqual(editor.getText(), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nlX10");
		tui.stop();
	});

	it("maps clicks from the grapheme-aligned scroll origin", () => {
		const input = new Input({ prompt: "" });
		input.setValue("😀a😀bc");
		// setValue keeps the cursor at 0; walk to the end, then back to just
		// after "a" so horizontal scrolling starts inside the first emoji.
		for (let i = 0; i < 5; i++) input.handleInput("\x1b[C");
		for (let i = 0; i < 3; i++) input.handleInput("\x1b[D");
		input.render(5);

		// "a" is the first displayed character; clicking it must place the
		// cursor after "😀" rather than at the raw scroll column.
		assert.strictEqual(input.handleMouse(mouse("click", 0, 0, 5, 1))?.handled, true);
		input.handleInput("X");
		assert.strictEqual(input.getValue(), "😀Xa😀bc");
	});

	it("selects and copies editor text on drag instead of moving the cursor", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, editorTheme);
		editor.setText("hello world");
		tui.addChild(editor);
		tui.start();
		await terminal.waitForRender();
		const cursorBefore = editor.getCursor();

		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;5;2M");
		terminal.sendInput("\x1b[<0;5;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["hello"]);
		assert.deepStrictEqual(editor.getCursor(), cursorBefore);
		tui.stop();
	});

	it("moves the focused editor caret to the active drag endpoint", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
		const editor = new Editor(tui, editorTheme, { paddingX: 2 });
		editor.setText("qqq\nwww\neee");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const firstRow = viewport.findIndex((line) => line.includes("qqq"));
			const secondRow = viewport.findIndex((line) => line.includes("www"));
			const thirdRow = viewport.findIndex((line) => line.includes("eee"));
			assert.ok(firstRow >= 0);
			assert.ok(secondRow > firstRow);
			assert.ok(thirdRow > secondRow);
			const start = viewport[firstRow]!.indexOf("qqq");
			const endpoint = viewport[secondRow]!.indexOf("www") + 1;
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 3 });
			assert.deepStrictEqual(terminal.getCursorPosition(), { x: viewport[thirdRow]!.indexOf("eee") + 3, y: thirdRow });

			terminal.sendInput(`\x1b[<0;${start + 1};${firstRow + 1}M`);
			terminal.sendInput(`\x1b[<32;${endpoint + 1};${secondRow + 1}M`);
			await terminal.waitForRender();

			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 1 });
			assert.deepStrictEqual(terminal.getCursorPosition(), { x: endpoint, y: secondRow });
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[thirdRow]!), []);
		} finally {
			tui.stop();
		}
	});

	it("immediately clears a selection and shows one caret at the clicked editor position", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
		const editor = new Editor(tui, editorTheme, { paddingX: 2 });
		editor.setText("dddd\naaa\neee");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const firstRow = viewport.findIndex((line) => line.includes("dddd"));
			const thirdRow = viewport.findIndex((line) => line.includes("eee"));
			assert.ok(firstRow >= 0);
			assert.ok(thirdRow > firstRow);
			const start = viewport[firstRow]!.indexOf("dddd") + 1;
			const endpoint = start + 1;
			const click = viewport[thirdRow]!.indexOf("eee");
			terminal.sendInput(`\x1b[<0;${start + 1};${firstRow + 1}M`);
			terminal.sendInput(`\x1b[<32;${endpoint + 1};${firstRow + 1}M`);
			terminal.sendInput(`\x1b[<0;${endpoint + 1};${firstRow + 1}m`);
			await terminal.waitForRender();

			terminal.sendInput(`\x1b[<0;${click + 1};${thirdRow + 1}M`);
			terminal.sendInput(`\x1b[<0;${click + 1};${thirdRow + 1}m`);
			await new Promise<void>((resolve) => process.nextTick(resolve));

			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });
			assert.strictEqual(tui.hasActiveSelection(), false);
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[firstRow]!), []);
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[thirdRow]!), ["e"]);
		} finally {
			tui.stop();
		}
	});

	it("does not select virtual space after editor text", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal, true, undefined, { copyOnSelect: false, editorSelection: true });
		const editor = new Editor(tui, editorTheme, { paddingX: 2 });
		editor.setText("ddd");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const row = viewport.findIndex((line) => line.includes("ddd"));
			assert.ok(row >= 0);
			const line = viewport[row]!;
			const textIndex = line.indexOf("ddd");
			const textStart = visibleWidth(line.slice(0, textIndex));
			const textEnd = textStart + 3;

			terminal.sendInput(`\x1b[<0;${textEnd + 6};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${textEnd + 11};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${textEnd + 11};${row + 1}m`);
			await terminal.waitForRender();
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[row]!).filter((text) => text !== " "), []);

			terminal.sendInput(`\x1b[<0;${textEnd + 11};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${textStart + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${textStart + 1};${row + 1}m`);
			await terminal.waitForRender();
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[row]!).filter((text) => text !== " "), ["ddd"]);
		} finally {
			tui.stop();
		}
	});

	it("replaces a dragged search selection with plain input and moves the caret to its endpoint", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			const query = "苹果 单独的";
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput(query);
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const row = viewport.findIndex((line) => line.includes(query));
			assert.ok(row >= 0);
			const line = viewport[row]!;
			const queryIndex = line.indexOf(query);
			assert.ok(queryIndex >= 0);
			const startColumn = visibleWidth(line.slice(0, queryIndex));
			const endColumn = startColumn + visibleWidth("苹果");

			terminal.sendInput(`\x1b[<0;${startColumn + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${endColumn - 1};${row + 1}M`);
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getCursorPosition(), { x: endColumn - 2, y: row });
			terminal.sendInput(`\x1b[<0;${endColumn - 1};${row + 1}m`);
			await terminal.waitForRender();

			assert.deepStrictEqual(copied, ["苹果"]);
			assert.deepStrictEqual(terminal.getCursorPosition(), { x: endColumn - 2, y: row });
			terminal.sendInput("X");
			await terminal.waitForRender();
			assert.strictEqual(searchQuery(tui), "X 单独的");
			assert.strictEqual(tui.hasActiveSelection(), false);
		} finally {
			tui.stop();
		}
	});

	for (const [name, input] of [
		["Kitty printable input", "\x1b[88u"],
		["modifyOtherKeys printable input", "\x1b[27;2;88~"],
		["bracketed paste", "\x1b[200~X\x1b[201~"],
	] as const) {
		it(`replaces a dragged search selection with ${name}`, async () => {
			const terminal = new VirtualTerminal(80, 8);
			const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
			tui.addChild(new Text("transcript", 0, 0));
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[102;6u");
				terminal.sendInput("hello world");
				await terminal.waitForRender();
				const viewport = terminal.getViewport();
				const row = viewport.findIndex((line) => line.includes("hello world"));
				assert.ok(row >= 0);
				const line = viewport[row]!;
				const wordIndex = line.indexOf("world");
				assert.ok(wordIndex >= 0);
				const startColumn = visibleWidth(line.slice(0, wordIndex));
				const endColumn = startColumn + visibleWidth("world");
				terminal.sendInput(`\x1b[<0;${startColumn + 1};${row + 1}M`);
				terminal.sendInput(`\x1b[<32;${endColumn};${row + 1}M`);
				terminal.sendInput(`\x1b[<0;${endColumn};${row + 1}m`);
				await terminal.waitForRender();

				terminal.sendInput(input);
				await terminal.waitForRender();

				assert.strictEqual(searchQuery(tui), "hello X");
				assert.deepStrictEqual(terminal.getCursorPosition(), { x: startColumn + 1, y: row });
				assert.strictEqual(tui.hasActiveSelection(), false);
			} finally {
				tui.stop();
			}
		});
	}

	it("moves the search caret to the active endpoint of a reverse drag", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("hello world");
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const row = viewport.findIndex((line) => line.includes("hello world"));
			assert.ok(row >= 0);
			const line = viewport[row]!;
			const wordIndex = line.indexOf("world");
			assert.ok(wordIndex >= 0);
			const startColumn = visibleWidth(line.slice(0, wordIndex));
			const endColumn = startColumn + visibleWidth("world");

			terminal.sendInput(`\x1b[<0;${endColumn + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${startColumn + 1};${row + 1}M`);
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getCursorPosition(), { x: startColumn, y: row });
			terminal.sendInput(`\x1b[<0;${startColumn + 1};${row + 1}m`);
			await terminal.waitForRender();

			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["world"]);
			assert.strictEqual(searchQuery(tui), "hello world");
			assert.deepStrictEqual(terminal.getCursorPosition(), { x: startColumn, y: row });
		} finally {
			tui.stop();
		}
	});

	it("copies and deletes only real search query text after dragging beyond any field boundary", async () => {
		for (const direction of ["above", "below", "left", "right"] as const) {
			const terminal = new VirtualTerminal(80, 8);
			const copied: string[] = [];
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copyOnSelect: false,
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			tui.addChild(new Text("transcript", 0, 0));
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[102;6u");
				terminal.sendInput("hello world");
				await terminal.waitForRender();
				const viewport = terminal.getViewport();
				const row = viewport.findIndex((line) => line.includes("hello world"));
				assert.ok(row >= 0, direction);
				const line = viewport[row]!;
				const wordIndex = line.indexOf("world");
				assert.ok(wordIndex >= 0, direction);
				const anchorColumn = visibleWidth(line.slice(0, wordIndex));
				const target =
					direction === "above"
						? { x: anchorColumn + 1, y: 1 }
						: direction === "below"
							? { x: anchorColumn + 1, y: terminal.rows }
							: direction === "left"
								? { x: 1, y: row + 1 }
								: { x: terminal.columns, y: row + 1 };
				terminal.sendInput(`\x1b[<0;${anchorColumn + 1};${row + 1}M`);
				terminal.sendInput(`\x1b[<32;${target.x};${target.y}M`);
				terminal.sendInput(`\x1b[<0;${target.x};${target.y}m`);
				await terminal.waitForRender();

				assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true, direction);
				assert.deepStrictEqual(copied, [direction === "above" || direction === "left" ? "hello w" : "world"], direction);
				terminal.sendInput("\x7f");
				await terminal.waitForRender();
				assert.strictEqual(searchQuery(tui), direction === "above" || direction === "left" ? "orld" : "hello ", direction);
				assert.strictEqual(tui.hasActiveSelection(), false, direction);
			} finally {
				tui.stop();
			}
		}
	});

	it("clears an old search selection on the next tick after a click and shows only the new caret", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("hello world");
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const row = viewport.findIndex((line) => line.includes("hello world"));
			assert.ok(row >= 0);
			const line = viewport[row]!;
			const queryIndex = line.indexOf("hello world");
			const wordIndex = line.indexOf("world");
			assert.ok(queryIndex >= 0);
			assert.ok(wordIndex >= 0);
			const queryStart = visibleWidth(line.slice(0, queryIndex));
			const startColumn = visibleWidth(line.slice(0, wordIndex));
			const endColumn = startColumn + visibleWidth("world");
			terminal.sendInput(`\x1b[<0;${startColumn + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${endColumn};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${endColumn};${row + 1}m`);
			await terminal.waitForRender();

			const clickColumn = queryStart + 2;
			terminal.sendInput(`\x1b[<0;${clickColumn + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${clickColumn + 1};${row + 1}m`);
			await new Promise<void>((resolve) => process.nextTick(resolve));

			assert.strictEqual(tui.hasActiveSelection(), false);
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[row]!), ["l"]);
		} finally {
			tui.stop();
		}
	});

	it("does not select virtual space after the search query", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("aa");
			await terminal.waitForRender();
			const search = tui.getFocusedComponent();
			assert.ok(search instanceof AltScreenSearchComponent);
			search.focused = false;
			search.invalidate();
			tui.requestRender();
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const row = viewport.findIndex((line) => line.includes("aa"));
			assert.ok(row >= 0);
			const line = viewport[row]!;
			const queryIndex = line.indexOf("aa");
			const queryStart = visibleWidth(line.slice(0, queryIndex));
			const queryEnd = queryStart + 2;

			terminal.sendInput(`\x1b[<0;${queryEnd + 6};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${queryEnd + 12};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${queryEnd + 12};${row + 1}m`);
			await terminal.waitForRender();
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[row]!).filter((text) => text !== " "), []);

			terminal.sendInput(`\x1b[<0;${queryEnd + 12};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${queryStart + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${queryStart + 1};${row + 1}m`);
			await terminal.waitForRender();
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[row]!).filter((text) => text !== " "), ["aa"]);
		} finally {
			tui.stop();
		}
	});

	it("keeps the empty search caret at the start and excludes its placeholder from selection", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		await terminal.waitForRender();
		const placeholder = "Find in transcript";
		let viewport = terminal.getViewport();
		let row = viewport.findIndex((line) => line.includes(placeholder));
		assert.ok(row >= 0);
		let line = viewport[row]!;
		let placeholderIndex = line.indexOf(placeholder);
		assert.ok(placeholderIndex >= 0);
		let startColumn = visibleWidth(line.slice(0, placeholderIndex));
		let endColumn = startColumn + visibleWidth(placeholder);
		terminal.sendInput(`\x1b[<0;${endColumn};${row + 1}M`);
		terminal.sendInput(`\x1b[<0;${endColumn};${row + 1}m`);
		terminal.sendInput("X");
		await terminal.waitForRender();
		assert.ok(
			terminal.getViewport().some((rendered) => rendered.includes("X") && rendered.includes("No matches")),
		);

		terminal.sendInput("\x7f");
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		row = viewport.findIndex((line) => line.includes(placeholder));
		assert.ok(row >= 0);
		line = viewport[row]!;
		placeholderIndex = line.indexOf(placeholder);
		assert.ok(placeholderIndex >= 0);
		startColumn = visibleWidth(line.slice(0, placeholderIndex));
		endColumn = startColumn + visibleWidth(placeholder);
		terminal.sendInput(`\x1b[<0;${startColumn + 1};${row + 1}M`);
		terminal.sendInput(`\x1b[<32;${endColumn};${row + 1}M`);
		terminal.sendInput(`\x1b[<0;${endColumn};${row + 1}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, []);
		tui.stop();
	});

	it("does not select the search result status", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("hello");
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes("No matches"));
		assert.ok(row >= 0);
		const line = viewport[row]!;
		const resultIndex = line.indexOf("No matches");
		assert.ok(resultIndex >= 0);
		const startColumn = visibleWidth(line.slice(0, resultIndex));
		const endColumn = startColumn + visibleWidth("No matches");

		terminal.sendInput(`\x1b[<0;${startColumn + 1};${row + 1}M`);
		terminal.sendInput(`\x1b[<32;${endColumn};${row + 1}M`);
		terminal.sendInput(`\x1b[<0;${endColumn};${row + 1}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, []);
		tui.stop();
	});

	for (const { query, expected } of [
		{ query: "苹果 单独的", expected: "苹果 单独的" },
		{ query: "abcdefghijklmnopqrstuvwxyz0123456789", expected: "abcdefghijklmnopqrstuvwxyz0123456789" },
	]) {
		it(`selects the search logical line on triple click without UI text: ${query}`, async () => {
			const terminal = new VirtualTerminal(80, 8);
			const copied: string[] = [];
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			tui.addChild(new Text("transcript", 0, 0));
			tui.start();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput(query);
			terminal.sendInput("\x01");
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const row = viewport.findIndex((line) => line.includes("No matches"));
			assert.ok(row >= 0);
			const line = viewport[row]!;
			const borderIndex = line.indexOf("│");
			assert.ok(borderIndex >= 0);
			const clickColumn = visibleWidth(line.slice(0, borderIndex)) + 3;

			for (let click = 0; click < 3; click++) {
				terminal.sendInput(`\x1b[<0;${clickColumn};${row + 1}M`);
				terminal.sendInput(`\x1b[<0;${clickColumn};${row + 1}m`);
			}
			await terminal.waitForRender();

			assert.strictEqual(copied.at(-1), expected);
			tui.stop();
		});
	}

	it("deletes a dragged search selection on Backspace and places the caret at its start", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const query = "hello world";
		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput(query);
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes(query));
		assert.ok(row >= 0);
		const line = viewport[row]!;
		const wordIndex = line.indexOf("world");
		assert.ok(wordIndex >= 0);
		const startColumn = visibleWidth(line.slice(0, wordIndex));
		const endColumn = startColumn + visibleWidth("world");
		terminal.sendInput(`\x1b[<0;${startColumn + 1};${row + 1}M`);
		terminal.sendInput(`\x1b[<32;${endColumn};${row + 1}M`);
		terminal.sendInput(`\x1b[<0;${endColumn};${row + 1}m`);
		await terminal.waitForRender();

		terminal.sendInput("\x7f");
		terminal.sendInput("X");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((rendered) => rendered.includes("hello X")));
		terminal.sendInput("\x1f");
		terminal.sendInput("\x1f");
		await terminal.waitForRender();
		assert.ok(
			terminal.getViewport().some((rendered) => rendered.includes(query)),
			terminal.getViewport().join("\n"),
		);
		tui.stop();
	});

	it("deletes a triple-click search selection on Delete", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const query = "苹果 单独的";
		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput(query);
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes(query));
		assert.ok(row >= 0);
		const line = viewport[row]!;
		const borderIndex = line.indexOf("│");
		assert.ok(borderIndex >= 0);
		const clickColumn = visibleWidth(line.slice(0, borderIndex)) + 3;
		for (let click = 0; click < 3; click++) {
			terminal.sendInput(`\x1b[<0;${clickColumn};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${clickColumn};${row + 1}m`);
		}
		await terminal.waitForRender();

		terminal.sendInput("\x1b[3~");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((rendered) => rendered.includes("Find in transcript")));
		tui.stop();
	});

	it("deletes the complete horizontally scrolled search value after triple click", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("abcdefghijklmnopqrstuvwxyz0123456789");
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const row = viewport.findIndex((line) => line.includes("No matches"));
			assert.ok(row >= 0);
			const line = viewport[row]!;
			const borderIndex = line.indexOf("│");
			assert.ok(borderIndex >= 0);
			const clickColumn = visibleWidth(line.slice(0, borderIndex)) + 3;
			for (let click = 0; click < 3; click++) {
				terminal.sendInput(`\x1b[<0;${clickColumn};${row + 1}M`);
				terminal.sendInput(`\x1b[<0;${clickColumn};${row + 1}m`);
				await terminal.waitForRender();
			}
			await terminal.waitForRender();

			terminal.sendInput("\x1b[3~");
			await terminal.waitForRender();
			assert.ok(
				terminal.getViewport().some((rendered) => rendered.includes("Find in transcript")),
				terminal.getViewport().join("\n"),
			);
		} finally {
			tui.stop();
		}
	});

	it("keeps a horizontally scrolled search selection logical for highlighting, copying, and deletion", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			const query = "abcdefghijklmnopqrstuvwxyz0123456789";
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput(query);
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const row = viewport.findIndex((line) => line.includes("No matches"));
			assert.ok(row >= 0);
			const line = viewport[row]!;
			const borderIndex = line.indexOf("│");
			assert.ok(borderIndex >= 0);
			const startColumn = visibleWidth(line.slice(0, borderIndex)) + 2;
			const endColumn = startColumn + 2;
			terminal.sendInput(`\x1b[<0;${startColumn + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${endColumn};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${endColumn};${row + 1}m`);
			await terminal.waitForRender();

			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[row]!).filter((text) => text.length > 1), ["uv"]);
			const rendered = stripTerminalSequences(terminal.getViewport()[row]!);
			const selectedIndex = rendered.indexOf("uv");
			assert.ok(selectedIndex >= 0);
			assert.deepStrictEqual(terminal.getCursorPosition(), { x: selectedIndex + 1, y: row });
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["uv"]);
			terminal.sendInput("\x7f");
			await terminal.waitForRender();
			assert.strictEqual(searchQuery(tui), query.replace("uv", ""));
			assert.strictEqual(tui.hasActiveSelection(), false);
		} finally {
			tui.stop();
		}
	});

	it("selects the visible search input with Ctrl+Shift+A for deletion", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, searchSelectAll: true });
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("苹果 单独的");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[97;6u");
		await terminal.waitForRender();
		terminal.sendInput("\x7f");
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().some((rendered) => rendered.includes("Find in transcript")));
		tui.stop();
	});

	it("selects the complete search value with Ctrl+Shift+A including horizontally invisible text", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			searchSelectAll: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			const query = "abcdefghijklmnopqrstuvwxyz0123456789";
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput(query);
			await terminal.waitForRender();
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();

			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, [query]);
			terminal.sendInput("\x7f");
			await terminal.waitForRender();
			assert.strictEqual(searchQuery(tui), "");
			assert.ok(terminal.getViewport().some((rendered) => rendered.includes("Find in transcript")));
		} finally {
			tui.stop();
		}
	});

	it("leaves Ctrl+Shift+A inactive when search select-all is not enabled", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("hello");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[97;6u");
		terminal.sendInput("\x7f");
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().some((rendered) => rendered.includes("hell")));
		tui.stop();
	});

	it("deletes a dragged editor selection with padding and preserves undo", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
		const editor = new Editor(tui, editorTheme, { paddingX: 2 });
		editor.setText("hello world");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes("hello world"));
		assert.ok(row >= 0);
		const line = viewport[row]!;
		const wordIndex = line.indexOf("world");
		assert.ok(wordIndex >= 0);
		const startColumn = visibleWidth(line.slice(0, wordIndex));
		const endColumn = startColumn + visibleWidth("world");
		terminal.sendInput(`\x1b[<0;${startColumn + 1};${row + 1}M`);
		terminal.sendInput(`\x1b[<32;${endColumn};${row + 1}M`);
		terminal.sendInput(`\x1b[<0;${endColumn};${row + 1}m`);
		await terminal.waitForRender();

		terminal.sendInput("\x7f");
		terminal.sendInput("X");
		await terminal.waitForRender();
		assert.strictEqual(editor.getText(), "hello X");
		terminal.sendInput("\x1f");
		terminal.sendInput("\x1f");
		await terminal.waitForRender();
		assert.strictEqual(editor.getText(), "hello world");
		tui.stop();
	});

	it("copies and deletes a dragged multiline editor selection using document offsets", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, editorTheme, { paddingX: 2 });
		editor.setText("first\nsecond\nthird");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const firstRow = viewport.findIndex((line) => line.includes("first"));
			const lastRow = viewport.findIndex((line) => line.includes("third"));
			assert.ok(firstRow >= 0);
			assert.ok(lastRow > firstRow);
			const start = viewport[firstRow]!.indexOf("first") + 1;
			const end = viewport[lastRow]!.indexOf("third") + 3;
			terminal.sendInput(`\x1b[<0;${start + 1};${firstRow + 1}M`);
			terminal.sendInput(`\x1b[<32;${end + 1};${lastRow + 1}M`);
			terminal.sendInput(`\x1b[<0;${end + 1};${lastRow + 1}m`);
			await terminal.waitForRender();

			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["irst\nsecond\nthir"]);
			terminal.sendInput("\x7f");
			await terminal.waitForRender();
			assert.strictEqual(editor.getText(), "fd");
		} finally {
			tui.stop();
		}
	});

	for (const [name, input] of [
		["plain input", "X"],
		["Kitty printable input", "\x1b[88u"],
		["modifyOtherKeys printable input", "\x1b[27;2;88~"],
		["bracketed paste", "\x1b[200~X\x1b[201~"],
	] as const) {
		it(`replaces a dragged multiline editor selection with ${name}`, async () => {
			const terminal = new VirtualTerminal(20, 8);
			const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
			const editor = new Editor(tui, editorTheme, { paddingX: 2 });
			editor.setText("first\nsecond\nthird");
			tui.setLayoutRoot(editor);
			tui.setFocus(editor);
			tui.start();
			try {
				await terminal.waitForRender();
				const viewport = terminal.getViewport();
				const firstRow = viewport.findIndex((line) => line.includes("first"));
				const lastRow = viewport.findIndex((line) => line.includes("third"));
				assert.ok(firstRow >= 0);
				assert.ok(lastRow > firstRow);
				const start = viewport[firstRow]!.indexOf("first") + 1;
				const end = viewport[lastRow]!.indexOf("third") + 3;
				terminal.sendInput(`\x1b[<0;${start + 1};${firstRow + 1}M`);
				terminal.sendInput(`\x1b[<32;${end + 1};${lastRow + 1}M`);
				terminal.sendInput(`\x1b[<0;${end + 1};${lastRow + 1}m`);
				await terminal.waitForRender();

				terminal.sendInput(input);
				await terminal.waitForRender();

				assert.strictEqual(editor.getText(), "fXd");
				assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
				assert.strictEqual(tui.hasActiveSelection(), false);
			} finally {
				tui.stop();
			}
		});
	}

	it("starts a logical multiline editor selection from the top border", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, true, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, editorTheme);
		editor.setText("ddd\n");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const firstRow = viewport.findIndex((line) => line.includes("ddd"));
			const topRow = firstRow - 1;
			const emptyRow = firstRow + 1;
			assert.ok(firstRow > 0);
			const column = viewport[firstRow]!.indexOf("ddd");
			terminal.sendInput(`\x1b[<0;${column + 1};${topRow + 1}M`);
			terminal.sendInput(`\x1b[<32;${column + 1};${emptyRow + 1}M`);
			terminal.sendInput(`\x1b[<0;${column + 1};${emptyRow + 1}m`);
			await terminal.waitForRender();

			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[firstRow]!), ["ddd "]);
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[emptyRow]!), [" "]);
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["ddd\n"]);
		} finally {
			tui.stop();
		}
	});

	it("keeps selected editor newlines and the empty-line endpoint visible when dragged outside", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, editorTheme, { paddingX: 2 });
		editor.setText("ddd\n");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			editor.focused = false;
			tui.requestRender();
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const firstRow = viewport.findIndex((line) => line.includes("ddd"));
			const emptyRow = firstRow + 1;
			assert.ok(firstRow >= 0);
			const column = viewport[firstRow]!.indexOf("ddd");
			terminal.sendInput(`\x1b[<0;${column + 1};${firstRow + 1}M`);
			terminal.sendInput(`\x1b[<32;${column + 1};${emptyRow + 1}M`);
			await terminal.waitForRender();

			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[firstRow]!), ["ddd "]);
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[emptyRow]!), [" "]);

			terminal.sendInput(`\x1b[<32;${column + 1};${terminal.rows}M`);
			await terminal.waitForRender();
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[firstRow]!), ["ddd "]);
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[emptyRow]!), [" "]);
			terminal.sendInput(`\x1b[<0;${column + 1};${terminal.rows}m`);
			await terminal.waitForRender();
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[firstRow]!), ["ddd "]);
			assert.deepStrictEqual(highlightedText(tui.getScreenLines()[emptyRow]!), [" "]);
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["ddd\n"]);
		} finally {
			tui.stop();
		}
	});

	it("deletes the whole logical editor line on triple click", async () => {
		const terminal = new VirtualTerminal(12, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
		const editor = new Editor(tui, editorTheme, { paddingX: 1 });
		editor.setText("first\nsecond wrapped line");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes("second"));
		assert.ok(row >= 0);
		const line = viewport[row]!;
		const wordIndex = line.indexOf("second");
		assert.ok(wordIndex >= 0);
		const clickColumn = visibleWidth(line.slice(0, wordIndex)) + 2;
		for (let click = 0; click < 3; click++) {
			terminal.sendInput(`\x1b[<0;${clickColumn};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${clickColumn};${row + 1}m`);
		}
		await terminal.waitForRender();

		terminal.sendInput("\x7f");
		await terminal.waitForRender();
		assert.strictEqual(editor.getText(), "first\n");
		tui.stop();
	});

	it("selects all editor text with Ctrl+Shift+A including scrolled-off lines", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
		const editor = new Editor(tui, editorTheme);
		const text = "one\ntwo\nthree\nfour\nfive\nsix";
		editor.setText(text);
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[97;6u");
		await terminal.waitForRender();
		terminal.sendInput("\x7f");
		await terminal.waitForRender();
		assert.strictEqual(editor.getText(), "");
		terminal.sendInput("\x1f");
		await terminal.waitForRender();
		assert.strictEqual(editor.getText(), text);
		tui.stop();
	});

	for (const [name, key, cursor] of [
		["Left", "\x1b[D", { line: 2, col: 7 }],
		["Right", "\x1b[C", { line: 2, col: 8 }],
		["Home", "\x1b[H", { line: 2, col: 0 }],
		["End", "\x1b[F", { line: 2, col: 8 }],
		["WordLeft", "\x1b[1;5D", { line: 2, col: 5 }],
		["WordRight", "\x1b[1;5C", { line: 2, col: 8 }],
		["Up", "\x1b[A", { line: 1, col: 8 }],
		["Down", "\x1b[B", { line: 2, col: 8 }],
	] as const) {
		it(`clears an editor selection on ${name} before subsequent input`, async () => {
			const terminal = new VirtualTerminal(30, 10);
			const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
			const editor = new Editor(tui, editorTheme);
			const text = "one two\nthree four\nfive six";
			editor.setText(text);
			tui.setLayoutRoot(editor);
			tui.setFocus(editor);
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[97;6u");
				await terminal.waitForRender();
				assert.strictEqual(tui.hasActiveSelection(), true);

				terminal.sendInput(key);
				assert.strictEqual(tui.hasActiveSelection(), false);
				assert.deepStrictEqual(editor.getCursor(), cursor);
				terminal.sendInput("X");
				await terminal.waitForRender();

				const lines = text.split("\n");
				lines[cursor.line] = `${lines[cursor.line]!.slice(0, cursor.col)}X${lines[cursor.line]!.slice(cursor.col)}`;
				assert.strictEqual(editor.getText(), lines.join("\n"));
			} finally {
				tui.stop();
			}
		});
	}

	for (const [name, key, expected] of [
		["Left", "\x1b[D", "one twXo"],
		["Right", "\x1b[C", "one twoX"],
		["Home", "\x1b[H", "Xone two"],
		["End", "\x1b[F", "one twoX"],
		["WordLeft", "\x1b[1;5D", "one Xtwo"],
		["WordRight", "\x1b[1;5C", "one twoX"],
		["Up", "\x1b[A", "one twoX"],
		["Down", "\x1b[B", "one twoX"],
	] as const) {
		it(`clears a search selection on ${name} before subsequent input`, async () => {
			const terminal = new VirtualTerminal(80, 8);
			const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, searchSelectAll: true });
			tui.addChild(new Text("transcript", 0, 0));
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[102;6u");
				terminal.sendInput("one two");
				await terminal.waitForRender();
				terminal.sendInput("\x1b[97;6u");
				await terminal.waitForRender();
				assert.strictEqual(tui.hasActiveSelection(), true);

				terminal.sendInput(key);
				assert.strictEqual(tui.hasActiveSelection(), false);
				terminal.sendInput("X");
				await terminal.waitForRender();
				assert.strictEqual(searchQuery(tui), expected);
			} finally {
				tui.stop();
			}
		});
	}

	for (const [name, key] of [
		["Shift+Delete", "\x1b[3;2~"],
		["Shift+Backspace", "\x1b[127;2u"],
	] as const) {
		it(`deletes an editor selection with ${name}`, async () => {
			const terminal = new VirtualTerminal(20, 8);
			const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
			const editor = new Editor(tui, editorTheme);
			editor.setText("hello");
			tui.setLayoutRoot(editor);
			tui.setFocus(editor);
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[97;6u");
				await terminal.waitForRender();
				terminal.sendInput(key);
				await terminal.waitForRender();
				assert.strictEqual(editor.getText(), "");
				assert.strictEqual(tui.hasActiveSelection(), false);
			} finally {
				tui.stop();
			}
		});

		it(`deletes a search selection with ${name}`, async () => {
			const terminal = new VirtualTerminal(80, 8);
			const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, searchSelectAll: true });
			tui.addChild(new Text("transcript", 0, 0));
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[102;6u");
				terminal.sendInput("hello");
				await terminal.waitForRender();
				terminal.sendInput("\x1b[97;6u");
				await terminal.waitForRender();
				terminal.sendInput(key);
				await terminal.waitForRender();
				assert.strictEqual(searchQuery(tui), "");
				assert.strictEqual(tui.hasActiveSelection(), false);
			} finally {
				tui.stop();
			}
		});
	}

	for (const [name, input] of [
		["mixed printable and newline input", "new\nvalue"],
		["C1 control input", "\u0085"],
	] as const) {
		it(`keeps a search selection unchanged for rejected ${name}`, async () => {
			const terminal = new VirtualTerminal(80, 8);
			const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, searchSelectAll: true });
			tui.addChild(new Text("transcript", 0, 0));
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[102;6u");
				terminal.sendInput("alpha beta");
				await terminal.waitForRender();
				terminal.sendInput("\x1b[97;6u");
				await terminal.waitForRender();

				terminal.sendInput(input);
				await terminal.waitForRender();

				assert.strictEqual(searchQuery(tui), "alpha beta");
				assert.strictEqual(tui.hasActiveSelection(), true);
			} finally {
				tui.stop();
			}
		});
	}

	it("keeps a search selection when Backspace is explicitly unbound", async () => {
		const previous = getKeybindings();
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, searchSelectAll: true });
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.deleteCharBackward": [] }));
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("alpha beta");
			await terminal.waitForRender();
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();

			terminal.sendInput("\x7f");
			await terminal.waitForRender();

			assert.strictEqual(searchQuery(tui), "alpha beta");
			assert.strictEqual(tui.hasActiveSelection(), true);
		} finally {
			tui.stop();
			setKeybindings(previous);
		}
	});

	it("does not preempt a custom Shift+Backspace binding through the shared selection route", async () => {
		const previous = getKeybindings();
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, searchSelectAll: true });
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.deleteWordBackward": "shift+backspace",
				"tui.editor.deleteCharBackward": [],
			}),
		);
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("alpha beta");
			await terminal.waitForRender();
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();

			terminal.sendInput("\x1b[127;2u");
			await terminal.waitForRender();

			assert.strictEqual(searchQuery(tui), "alpha ");
		} finally {
			tui.stop();
			setKeybindings(previous);
		}
	});

	it("commits a split search paste as one replacement and one undo unit", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, searchSelectAll: true });
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("alpha beta");
			await terminal.waitForRender();
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();

			terminal.sendInput("\x1b[200~");
			await terminal.waitForRender();
			assert.strictEqual(searchQuery(tui), "alpha beta");
			assert.strictEqual(tui.hasActiveSelection(), true);
			terminal.sendInput("X");
			await terminal.waitForRender();
			assert.strictEqual(searchQuery(tui), "alpha beta");
			terminal.sendInput("\x1b[201~");
			await terminal.waitForRender();
			assert.strictEqual(searchQuery(tui), "X");
			assert.strictEqual(tui.hasActiveSelection(), false);

			terminal.sendInput("\x1b[45;5u");
			await terminal.waitForRender();
			assert.strictEqual(searchQuery(tui), "alpha beta");
		} finally {
			tui.stop();
		}
	});

	it("commits a split editor paste as one replacement and one undo unit", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
		const editor = new Editor(tui, editorTheme);
		editor.setText("alpha beta");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();

			terminal.sendInput("\x1b[200~");
			await terminal.waitForRender();
			assert.strictEqual(editor.getText(), "alpha beta");
			assert.strictEqual(tui.hasActiveSelection(), true);
			terminal.sendInput("X");
			await terminal.waitForRender();
			assert.strictEqual(editor.getText(), "alpha beta");
			terminal.sendInput("\x1b[201~");
			await terminal.waitForRender();
			assert.strictEqual(editor.getText(), "X");
			assert.strictEqual(tui.hasActiveSelection(), false);

			terminal.sendInput("\x1f");
			await terminal.waitForRender();
			assert.strictEqual(editor.getText(), "alpha beta");
		} finally {
			tui.stop();
		}
	});

	it("replaces an editor selection with a normalized large paste in one change and undo unit", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
		const editor = new Editor(tui, editorTheme);
		editor.setText("alpha beta");
		const pasteLines = Array.from({ length: 12 }, (_, index) => `line${index}`);
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		let changes = 0;
		editor.onChange = () => {
			changes += 1;
		};
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();
			terminal.sendInput(`\x1b[200~${pasteLines.join("\r\n")}\x1b[201~`);
			await terminal.waitForRender();

			assert.strictEqual(editor.getText(), "[paste #1 +12 lines]");
			assert.strictEqual(editor.getExpandedText(), pasteLines.join("\n"));
			assert.strictEqual(changes, 1);
			terminal.sendInput("\x1f");
			await terminal.waitForRender();
			assert.strictEqual(editor.getText(), "alpha beta");
		} finally {
			tui.stop();
		}
	});

	it("does not expand a literal marker that replaces its deleted editor selection", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
		const editor = new Editor(tui, editorTheme);
		const paste = Array.from({ length: 12 }, (_, index) => `alpha${index}`).join("\n");
		editor.setText("");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput(`\x1b[200~${paste}\x1b[201~`);
			await terminal.waitForRender();
			const marker = editor.getText();
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();
			terminal.sendInput("[paste #1]");
			await terminal.waitForRender();

			assert.strictEqual(editor.getText(), "[paste #1]");
			assert.strictEqual(editor.getExpandedText(), "[paste #1]");
			terminal.sendInput("\x1f");
			await terminal.waitForRender();
			assert.strictEqual(editor.getText(), marker);
			assert.strictEqual(editor.getExpandedText(), paste);
		} finally {
			tui.stop();
		}
	});

	it("highlights the last visible editor line completely after scrolling and select-all", async () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false, editorSelection: true });
		const editor = new Editor(tui, editorTheme);
		editor.setText("one\ntwo\nthree\nfour\nfive\nlast-line");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();
			const row = terminal.getViewport().findIndex((line) => line.includes("last-line"));
			assert.ok(row >= 0);
			assert.strictEqual(highlightedText(tui.getScreenLines()[row]!).join(""), "last-line ");
		} finally {
			tui.stop();
		}
	});

	for (const origin of ["left padding", "top border"] as const) {
		it(`clamps the editor selection's visual start when dragging from ${origin}`, async () => {
			const terminal = new VirtualTerminal(20, 8);
			const copied: string[] = [];
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copyOnSelect: false,
				editorSelection: true,
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			const editor = new Editor(tui, editorTheme, { paddingX: 2 });
			editor.setText("abc");
			tui.setLayoutRoot(editor);
			tui.setFocus(editor);
			editor.focused = false;
			tui.start();
			try {
				await terminal.waitForRender();
				const viewport = terminal.getViewport();
				const row = viewport.findIndex((line) => line.includes("abc"));
				assert.ok(row > 0);
				const textStart = viewport[row]!.indexOf("abc");
				const startX = origin === "left padding" ? 0 : textStart + 1;
				const startY = origin === "top border" ? row - 1 : row;
				const endX = textStart + 1;
				terminal.sendInput(`\x1b[<0;${startX + 1};${startY + 1}M`);
				terminal.sendInput(`\x1b[<32;${endX + 1};${row + 1}M`);
				terminal.sendInput(`\x1b[<0;${endX + 1};${row + 1}m`);
				await terminal.waitForRender();

				assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
				assert.deepStrictEqual(copied, ["ab"]);
				assert.deepStrictEqual(highlightedText(tui.getScreenLines()[row]!), ["ab"]);
				if (origin === "top border") {
					assert.deepStrictEqual(highlightedText(tui.getScreenLines()[row - 1]!), []);
				}
			} finally {
				tui.stop();
			}
		});
	}

	for (const query of ["你", "🙂"]) {
		it(`selects a wide editor grapheme across both cells: ${query}`, async () => {
			const terminal = new VirtualTerminal(20, 8);
			const copied: string[] = [];
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copyOnSelect: false,
				editorSelection: true,
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			const editor = new Editor(tui, editorTheme, { paddingX: 2 });
			editor.setText(query);
			tui.setLayoutRoot(editor);
			tui.start();
			try {
				await terminal.waitForRender();
				const row = terminal.getViewport().findIndex((line) => line.includes(query));
				assert.ok(row >= 0);
				const start = terminal.getViewport()[row]!.indexOf(query);
				terminal.sendInput(`\x1b[<0;${start + 1};${row + 1}M`);
				terminal.sendInput(`\x1b[<32;${start + 2};${row + 1}M`);
				terminal.sendInput(`\x1b[<0;${start + 2};${row + 1}m`);
				await terminal.waitForRender();
				assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
				assert.deepStrictEqual(copied, [query]);

				tui.resetTextSelection();
				terminal.sendInput(`\x1b[<0;${start + 2};${row + 1}M`);
				terminal.sendInput(`\x1b[<32;${start + 1};${row + 1}M`);
				terminal.sendInput(`\x1b[<0;${start + 1};${row + 1}m`);
				await terminal.waitForRender();
				assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
				assert.deepStrictEqual(copied, [query, query]);

				tui.resetTextSelection();
				terminal.sendInput(`\x1b[<0;${start + 2};${row + 1}M`);
				terminal.sendInput(`\x1b[<32;${start + 1};${row + 1}M`);
				terminal.sendInput(`\x1b[<32;${start + 2};${row + 1}M`);
				terminal.sendInput(`\x1b[<0;${start + 2};${row + 1}m`);
				await terminal.waitForRender();
				assert.strictEqual(tui.hasActiveSelection(), false);
				assert.strictEqual(await tui.copyActiveSelectionToClipboard(), false);
			} finally {
				tui.stop();
			}
		});

		it(`selects a wide search grapheme across both cells: ${query}`, async () => {
			const terminal = new VirtualTerminal(30, 8);
			const copied: string[] = [];
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copyOnSelect: false,
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			tui.addChild(new Text("transcript", 0, 0));
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[102;6u");
				terminal.sendInput(query);
				await terminal.waitForRender();
				const row = terminal.getViewport().findIndex((line) => line.includes(query));
				assert.ok(row >= 0);
				const start = terminal.getViewport()[row]!.indexOf(query);
				terminal.sendInput(`\x1b[<0;${start + 1};${row + 1}M`);
				terminal.sendInput(`\x1b[<32;${start + 2};${row + 1}M`);
				terminal.sendInput(`\x1b[<0;${start + 2};${row + 1}m`);
				await terminal.waitForRender();
				assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
				assert.deepStrictEqual(copied, [query]);
			} finally {
				tui.stop();
			}
		});
	}

	it("keeps transcript and editor drag selection in the anchor's mode in both directions", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, editorTheme, { paddingX: 1 });
		editor.setText("abc");
		tui.setLayoutRoot(new VStack([new Text("transcript", 0, 0), editor]));
		tui.start();
		try {
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const transcriptRow = viewport.findIndex((line) => line.includes("transcript"));
			const editorRow = viewport.findIndex((line) => line.includes("abc"));
			assert.ok(transcriptRow >= 0);
			assert.ok(editorRow > transcriptRow);
			const editorStart = viewport[editorRow]!.indexOf("abc");

			terminal.sendInput(`\x1b[<0;1;${transcriptRow + 1}M`);
			terminal.sendInput(`\x1b[<32;${editorStart + 3};${editorRow + 1}M`);
			terminal.sendInput(`\x1b[<0;${editorStart + 3};${editorRow + 1}m`);
			await terminal.waitForRender();
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.ok(copied[0]?.startsWith("transcript\n"), copied[0]);
			assert.ok(copied[0]?.includes("abc"), copied[0]);

			tui.resetTextSelection();
			terminal.sendInput(`\x1b[<0;${editorStart + 4};${editorRow + 1}M`);
			terminal.sendInput(`\x1b[<32;1;${transcriptRow + 1}M`);
			terminal.sendInput(`\x1b[<0;1;${transcriptRow + 1}m`);
			await terminal.waitForRender();
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied.at(-1), "abc");
		} finally {
			tui.stop();
		}
	});

	it("keeps the press selection mode across the search border in both directions", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("hello");
			await terminal.waitForRender();
			const row = terminal.getViewport().findIndex((line) => line.includes("hello"));
			assert.ok(row >= 0);
			const line = terminal.getViewport()[row]!;
			const queryStart = line.indexOf("hello");
			const rightBorder = line.lastIndexOf("│");
			assert.ok(queryStart >= 0);
			assert.ok(rightBorder > queryStart);

			terminal.sendInput(`\x1b[<0;${queryStart + 1};${row}M`);
			terminal.sendInput(`\x1b[<32;${queryStart + 5};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${queryStart + 5};${row + 1}m`);
			await terminal.waitForRender();
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["\nhello"]);

			tui.resetTextSelection();
			terminal.sendInput(`\x1b[<0;${queryStart + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${rightBorder + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${rightBorder + 1};${row + 1}m`);
			await terminal.waitForRender();
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["\nhello", "hello"]);
		} finally {
			tui.stop();
		}
	});

	for (let width = 1; width <= 4; width++) {
		it(`selects and deletes the complete search query at ${width} column`, async () => {
			const terminal = new VirtualTerminal(width, 5);
			const copied: string[] = [];
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copyOnSelect: false,
				searchSelectAll: true,
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			tui.addChild(new Text("transcript", 0, 0));
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[102;6u");
				terminal.sendInput("abcd");
				await terminal.waitForRender();
				terminal.sendInput("\x1b[97;6u");
				await terminal.waitForRender();
				assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true, `width ${width}`);
				assert.deepStrictEqual(copied, ["abcd"]);
				terminal.sendInput("\x7f");
				await terminal.waitForRender();
				assert.strictEqual(searchQuery(tui), "");
			} finally {
				tui.stop();
			}
		});
	}

	it("supports select-all for a directly mounted Input", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const input = new Input({ prompt: "" });
		input.setValue("abcd");
		tui.setLayoutRoot(input);
		tui.setFocus(input);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["abcd"]);
			terminal.sendInput("\x7f");
			await terminal.waitForRender();
			assert.strictEqual(input.getValue(), "");
		} finally {
			tui.stop();
		}
	});

	it("supports drag, triple-click, and deletion for a directly mounted Input", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const input = new Input({ prompt: "" });
		input.setValue("abcd");
		tui.setLayoutRoot(input);
		tui.setFocus(input);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;2;1M");
			terminal.sendInput("\x1b[<32;4;1M");
			terminal.sendInput("\x1b[<0;4;1m");
			await terminal.waitForRender();
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["bcd"]);
			terminal.sendInput("\x7f");
			await terminal.waitForRender();
			assert.strictEqual(input.getValue(), "a");

			input.setValue("abcd");
			tui.requestRender();
			await terminal.waitForRender();
			for (let click = 0; click < 3; click++) {
				terminal.sendInput("\x1b[<0;2;1M");
				terminal.sendInput("\x1b[<0;2;1m");
			}
			await terminal.waitForRender();
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["bcd", "abcd"]);
			terminal.sendInput("\x1b[3~");
			await terminal.waitForRender();
			assert.strictEqual(input.getValue(), "");
		} finally {
			tui.stop();
		}
	});

	for (const enabled of [false, true]) {
		it(`keeps activeSearch focus policy for direct Input with editorSelection ${enabled}`, async () => {
			const terminal = new VirtualTerminal(30, 8);
			const copied: string[] = [];
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copyOnSelect: false,
				editorSelection: enabled,
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			const input = new Input({ prompt: "" });
			input.setValue("abcd");
			tui.addChild(input);
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[102;6u");
				await terminal.waitForRender();
				if (enabled) {
					terminal.sendInput("\x1b[<0;1;1M");
					terminal.sendInput("\x1b[<32;2;1M");
					terminal.sendInput("\x1b[<0;2;1m");
					await terminal.waitForRender();
					assert.ok(tui.getFocusedComponent() instanceof AltScreenSearchComponent);
					assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
					assert.deepStrictEqual(copied, ["ab"]);
					tui.resetTextSelection();
				}

				terminal.sendInput("\x1b[<0;1;1M");
				terminal.sendInput("\x1b[<0;1;1m");
				await terminal.waitForRender();
				assert.strictEqual(tui.getFocusedComponent() instanceof AltScreenSearchComponent, false);
			} finally {
				tui.stop();
			}
		});
	}

	it("bypasses a mouse-aware structural selection target while activeSearch is focused", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const component = new MouseAwareStructuralSelectionFixture();
		tui.setLayoutRoot(new ScrollView(component, { primary: true }));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;2;1M");
			terminal.sendInput("\x1b[<0;2;1m");
			await terminal.waitForRender();

			assert.ok(tui.getFocusedComponent() instanceof AltScreenSearchComponent);
			assert.deepStrictEqual(component.mouseEvents, []);
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["ab"]);
		} finally {
			tui.stop();
		}
	});

	it("uses structural selection capabilities for a non-Editor component", async () => {
		const terminal = new VirtualTerminal(12, 5);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const component = new RichStructuralSelectionFixture();
		tui.setLayoutRoot(component);
		tui.setFocus(component);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["abcd"]);
			terminal.sendInput("\x7f");
			await terminal.waitForRender();
			assert.strictEqual(component.getText(), "");
		} finally {
			tui.stop();
		}
	});

	it("passes select-all input through and preserves selection when the capability is absent", async () => {
		const terminal = new VirtualTerminal(12, 5);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const component = new StructuralSelectionFixture();
		tui.setLayoutRoot(component);
		tui.setFocus(component);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;2;1M");
			terminal.sendInput("\x1b[<0;2;1m");
			await terminal.waitForRender();
			assert.strictEqual(tui.hasActiveSelection(), true);

			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();
			assert.deepStrictEqual(component.inputs, ["\x1b[97;6u"]);
			assert.strictEqual(tui.hasActiveSelection(), true);
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["ab"]);
		} finally {
			tui.stop();
		}
	});

	it("selects the current content line on triple click without a line capability", async () => {
		const terminal = new VirtualTerminal(12, 5);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const component = new StructuralSelectionFixture();
		tui.setLayoutRoot(component);
		tui.start();
		try {
			await terminal.waitForRender();
			for (let click = 0; click < 3; click++) {
				terminal.sendInput("\x1b[<0;2;1M");
				terminal.sendInput("\x1b[<0;2;1m");
			}
			await terminal.waitForRender();
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["abcd"]);
		} finally {
			tui.stop();
		}
	});

	it("invalidates a structural selection without projection after resize", async () => {
		const terminal = new VirtualTerminal(12, 5);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
		});
		const component = new StructuralSelectionFixture();
		tui.setLayoutRoot(component);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;3;1M");
			terminal.sendInput("\x1b[<0;3;1m");
			await terminal.waitForRender();
			assert.strictEqual(tui.hasActiveSelection(), true);
			terminal.resize(8, 5);
			await terminal.waitForRender();
			assert.strictEqual(tui.hasActiveSelection(), false);
		} finally {
			tui.stop();
		}
	});

	it("reprojects an editor selection after resize without truncating its logical text", async () => {
		const terminal = new VirtualTerminal(12, 8);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			editorSelection: true,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, editorTheme, { paddingX: 1 });
		editor.setText("alpha beta gamma");
		tui.setLayoutRoot(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			const row = terminal.getViewport().findIndex((line) => line.includes("gamma"));
			assert.ok(row >= 0);
			const start = terminal.getViewport()[row]!.indexOf("gamma");
			terminal.sendInput(`\x1b[<0;${start + 1};${row + 1}M`);
			terminal.sendInput(`\x1b[<32;${start + 6};${row + 1}M`);
			terminal.sendInput(`\x1b[<0;${start + 6};${row + 1}m`);
			await terminal.waitForRender();
			terminal.resize(30, 8);
			await terminal.waitForRender();
			const resizedRow = terminal.getViewport().findIndex((line) => line.includes("alpha beta gamma"));
			assert.ok(resizedRow >= 0);
			assert.deepStrictEqual(
				highlightedText(tui.getScreenLines()[resizedRow]!).filter((text) => text !== " "),
				["gamma"],
			);
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["gamma"]);

			tui.setFocus(editor);
			terminal.sendInput("\x1b[97;6u");
			await terminal.waitForRender();
			terminal.resize(5, 3);
			await terminal.waitForRender();
			assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
			assert.deepStrictEqual(copied, ["gamma", "alpha beta gamma"]);
		} finally {
			tui.stop();
		}
	});

	it("leaves editor select-all inactive without the editor selection option", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		const editor = new Editor(tui, editorTheme);
		editor.setText("hello");
		tui.setLayoutRoot(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[97;6u");
		terminal.sendInput("\x7f");
		await terminal.waitForRender();
		assert.strictEqual(editor.getText(), "hell");
		tui.stop();
	});
});
