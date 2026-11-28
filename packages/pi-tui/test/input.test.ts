import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";

function click(x: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y: 0,
		screenX: x,
		screenY: 0,
		width: 20,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

describe("Input component", () => {
	it("submits value including backslash on Enter", () => {
		const input = new Input();
		let submitted: string | undefined;

		input.onSubmit = (value) => {
			submitted = value;
		};

		// Type hello, then backslash, then Enter
		input.handleInput("h");
		input.handleInput("e");
		input.handleInput("l");
		input.handleInput("l");
		input.handleInput("o");
		input.handleInput("\\");
		input.handleInput("\r");

		// Input is single-line, no backslash+Enter workaround
		assert.strictEqual(submitted, "hello\\");
	});

	it("inserts backslash as regular character", () => {
		const input = new Input();

		input.handleInput("\\");
		input.handleInput("x");

		assert.strictEqual(input.getValue(), "\\x");
	});

	it("gets and sets cursor position with clamping and grapheme alignment without changing setValue", () => {
		const preserved = new Input();
		preserved.setValue("hello");
		assert.strictEqual(preserved.getCursor(), 0);
		preserved.handleInput("\x7f");
		assert.strictEqual(preserved.getValue(), "hello");

		const ascii = new Input();
		ascii.setValue("hello");
		ascii.setCursor(2);
		assert.strictEqual(ascii.getCursor(), 2);
		ascii.handleInput("\x7f");
		assert.strictEqual(ascii.getValue(), "hllo");
		assert.strictEqual(ascii.getCursor(), 1);
		ascii.setCursor(99);
		assert.strictEqual(ascii.getCursor(), 4);
		ascii.setCursor(-5);
		assert.strictEqual(ascii.getCursor(), 0);
		ascii.setCursor(Number.NaN);
		assert.strictEqual(ascii.getCursor(), 0);
		ascii.setCursor(Number.POSITIVE_INFINITY);
		assert.strictEqual(ascii.getCursor(), 4);
		ascii.handleInput("\x7f");
		assert.strictEqual(ascii.getValue(), "hll");

		const unicode = new Input();
		unicode.setValue("你好🙂a");
		unicode.setCursor(3);
		assert.strictEqual(unicode.getCursor(), 2);
		unicode.setCursor(unicode.getValue().length);
		assert.strictEqual(unicode.getCursor(), 5);
		unicode.handleInput("\x7f");
		assert.strictEqual(unicode.getValue(), "你好🙂");
		unicode.handleInput("\x7f");
		assert.strictEqual(unicode.getValue(), "你好");

		const combining = new Input();
		combining.setValue("e\u0301x");
		combining.setCursor(1);
		assert.strictEqual(combining.getCursor(), 0);
		combining.setCursor(2);
		assert.strictEqual(combining.getCursor(), 2);
	});

	describe("render", () => {
		it("supports a custom prompt and styled placeholder", () => {
			const input = new Input({
				prompt: "",
				placeholder: "Find transcript",
				placeholderStyle: (text) => `\x1b[2m${text}\x1b[22m`,
			});
			input.focused = true;

			const [empty] = input.render(20);
			assert.ok(empty?.includes("\x1b[2m"));
			assert.strictEqual(stripTerminalSequences(empty ?? "").trimEnd(), "Find transcript");

			input.handleInput("n");
			const [populated] = input.render(20);
			assert.strictEqual(stripTerminalSequences(populated ?? "").trimEnd(), "n");
		});

		it("does not overflow with wide CJK and fullwidth text", () => {
			const width = 93;
			const cases = [
				"가나다라마바사아자차카타파하 한글 텍스트가 터미널 너비를 초과하면 크래시가 발생합니다 이것은 재현용 테스트입니다",
				"これはテスト文章です。日本語のテキストが正しく表示されるかどうかを確認するためのサンプルテキストです。あいうえお",
				"这是一段测试文本，用于验证中文字符在终端中的显示宽度是否被正确计算，如果不正确就会导致用户界面崩溃的问题",
				"ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ０１２３４５６７８９ａｂｃｄｅｆｇｈｉｊｋｌｍ",
			];
			const cursorPositions = [
				{ label: "start", move: (_input: Input) => {} },
				{
					label: "middle",
					move: (input: Input) => {
						for (let i = 0; i < 10; i++) input.handleInput("\x1b[C");
					},
				},
				{ label: "end", move: (input: Input) => input.handleInput("\x05") },
			];

			for (const text of cases) {
				for (const { label, move } of cursorPositions) {
					const input = new Input();
					input.setValue(text);
					input.focused = true;
					move(input);

					const [line] = input.render(width);
					assert.ok(line);
					assert.ok(visibleWidth(line) <= width, `rendered line overflowed for ${text} at ${label}`);
				}
			}
		});

		it("keeps the cursor visible when horizontally scrolling wide text", () => {
			const input = new Input();
			const width = 20;
			const text = "가나다라마바사아자차카타파하";
			input.setValue(text);
			input.focused = true;
			input.handleInput("\x01");
			for (let i = 0; i < 5; i++) input.handleInput("\x1b[C");

			const [line] = input.render(width);
			assert.ok(line);
			assert.ok(visibleWidth(line) <= width);
		});
	});

	describe("selection editing", () => {
		it("maps empty content and narrow renders without exposing hidden text", () => {
			const empty = new Input({ prompt: "Find: " });
			empty.render(20);
			assert.deepStrictEqual(empty.getRenderedValueRange(), { start: 6, end: 6 });
			assert.deepStrictEqual(empty.getClosestSelectionPoint(0, 20), {
				row: 0,
				col: 6,
				offset: 0,
				endOffset: 0,
				boundary: true,
			});
			assert.strictEqual(empty.getSelectionColumnForOffset(0), 6);
			assert.strictEqual(empty.getSelectionText(0, 0), "");

			const narrow = new Input({ prompt: "Find: " });
			narrow.setValue("你");
			narrow.render(3);
			assert.deepStrictEqual(narrow.getRenderedValueRange(), { start: 3, end: 3 });
			assert.deepStrictEqual(narrow.getSelectionOffsets(0, 3), { start: 0, end: 0 });
			assert.strictEqual(narrow.getSelectionColumnForOffset(0), 3);
			assert.strictEqual(narrow.getSelectionColumnForOffset(1), undefined);
			assert.deepStrictEqual(narrow.getClosestSelectionPoint(0, 99), {
				row: 0,
				col: 3,
				offset: 0,
				endOffset: 0,
				boundary: true,
			});
		});

		it("clamps selection points before and after the single line", () => {
			const input = new Input({ prompt: "" });
			input.setValue("ab");
			input.render(10);
			assert.deepStrictEqual(input.getClosestSelectionPoint(-1, 9), {
				row: 0,
				col: 0,
				offset: 0,
				endOffset: 0,
			});
			assert.deepStrictEqual(input.getClosestSelectionPoint(1, -9), {
				row: 0,
				col: 2,
				offset: 2,
				endOffset: 2,
				boundary: true,
			});
			assert.deepStrictEqual(input.getClosestSelectionPoint(0, -4), {
				row: 0,
				col: 0,
				offset: 0,
				endOffset: 0,
			});
			assert.deepStrictEqual(input.getClosestSelectionPoint(0, 99), {
				row: 0,
				col: 2,
				offset: 2,
				endOffset: 2,
				boundary: true,
			});
			assert.strictEqual(input.getSelectionOffsets(-1, 0), undefined);
			assert.strictEqual(input.getSelectionOffsets(1, 0), undefined);
			assert.strictEqual(input.getSelectionContentStart(-1), undefined);
			assert.strictEqual(input.getSelectionContentEnd(1), undefined);
		});

		it("maps wide and combining graphemes to UTF-16 offset ranges", () => {
			const input = new Input({ prompt: ":" });
			input.setValue("A你e\u0301🙂B");
			input.render(30);
			assert.deepStrictEqual(input.getRenderedValueRange(), { start: 1, end: 8 });
			assert.deepStrictEqual(input.getSelectionOffsets(0, 2), { start: 1, end: 2 });
			assert.deepStrictEqual(input.getSelectionOffsets(0, 3), { start: 1, end: 2 });
			assert.deepStrictEqual(input.getSelectionOffsets(0, 4), { start: 2, end: 4 });
			assert.deepStrictEqual(input.getSelectionOffsets(0, 5), { start: 4, end: 6 });
			assert.deepStrictEqual(input.getSelectionOffsets(0, 6), { start: 4, end: 6 });
			assert.deepStrictEqual(input.getSelectionOffsets(0, 7), { start: 6, end: 7 });
			assert.strictEqual(input.getSelectionColumnForOffset(2), 4);
			assert.strictEqual(input.getSelectionColumnForOffset(4), 5);
			assert.strictEqual(input.getSelectionColumnForOffset(6), 7);
			assert.strictEqual(input.getSelectionText(1, 6), "你e\u0301🙂");
		});

		it("maps only the horizontally visible window in both directions", () => {
			const input = new Input({ prompt: "" });
			input.setValue("abcdefgh");
			input.moveCursorToOffset(8);
			input.render(4);
			assert.strictEqual(input.getRenderedValueRange().start, 0);
			assert.strictEqual(input.getRenderedValueRange().end, 3);
			assert.deepStrictEqual(input.getSelectionOffsets(0, 0), { start: 5, end: 5 });
			assert.deepStrictEqual(input.getSelectionOffsets(0, 1), { start: 6, end: 7 });
			assert.deepStrictEqual(input.getSelectionOffsets(0, 3), { start: 8, end: 8 });
			assert.strictEqual(input.getSelectionColumnForOffset(-1), undefined);
			assert.strictEqual(input.getSelectionColumnForOffset(4), undefined);
			assert.strictEqual(input.getSelectionColumnForOffset(5), 0);
			assert.strictEqual(input.getSelectionColumnForOffset(8), 3);
			assert.strictEqual(input.getSelectionColumnForOffset(99), 3);
		});

		it("uses the aligned grapheme start after horizontal scrolling", () => {
			const input = new Input({ prompt: "" });
			input.setValue("a你bcdef");
			input.moveCursorToOffset(3);
			input.render(4);
			assert.deepStrictEqual(input.getRenderedValueRange(), { start: 0, end: 3 });
			assert.deepStrictEqual(input.getSelectionOffsets(0, 0), { start: 2, end: 2 });
			assert.deepStrictEqual(input.getSelectionOffsets(0, 1), { start: 3, end: 4 });
			assert.strictEqual(input.getSelectionColumnForOffset(1), undefined);
			assert.strictEqual(input.getSelectionColumnForOffset(2), 0);
			assert.strictEqual(input.getSelectionColumnForOffset(5), 3);
			assert.strictEqual(input.getSelectionColumnForOffset(6), undefined);
		});

		it("round-trips grapheme offsets with both affinities", () => {
			const input = new Input({ prompt: ":" });
			input.setValue("A你e\u0301🙂B");
			input.render(30);

			assert.deepStrictEqual(input.getSelectionPointForOffset(3, "backward"), { row: 0, col: 4, offset: 3 });
			assert.deepStrictEqual(input.getSelectionPointForOffset(3, "forward"), { row: 0, col: 5, offset: 3 });
			assert.deepStrictEqual(input.getSelectionPointForOffset(5, "backward"), { row: 0, col: 5, offset: 5 });
			assert.deepStrictEqual(input.getSelectionPointForOffset(5, "forward"), { row: 0, col: 7, offset: 5 });
			for (const offset of [0, 1, 2, 4, 6, 7]) {
				const point = input.getSelectionPointForOffset(offset, "backward");
				assert.ok(point);
				assert.strictEqual(input.getSelectionOffsets(point.row, point.col)?.start, offset);
			}
		});

		it("clamps hidden logical offsets only for projection", () => {
			const input = new Input({ prompt: "" });
			input.setValue("abcdefgh");
			input.moveCursorToOffset(8);
			input.render(4);

			assert.deepStrictEqual(input.getSelectionPointForOffset(0, "forward"), { row: 0, col: 0, offset: 0 });
			assert.deepStrictEqual(input.getSelectionPointForOffset(4, "forward"), { row: 0, col: 0, offset: 4 });
			assert.deepStrictEqual(input.getSelectionPointForOffset(5, "forward"), { row: 0, col: 0, offset: 5 });
			assert.deepStrictEqual(input.getSelectionPointForOffset(8, "backward"), { row: 0, col: 3, offset: 8 });
			assert.deepStrictEqual(input.getSelectionPointForOffset(99, "backward"), { row: 0, col: 3, offset: 8 });
			assert.strictEqual(input.getSelectionColumnForOffset(4), undefined);
			assert.strictEqual(input.getSelectionText(0, 4), "abcd");
		});

		it("selects the full logical line while projecting to the visible window", () => {
			const input = new Input({ prompt: "" });
			input.setValue("abcdefgh");
			input.moveCursorToOffset(8);
			input.render(4);
			const expected = {
				start: { row: 0, col: 0, offset: 0 },
				end: { row: 0, col: 3, offset: 8, boundary: true },
			};

			assert.deepStrictEqual(input.getLineSelection(0), expected);
			assert.deepStrictEqual(input.getSelectAllSelection(), expected);
			assert.strictEqual(input.getLineSelection(-1), undefined);
			assert.strictEqual(input.getLineSelection(1), undefined);
		});

		it("moves the cursor to clamped logical offsets", () => {
			const input = new Input({ prompt: "" });
			input.setValue("abc");
			input.moveCursorToOffset(-1);
			input.handleInput("X");
			assert.strictEqual(input.getValue(), "Xabc");
			input.moveCursorToOffset(99);
			input.handleInput("Y");
			assert.strictEqual(input.getValue(), "XabcY");
			input.moveCursorToOffset(2);
			input.handleInput("Z");
			assert.strictEqual(input.getValue(), "XaZbcY");
		});

		it("uses grapheme offset mapping for single clicks", () => {
			const input = new Input();
			input.setValue("A你B");
			input.render(20);
			assert.strictEqual(input.handleMouse({ ...click(3), type: "press" }), undefined);
			assert.strictEqual(input.handleMouse({ ...click(3), clickCount: 2 }), undefined);
			assert.deepStrictEqual(input.handleMouse(click(3)), { handled: true, focus: true });
			input.handleInput("X");
			assert.strictEqual(input.getValue(), "AX你B");
		});

		it("deletes a logical grapheme range", () => {
			const input = new Input();
			input.setValue("A你e\u0301B");
			assert.strictEqual(input.deleteSelection(1, 4), true);
			assert.strictEqual(input.getValue(), "AB");
			assert.strictEqual(input.deleteSelection(4, 1), false);
		});

		it("treats Shift+Backspace like Backspace", () => {
			const input = new Input();
			input.setValue("ab");
			input.moveCursorToOffset(2);
			input.handleInput("\x1b[127;2u");
			assert.strictEqual(input.getValue(), "a");
		});

		it("inserts shifted modifyOtherKeys letters as text", () => {
			const input = new Input();
			input.handleInput("\x1b[27;2;69~");
			assert.strictEqual(input.getValue(), "E");
		});

		it("rejects a mixed printable and control input block", () => {
			const input = new Input();
			input.setValue("before");
			input.handleInput("new\nvalue");
			assert.strictEqual(input.getValue(), "before");
		});

		it("honors explicit word deletion and disabled character deletion for Shift+Backspace", () => {
			const previous = getKeybindings();
			const input = new Input();
			input.setValue("alpha beta");
			input.moveCursorToOffset(input.getValue().length);
			setKeybindings(
				new KeybindingsManager(TUI_KEYBINDINGS, {
					"tui.editor.deleteWordBackward": "shift+backspace",
					"tui.editor.deleteCharBackward": [],
				}),
			);
			try {
				input.handleInput("\x1b[127;2u");
				assert.strictEqual(input.getValue(), "alpha ");
			} finally {
				setKeybindings(previous);
			}
		});

		it("does not retain a hardcoded Shift+Backspace fallback when deletion is unbound", () => {
			const previous = getKeybindings();
			const input = new Input();
			input.setValue("ab");
			input.moveCursorToOffset(2);
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.deleteCharBackward": [] }));
			try {
				input.handleInput("\x1b[127;2u");
				assert.strictEqual(input.getValue(), "ab");
			} finally {
				setKeybindings(previous);
			}
		});

		it("does not use a stale selection generation when a split paste completes", () => {
			const input = new Input();
			input.setValue("alpha beta");
			input.moveCursorToOffset(input.getValue().length);

			assert.deepStrictEqual(
				input.handleSelectionInput("\x1b[200~", { start: 6, end: 11, generation: 1 }),
				{ handled: true, clearSelection: false },
			);
			assert.deepStrictEqual(
				input.handleSelectionInput("X", { start: 0, end: 5, generation: 2 }),
				{ handled: true, clearSelection: false },
			);
			assert.deepStrictEqual(
				input.handleSelectionInput("\x1b[201~", { start: 0, end: 5, generation: 2 }),
				{ handled: true, clearSelection: false },
			);
			assert.strictEqual(input.getValue(), "alpha betaX");
		});

		it("does not use a pending selection after a split paste leaves selection dispatch", () => {
			const input = new Input();
			input.setValue("alpha beta");
			input.moveCursorToOffset(input.getValue().length);

			assert.deepStrictEqual(
				input.handleSelectionInput("\x1b[200~", { start: 6, end: 11, generation: 1 }),
				{ handled: true, clearSelection: false },
			);
			input.moveCursorToOffset(0);
			input.handleInput("X\x1b[201~");

			assert.strictEqual(input.getValue(), "Xalpha beta");
		});
	});

	describe("Kill ring", () => {
		it("Ctrl+W saves deleted text to kill ring and Ctrl+Y yanks it", () => {
			const input = new Input();

			input.setValue("foo bar baz");
			// Move cursor to end
			input.handleInput("\x05"); // Ctrl+E

			input.handleInput("\x17"); // Ctrl+W - deletes "baz"
			assert.strictEqual(input.getValue(), "foo bar ");

			// Move to beginning and yank
			input.handleInput("\x01"); // Ctrl+A
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "bazfoo bar ");
		});

		it("Ctrl+W preserves ASCII punctuation boundaries", () => {
			const input = new Input();

			input.setValue("foo.bar");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "bar"
			assert.strictEqual(input.getValue(), "foo.");

			input.setValue("foo:bar");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "bar"
			assert.strictEqual(input.getValue(), "foo:");
		});

		it("Ctrl+W handles Unicode word boundaries", () => {
			const input = new Input();

			// "你好世界。你好，世界" segments as: 你好|世界|。|你好|，|世界
			input.setValue("你好世界。你好，世界");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "世界"
			assert.strictEqual(input.getValue(), "你好世界。你好，");
			input.handleInput("\x17"); // Ctrl+W - deletes "，"
			assert.strictEqual(input.getValue(), "你好世界。你好");
			input.handleInput("\x17"); // Ctrl+W - deletes "你好"
			assert.strictEqual(input.getValue(), "你好世界。");
			input.handleInput("\x17"); // Ctrl+W - deletes "。"
			assert.strictEqual(input.getValue(), "你好世界");
			input.handleInput("\x17"); // Ctrl+W - deletes "世界"
			assert.strictEqual(input.getValue(), "你好");
			input.handleInput("\x17"); // Ctrl+W - deletes "你好"
			assert.strictEqual(input.getValue(), "");
		});

		it("Ctrl+U saves deleted text to kill ring", () => {
			const input = new Input();

			input.setValue("hello world");
			// Move cursor to after "hello "
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x15"); // Ctrl+U - deletes "hello "
			assert.strictEqual(input.getValue(), "world");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("Ctrl+K saves deleted text to kill ring", () => {
			const input = new Input();

			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A
			input.handleInput("\x0b"); // Ctrl+K - deletes "hello world"

			assert.strictEqual(input.getValue(), "");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("Ctrl+Y does nothing when kill ring is empty", () => {
			const input = new Input();

			input.setValue("test");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "test");
		});

		it("Alt+Y cycles through kill ring after Ctrl+Y", () => {
			const input = new Input();

			// Create kill ring with multiple entries
			input.setValue("first");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "first"
			input.setValue("second");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "second"
			input.setValue("third");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "third"

			assert.strictEqual(input.getValue(), "");

			input.handleInput("\x19"); // Ctrl+Y - yanks "third"
			assert.strictEqual(input.getValue(), "third");

			input.handleInput("\x1by"); // Alt+Y - cycles to "second"
			assert.strictEqual(input.getValue(), "second");

			input.handleInput("\x1by"); // Alt+Y - cycles to "first"
			assert.strictEqual(input.getValue(), "first");

			input.handleInput("\x1by"); // Alt+Y - cycles back to "third"
			assert.strictEqual(input.getValue(), "third");
		});

		it("Alt+Y does nothing if not preceded by yank", () => {
			const input = new Input();

			input.setValue("test");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "test"
			input.setValue("other");
			input.handleInput("\x05"); // Ctrl+E

			// Type something to break the yank chain
			input.handleInput("x");
			assert.strictEqual(input.getValue(), "otherx");

			input.handleInput("\x1by"); // Alt+Y - should do nothing
			assert.strictEqual(input.getValue(), "otherx");
		});

		it("Alt+Y does nothing if kill ring has one entry", () => {
			const input = new Input();

			input.setValue("only");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "only"

			input.handleInput("\x19"); // Ctrl+Y - yanks "only"
			assert.strictEqual(input.getValue(), "only");

			input.handleInput("\x1by"); // Alt+Y - should do nothing
			assert.strictEqual(input.getValue(), "only");
		});

		it("consecutive Ctrl+W accumulates into one kill ring entry", () => {
			const input = new Input();

			input.setValue("one two three");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "three"
			input.handleInput("\x17"); // Ctrl+W - deletes "two "
			input.handleInput("\x17"); // Ctrl+W - deletes "one "

			assert.strictEqual(input.getValue(), "");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "one two three");
		});

		it("non-delete actions break kill accumulation", () => {
			const input = new Input();

			input.setValue("foo bar baz");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "baz"
			assert.strictEqual(input.getValue(), "foo bar ");

			input.handleInput("x"); // Typing breaks accumulation
			assert.strictEqual(input.getValue(), "foo bar x");

			input.handleInput("\x17"); // Ctrl+W - deletes "x" (separate entry)
			assert.strictEqual(input.getValue(), "foo bar ");

			input.handleInput("\x19"); // Ctrl+Y - most recent is "x"
			assert.strictEqual(input.getValue(), "foo bar x");

			input.handleInput("\x1by"); // Alt+Y - cycle to "baz"
			assert.strictEqual(input.getValue(), "foo bar baz");
		});

		it("non-yank actions break Alt+Y chain", () => {
			const input = new Input();

			input.setValue("first");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W
			input.setValue("second");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W
			input.setValue("");

			input.handleInput("\x19"); // Ctrl+Y - yanks "second"
			assert.strictEqual(input.getValue(), "second");

			input.handleInput("x"); // Breaks yank chain
			assert.strictEqual(input.getValue(), "secondx");

			input.handleInput("\x1by"); // Alt+Y - should do nothing
			assert.strictEqual(input.getValue(), "secondx");
		});

		it("kill ring rotation persists after cycling", () => {
			const input = new Input();

			input.setValue("first");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // deletes "first"
			input.setValue("second");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // deletes "second"
			input.setValue("third");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // deletes "third"
			input.setValue("");

			input.handleInput("\x19"); // Ctrl+Y - yanks "third"
			input.handleInput("\x1by"); // Alt+Y - cycles to "second"
			assert.strictEqual(input.getValue(), "second");

			// Break chain and start fresh
			input.handleInput("x");
			input.setValue("");

			// New yank should get "second" (now at end after rotation)
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "second");
		});

		it("backward deletions prepend, forward deletions append during accumulation", () => {
			const input = new Input();

			input.setValue("prefix|suffix");
			// Position cursor at "|"
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C"); // Move right 6

			input.handleInput("\x0b"); // Ctrl+K - deletes "|suffix" (forward)
			assert.strictEqual(input.getValue(), "prefix");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "prefix|suffix");
		});

		it("Alt+D deletes word forward and saves to kill ring", () => {
			const input = new Input();

			input.setValue("hello world test");
			input.handleInput("\x01"); // Ctrl+A

			input.handleInput("\x1bd"); // Alt+D - deletes "hello"
			assert.strictEqual(input.getValue(), " world test");

			input.handleInput("\x1bd"); // Alt+D - deletes " world"
			assert.strictEqual(input.getValue(), " test");

			// Yank should get accumulated text
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello world test");
		});

		it("Alt+D preserves ASCII punctuation boundaries", () => {
			const input = new Input();

			input.setValue("foo.bar baz");
			input.handleInput("\x01"); // Ctrl+A
			input.handleInput("\x1bd"); // Alt+D - deletes "foo"
			assert.strictEqual(input.getValue(), ".bar baz");
			input.handleInput("\x1bd"); // Alt+D - deletes "."
			assert.strictEqual(input.getValue(), "bar baz");
			input.handleInput("\x1bd"); // Alt+D - deletes "bar"
			assert.strictEqual(input.getValue(), " baz");
		});

		it("Alt+D handles Unicode word boundaries", () => {
			const input = new Input();

			// "你好世界。你好，世界" segments as: 你好|世界|。|你好|，|世界
			input.setValue("你好世界。你好，世界");
			input.handleInput("\x01"); // Ctrl+A
			input.handleInput("\x1bd"); // Alt+D - deletes "你好"
			assert.strictEqual(input.getValue(), "世界。你好，世界");
			input.handleInput("\x1bd"); // Alt+D - deletes "世界"
			assert.strictEqual(input.getValue(), "。你好，世界");
			input.handleInput("\x1bd"); // Alt+D - deletes "。"
			assert.strictEqual(input.getValue(), "你好，世界");
			input.handleInput("\x1bd"); // Alt+D - deletes "你好"
			assert.strictEqual(input.getValue(), "，世界");
			input.handleInput("\x1bd"); // Alt+D - deletes "，"
			assert.strictEqual(input.getValue(), "世界");
			input.handleInput("\x1bd"); // Alt+D - deletes "世界"
			assert.strictEqual(input.getValue(), "");
		});

		it("handles yank in middle of text", () => {
			const input = new Input();

			input.setValue("word");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "word"
			input.setValue("hello world");
			// Move to middle (after "hello ")
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello wordworld");
		});

		it("handles yank-pop in middle of text", () => {
			const input = new Input();

			// Create two kill ring entries
			input.setValue("FIRST");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "FIRST"
			input.setValue("SECOND");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "SECOND"

			// Set up "hello world" and position cursor after "hello "
			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x19"); // Ctrl+Y - yanks "SECOND"
			assert.strictEqual(input.getValue(), "hello SECONDworld");

			input.handleInput("\x1by"); // Alt+Y - replaces with "FIRST"
			assert.strictEqual(input.getValue(), "hello FIRSTworld");
		});
	});

	describe("Undo", () => {
		it("does nothing when undo stack is empty", () => {
			const input = new Input();

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "");
		});

		it("coalesces consecutive word characters into one undo unit", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			assert.strictEqual(input.getValue(), "hello world");

			// Undo removes " world"
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello");

			// Undo removes "hello"
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "");
		});

		it("undoes spaces one at a time", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput(" ");
			assert.strictEqual(input.getValue(), "hello  ");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes second " "
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes first " "
			assert.strictEqual(input.getValue(), "hello");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes "hello"
			assert.strictEqual(input.getValue(), "");
		});

		it("undoes backspace", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput("\x7f"); // Backspace
			assert.strictEqual(input.getValue(), "hell");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello");
		});

		it("undoes forward delete", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput("\x01"); // Ctrl+A - go to start
			input.handleInput("\x1b[C"); // Right arrow
			input.handleInput("\x1b[3~"); // Delete key
			assert.strictEqual(input.getValue(), "hllo");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello");
		});

		it("undoes Ctrl+W (delete word backward)", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			assert.strictEqual(input.getValue(), "hello world");

			input.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes Ctrl+K (delete to line end)", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x0b"); // Ctrl+K
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes Ctrl+U (delete to line start)", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(input.getValue(), "world");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes yank", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("\x17"); // Ctrl+W - delete "hello "
			input.handleInput("\x19"); // Ctrl+Y - yank
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "");
		});

		it("undoes paste atomically", () => {
			const input = new Input();

			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) input.handleInput("\x1b[C");

			// Simulate bracketed paste
			input.handleInput("\x1b[200~beep boop\x1b[201~");
			assert.strictEqual(input.getValue(), "hellobeep boop world");

			// Single undo should restore entire pre-paste state
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes Alt+D (delete word forward)", () => {
			const input = new Input();

			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A

			input.handleInput("\x1bd"); // Alt+D - deletes "hello"
			assert.strictEqual(input.getValue(), " world");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("cursor movement starts new undo unit", () => {
			const input = new Input();

			input.handleInput("a");
			input.handleInput("b");
			input.handleInput("c");
			input.handleInput("\x01"); // Ctrl+A - movement breaks coalescing
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("d");
			input.handleInput("e");
			assert.strictEqual(input.getValue(), "abcde");

			// Undo removes "de" (typed after movement)
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "abc");

			// Undo removes "abc"
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "");
		});
	});
});
