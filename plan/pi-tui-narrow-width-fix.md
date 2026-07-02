# pi-tui 窄终端崩溃修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底修复终端宽度过窄时 kimi-code TUI 崩溃退出的问题（`packages/pi-tui` vendored 库），并用回归测试和文档防止未来 re-vendor 时再次丢失修复。

**Architecture:** 借鉴 oh-my-pi 的"永不崩溃"策略——1 个根因修复（`wordWrapLine` 对不可再分的宽 grapheme 停止递归）+ 2 个集中式咽喉防御（`Container.render` 入口宽度钳制到 ≥1；TUI 写终端前对超宽行统一截断、删除上游的 fail-fast throw）+ 少量组件级负宽度加固。修复全部落在 vendored 源码 `packages/pi-tui/src/`，不改 app 侧。

**Tech Stack:** TypeScript（Node 24 原生跑 TS）、`node --test` + `node:assert`（pi-tui 测试套件不是 vitest）、`VirtualTerminal`（xterm-headless 测试终端）。

---

## 背景与根因（执行者需要知道的全部上下文）

**Bug 现象**：终端拖窄（≤7 列）且输入框有中文/emoji 时，TUI 进程崩溃退出。

**根因链**（均已实测验证）：

1. **主因——栈溢出**：`packages/pi-tui/src/components/editor.ts` 的 `wordWrapLine()`（L114-206）在 L163-179 处理"单个 segment 比 maxWidth 宽"时递归调用自身且参数不变。当 `maxWidth === 1` 且遇到宽字符（CJK/emoji，宽度 2）时无限递归 → `RangeError: Maximum call stack size exceeded`。编辑器 `render(width)`（L464-479）在 width ≤ 7 时会把 `layoutWidth` 压到 1（kimi-code 的 CustomEditor 用 `paddingX: 4`），因此中文用户几乎必现。崩溃被 `uncaughtException` 接住后直接退出进程。
2. **次因——主动 throw**：`packages/pi-tui/src/tui.ts` 差分渲染路径（L1542-1570）对任何"渲染行宽 > 终端宽"的行写崩溃日志并 `throw`（上游的 fail-fast 设计）。窄宽度下 `Text`/`Markdown`/`Box`/`Input`/编辑器溢出 chunk 都可能产出超宽行。注意 `fullRender` 路径没有这个检查，所以炸点在 resize 后第一次差分渲染。
3. **三因——负宽度 repeat**：`text.ts:90`、`markdown.ts:226`、`markdown.ts:464`、`truncated-text.ts:26` 的裸 `" ".repeat(width)` / `"─".repeat(...)` 在负 width 下抛 `RangeError: Invalid count value`。
4. **无下限钳制**：宽度传播链 `terminal.columns`（terminal.ts:465）→ `doRender`（tui.ts:1256）→ `Container.render`（tui.ts:280）全程无 clamp。

**历史教训**：老分支 `origin/fix/tui-narrow-width-crash` 上有过三个修复（`a4188455` 的 pnpm patch 等），从未合入 main；vendor 提交 `7859b0af` 按上游 0.80.2 原样落库后修复彻底丢失。因此本计划包含守护测试（Task 1-5）和分歧文档（Task 6）。

**oh-my-pi 参照**（`/Users/moonshot/Desktop/moonshot/oh-my-pi/packages/tui`，仅供理解，不要复制其代码）：`Container.render` 入口 `Math.max(1, width)`（commit `bb7f28848`）；写终端前 `#prepareLine` 统一截断超宽行、删除上游 throw（`c40a22b3c`、`9ed5a70d0`）；`padding(n)` 对 `n <= 0` 返回空串。

**运行命令**（都在仓库根目录执行）：
- 跑 pi-tui 全部测试：`pnpm --filter @moonshot-ai/pi-tui test`（即 `node --test test/*.test.ts`）
- 跑单个测试文件：`node --test test/editor.test.ts`（cwd 为 `packages/pi-tui`）
- 类型检查：`pnpm --filter @moonshot-ai/pi-tui typecheck`

**范围外（明确不做）**：
- 不改 app 侧（`apps/kimi-code`）的 GutterContainer / CustomEditor——核心修复后它们的超宽输出会被统一截断兜底。
- 不恢复老分支的 pnpm patch 方式——pi-tui 已 vendored，直接改源码。
- 不做 "terminal too small" 提示屏（oh-my-pi 也没做，策略是钳到 1 列 + 截断）。
- 不改 `utils.ts` 的 `wrapSingleLine`/`breakLongWord` 行为（宽度 1 时产出宽度 2 的行，由集中截断兜底）。
- 不单独给 `editor.ts:565` 的行拼接加截断——Task 1 后编辑器在极窄宽度下产出的溢出行（如 w=5 时宽 6）统一由 Task 3 的集中截断兜底，视觉上最多损失最右侧一列，属可接受降级。
- markdown.ts 表格路径的 `"─".repeat(columnWidths)`（L803/823/850）不改——列宽由内容计算，恒为正。

**Git 纪律**：每个 Task 末尾的 commit 步骤需要用户事先明确授权；未授权则跳过所有 commit 步骤，改为最后统一由用户处理。Commit message 用英文、符合 Conventional Commits，不加任何 co-author。

---

### Task 1: `wordWrapLine` 递归守卫（根因修复）

**Files:**
- Modify: `packages/pi-tui/src/components/editor.ts:163-179`
- Test: `packages/pi-tui/test/editor.test.ts`

**原理**：递归 `wordWrapLine(grapheme, maxWidth)` 只有在 segment 含多个 grapheme（如粘贴标记这种原子多字符 segment）时才能取得进展；当 segment 本身就是单个 grapheme（中文字符在 maxWidth=1 时）递归参数不变、永不终止。守卫：单 grapheme 时不递归，把它保留为当前打开的 chunk，允许视觉上溢出 1 列（由 Task 3 的集中截断兜底）。

- [ ] **Step 1: 写失败测试**

在 `packages/pi-tui/test/editor.test.ts` 文件末尾追加（该文件已 import `wordWrapLine`、`assert`、`describe`、`it`）：

```ts
describe("wordWrapLine narrow width", () => {
	it("does not recurse infinitely on a wide grapheme at maxWidth 1", () => {
		const chunks = wordWrapLine("中", 1);
		assert.deepStrictEqual(
			chunks.map((c) => c.text),
			["中"],
		);
	});

	it("splits CJK text into per-grapheme overflow chunks at maxWidth 1", () => {
		const chunks = wordWrapLine("中文文本", 1);
		assert.deepStrictEqual(
			chunks.map((c) => c.text),
			["中", "文", "文", "本"],
		);
		assert.deepStrictEqual(
			chunks.map((c) => [c.startIndex, c.endIndex]),
			[
				[0, 1],
				[1, 2],
				[2, 3],
				[3, 4],
			],
		);
	});

	it("handles mixed narrow and wide graphemes at maxWidth 1", () => {
		const chunks = wordWrapLine("ab中cd", 1);
		assert.deepStrictEqual(
			chunks.map((c) => c.text),
			["a", "b", "中", "c", "d"],
		);
	});

	it("still re-wraps multi-grapheme atomic segments at narrow widths", () => {
		// 粘贴标记以单个原子 segment 传入（preSegmented），内部仍可按
		// grapheme 拆分，递归必须保留这个能力。
		const marker = "[paste #1]";
		const preSegmented: Intl.SegmentData[] = [{ segment: marker, index: 0, input: marker }];
		const chunks = wordWrapLine(marker, 3, preSegmented);
		assert.ok(chunks.length > 1);
		assert.strictEqual(chunks.map((c) => c.text).join(""), marker);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/pi-tui && node --test test/editor.test.ts`
Expected: FAIL —— 前三个用例报 `RangeError: Maximum call stack size exceeded`；第四个用例（marker）通过。

- [ ] **Step 3: 实现守卫**

在 `packages/pi-tui/src/components/editor.ts` 中，把：

```ts
		if (gWidth > maxWidth) {
			// Single atomic segment wider than maxWidth (e.g. paste marker
			// in a narrow terminal). Re-wrap it at grapheme granularity.

			// The segment remains logically atomic for cursor
			// movement / editing — the split is purely visual for word-wrap layout.
			const subChunks = wordWrapLine(grapheme, maxWidth);
```

改为：

```ts
		if (gWidth > maxWidth) {
			// Single atomic segment wider than maxWidth (e.g. paste marker
			// in a narrow terminal). Re-wrap it at grapheme granularity.

			// The segment remains logically atomic for cursor
			// movement / editing — the split is purely visual for word-wrap layout.
			const subSegments = [...graphemeSegmenter.segment(grapheme)];
			if (subSegments.length <= 1) {
				// An indivisible grapheme wider than maxWidth (e.g. a CJK
				// character at maxWidth 1) cannot be split further —
				// re-wrapping it would recurse forever. Keep it as the
				// current open chunk and let it overflow by one column;
				// the TUI paint layer truncates overwide lines.
				currentWidth = gWidth;
				wrapOppIndex = -1;
				continue;
			}
			const subChunks = wordWrapLine(grapheme, maxWidth, subSegments);
```

说明：
- 到达该分支时恒有 `chunkStart === charIndex`（`gWidth > maxWidth` 蕴含前面的 overflow 检查必然执行了 force-break 或本来就是空 chunk），所以只需把 `currentWidth` 设为 `gWidth` 即把该 grapheme 保留为打开的 chunk；后续 grapheme 触发 overflow 时会正常把它 push 出去，末尾的 `chunks.push(line.slice(chunkStart))` 也能收尾，不会产生空尾 chunk。
- `subSegments` 顺手传给递归调用（`preSegmented` 参数），避免递归内部重复分词；其 `index` 相对于 `grapheme` 起点，与递归内 slice 语义一致。
- `graphemeSegmenter` 在 editor.ts 顶部（L18）已定义，函数内可直接使用。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/pi-tui && node --test test/editor.test.ts`
Expected: PASS（全部用例，包括原有用例）

- [ ] **Step 5: Commit（需用户授权）**

```bash
git add packages/pi-tui/src/components/editor.ts packages/pi-tui/test/editor.test.ts
git commit -m "fix(pi-tui): stop wordWrapLine infinite recursion on wide graphemes at width 1"
```

---

### Task 2: `Container.render` 入口宽度钳制

**Files:**
- Modify: `packages/pi-tui/src/tui.ts:280`
- Test: `packages/pi-tui/test/tui-render.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/pi-tui/test/tui-render.test.ts` 中，先把 import 行：

```ts
import { type Component, TUI } from "../src/tui.ts";
```

改为：

```ts
import { type Component, Container, TUI } from "../src/tui.ts";
```

然后在文件末尾追加：

```ts
describe("Container width clamping", () => {
	it("clamps non-positive widths to 1 before rendering children", () => {
		const container = new Container();
		const received: number[] = [];
		container.addChild({
			render(width: number): string[] {
				received.push(width);
				return [];
			},
			invalidate(): void {},
		});
		container.render(0);
		container.render(-3);
		assert.deepStrictEqual(received, [1, 1]);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/pi-tui && node --test test/tui-render.test.ts`
Expected: FAIL —— `AssertionError`，实际为 `[0, -3]`，期望 `[1, 1]`。

- [ ] **Step 3: 实现钳制**

在 `packages/pi-tui/src/tui.ts` 的 `Container` 类中，把：

```ts
	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
```

改为：

```ts
	render(width: number): string[] {
		// Extremely narrow terminals can report tiny or even non-positive
		// column counts; never propagate a width below 1 into components.
		width = Math.max(1, width);
		const lines: string[] = [];
		for (const child of this.children) {
```

说明：`TUI extends Container` 且不覆写 `render`，`doRender` 里的 `this.render(width)`（tui.ts:1271）会经过这里，因此顶层组件树拿到的宽度恒 ≥1；嵌套 `Container` 同样自带钳制。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/pi-tui && node --test test/tui-render.test.ts`
Expected: PASS

- [ ] **Step 5: Commit（需用户授权）**

```bash
git add packages/pi-tui/src/tui.ts packages/pi-tui/test/tui-render.test.ts
git commit -m "fix(pi-tui): clamp container render width to a minimum of 1"
```

---

### Task 3: 超宽行统一截断，删除 fail-fast throw（机制兜底）

**Files:**
- Modify: `packages/pi-tui/src/tui.ts:1278-1281`（插入截断循环）
- Modify: `packages/pi-tui/src/tui.ts:1542-1570`（删除 throw 块）
- Test: `packages/pi-tui/test/tui-render.test.ts`

**原理**：在 `doRender` 中、overlay 合成和光标标记提取之后、`applyLineResets` 之前，对所有非图片行做一次宽度检查并截断。这样 `fullRender` 和差分两条路径都被覆盖；截断发生在 `applyLineResets` 之前，被截掉的 ANSI 样式会由每行末尾追加的 `SEGMENT_RESET` 关闭，不会泄漏。截断用 `sliceByColumn(line, 0, width, true)`（tui.ts 已 import，strict 模式丢弃跨界宽字符）——这与 overlay 合成 `compositeLineAt` 使用的是同一套 ANSI 感知切割。

- [ ] **Step 1: 写失败测试**

在 `packages/pi-tui/test/tui-render.test.ts` 末尾追加（复用文件里已有的 `TestComponent`，其 `lines` 字段可直接改写）：

```ts
describe("TUI overwide line handling", () => {
	it("truncates lines wider than the terminal instead of throwing", async () => {
		const terminal = new VirtualTerminal(4, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["ok"];
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		// 改成超宽行并触发差分渲染路径（修复前这里会 throw）。
		component.lines = ["xxxxxxxxxx", "你好世界"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("xxxx")));
		assert.ok(
			!viewport.some((line) => line.includes("xxxxx")),
			"ASCII line should be truncated to terminal width",
		);
		assert.ok(viewport.some((line) => line.includes("你好")));
		assert.ok(
			!viewport.some((line) => line.includes("你好世")),
			"CJK line should be truncated to terminal width",
		);

		tui.stop();
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/pi-tui && node --test test/tui-render.test.ts`
Expected: FAIL —— 渲染 tick 抛出 `Error: Rendered line 0 exceeds terminal width (10 > 4)`（以 uncaught exception 形式使测试文件失败）。

- [ ] **Step 3: 实现截断 + 删除 throw**

修改一（插入截断循环）：在 `packages/pi-tui/src/tui.ts` 中，把：

```ts
		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);
```

改为：

```ts
		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		// Never write a line wider than the terminal: truncate defensively
		// instead of crashing. Extremely narrow terminals can make
		// components overflow by a column (e.g. wide graphemes at width 1).
		// applyLineResets() runs afterwards, so truncated lines still get
		// their trailing reset and cannot leak styles.
		for (let i = 0; i < newLines.length; i++) {
			const line = newLines[i]!;
			if (!isImageLine(line) && visibleWidth(line) > width) {
				newLines[i] = sliceByColumn(line, 0, width, true);
			}
		}

		newLines = this.applyLineResets(newLines);
```

修改二（删除差分路径的 throw 块）：把：

```ts
			buffer += "\x1b[2K"; // Clear current line
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(os.homedir(), ".pi", "agent", "pi-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			buffer += line;
```

改为：

```ts
			buffer += "\x1b[2K"; // Clear current line
			buffer += line;
```

说明：
- `isImageLine`、`visibleWidth`、`sliceByColumn` 均已在 tui.ts 顶部 import，无需新增 import。
- 删除 throw 块后 `fs`/`os`/`path` 仍被 `logRedraw`（tui.ts:1327-1333）使用，import 保留。
- 删除后该循环内的 `isImage` 变量仍被上方 kitty 图片逻辑使用，保留。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/pi-tui && node --test test/tui-render.test.ts`
Expected: PASS（包括文件内原有 kitty 图片相关用例）

- [ ] **Step 5: 跑全套 pi-tui 测试防止误伤**

Run: `pnpm --filter @moonshot-ai/pi-tui test`
Expected: PASS。特别关注 `tui-overlay-style-leak.test.ts`（样式泄漏）与 `tui-shrink.test.ts`（内容收缩）不回归。

- [ ] **Step 6: Commit（需用户授权）**

```bash
git add packages/pi-tui/src/tui.ts packages/pi-tui/test/tui-render.test.ts
git commit -m "fix(pi-tui): truncate overwide rendered lines instead of throwing"
```

---

### Task 4: 编辑器窄宽度端到端回归测试

**Files:**
- Test: `packages/pi-tui/test/editor.test.ts`

依赖 Task 1-3 全部完成（w=5 + paddingX=4 的用例需要 Task 1 消除栈溢出、Task 3 消除超宽 throw 才能通过）。本 Task 只加测试，不改实现。

- [ ] **Step 1: 追加端到端测试**

在 `packages/pi-tui/test/editor.test.ts` 末尾追加（`Editor`、`createTestTUI`、`defaultEditorTheme`、`TUI`、`VirtualTerminal`、`visibleWidth` 均已在该文件 import）：

```ts
describe("Editor narrow width rendering", () => {
	it("renders CJK text without crashing at widths 1-8 (default padding)", () => {
		for (let width = 1; width <= 8; width++) {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setText("你好世界");
			assert.doesNotThrow(() => editor.render(width), `width ${width}`);
		}
	});

	it("renders CJK text without crashing at widths 1-8 (paddingX 4, matches kimi-code)", () => {
		for (let width = 1; width <= 8; width++) {
			const editor = new Editor(createTestTUI(), defaultEditorTheme, { paddingX: 4 });
			editor.setText("你好，世界！");
			assert.doesNotThrow(() => editor.render(width), `width ${width}`);
		}
	});

	it("recalls history without crashing after rendering at width 1", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.addToHistory("你好世界");
		editor.render(1); // 窄渲染把 lastWidth 钉在 1，复现历史导航崩溃路径
		assert.doesNotThrow(() => {
			(editor as unknown as { navigateHistory(direction: 1 | -1): void }).navigateHistory(-1);
		});
		assert.strictEqual(editor.getText(), "你好世界");
	});

	it("renders inside a TUI at 5 columns without crashing or overflowing", async () => {
		const terminal = new VirtualTerminal(5, 12);
		const tui = new TUI(terminal);
		const editor = new Editor(tui, defaultEditorTheme, { paddingX: 4 });
		tui.addChild(editor);
		editor.setText("你好世界");
		tui.start();
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		assert.ok(viewport.every((line) => visibleWidth(line) <= 5));
		tui.stop();
	});
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `cd packages/pi-tui && node --test test/editor.test.ts`
Expected: PASS。（可选交叉验证：临时 `git stash` Task 1 的 editor.ts 改动再跑一次，应看到前两个用例栈溢出，验证测试确实盯住了根因；随后 `git stash pop` 恢复。）

- [ ] **Step 3: Commit（需用户授权）**

```bash
git add packages/pi-tui/test/editor.test.ts
git commit -m "test(pi-tui): add editor narrow-width regression tests"
```

---

### Task 5: 组件裸 `repeat` 负宽度加固

**Files:**
- Modify: `packages/pi-tui/src/components/text.ts:90`
- Modify: `packages/pi-tui/src/components/markdown.ts:226`
- Modify: `packages/pi-tui/src/components/markdown.ts:464`
- Modify: `packages/pi-tui/src/components/truncated-text.ts:26`
- Test: `packages/pi-tui/test/tui-render.test.ts`、`packages/pi-tui/test/markdown.test.ts`、`packages/pi-tui/test/truncated-text.test.ts`

**原理**：`Container.render` 钳制后顶层宽度恒 ≥1，但中间组件（如 Box）自行推导子宽度时仍可能把负值直接传给子组件的 `render()`。这 4 处裸 `repeat` 是仅剩的会直接抛 `RangeError` 的点，用 `Math.max(0, ...)` 加固。

- [ ] **Step 1: 写失败测试**

`packages/pi-tui/test/tui-render.test.ts` 顶部追加 import：

```ts
import { Text } from "../src/components/text.ts";
```

文件末尾追加：

```ts
describe("Text negative width safety", () => {
	it("does not throw at zero or negative widths", () => {
		const text = new Text("你好", 1, 1);
		assert.doesNotThrow(() => text.render(0));
		assert.doesNotThrow(() => text.render(-1));
	});
});
```

`packages/pi-tui/test/markdown.test.ts` 末尾追加（该文件已 import `Markdown`、`defaultMarkdownTheme`、`assert`、`describe`、`it`）：

```ts
describe("Markdown negative width safety", () => {
	it("does not throw at zero or negative widths", () => {
		const markdown = new Markdown("# Title\n\ntext\n\n---", 1, 1, defaultMarkdownTheme);
		assert.doesNotThrow(() => markdown.render(0));
		assert.doesNotThrow(() => markdown.render(-1));
	});
});
```

`packages/pi-tui/test/truncated-text.test.ts` 末尾追加（沿用该文件已有的 import 与构造方式，`TruncatedText` 构造签名为 `(text, paddingX = 0, paddingY = 0)`）：

```ts
describe("TruncatedText negative width safety", () => {
	it("does not throw at zero or negative widths", () => {
		const component = new TruncatedText("hello", 1, 1);
		assert.doesNotThrow(() => component.render(0));
		assert.doesNotThrow(() => component.render(-1));
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/pi-tui && node --test test/tui-render.test.ts test/markdown.test.ts test/truncated-text.test.ts`
Expected: FAIL —— 三个新用例在 `render(-1)` 处抛 `RangeError: Invalid count value: -1`。

- [ ] **Step 3: 实现加固（4 处同构小改）**

`packages/pi-tui/src/components/text.ts:90`、`packages/pi-tui/src/components/markdown.ts:226`、`packages/pi-tui/src/components/truncated-text.ts:26` 三处，把：

```ts
		const emptyLine = " ".repeat(width);
```

改为：

```ts
		const emptyLine = " ".repeat(Math.max(0, width));
```

`packages/pi-tui/src/components/markdown.ts:464`，把：

```ts
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
```

改为：

```ts
				lines.push(this.theme.hr("─".repeat(Math.max(0, Math.min(width, 80)))));
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/pi-tui && node --test test/tui-render.test.ts test/markdown.test.ts test/truncated-text.test.ts`
Expected: PASS

- [ ] **Step 5: Commit（需用户授权）**

```bash
git add packages/pi-tui/src/components/text.ts packages/pi-tui/src/components/markdown.ts packages/pi-tui/src/components/truncated-text.ts packages/pi-tui/test/tui-render.test.ts packages/pi-tui/test/markdown.test.ts packages/pi-tui/test/truncated-text.test.ts
git commit -m "fix(pi-tui): guard blank-line padding against negative widths"
```

---

### Task 6: 记录与上游的本地分歧（防 re-vendor 回归）

**Files:**
- Create: `packages/pi-tui/AGENTS.md`

- [ ] **Step 1: 创建 AGENTS.md**

写入以下内容：

```markdown
# pi-tui Agent Guide

`packages/pi-tui` 是从上游 pi-mono 的 pi-tui vendor 进来的副本（基线：上游 0.80.2，见 commit `7859b0af`）。它不再通过 pnpm patch 打补丁——所有本地修复直接改源码。

## 与上游的本地分歧（re-vendor 时必须逐条保留）

从上游同步代码时，绝不能直接整目录覆盖。以下本地修复必须在同步后重新核对，全部有测试守护：

1. **`src/components/editor.ts` — `wordWrapLine` 单 grapheme 递归守卫**：segment 不可再分（单 grapheme）且比 `maxWidth` 宽时不再递归（上游在 maxWidth=1 + CJK 时无限递归栈溢出）。守护测试：`test/editor.test.ts` 的 "wordWrapLine narrow width"。
2. **`src/tui.ts` — `Container.render` 宽度钳制**：入口 `width = Math.max(1, width)`。守护测试：`test/tui-render.test.ts` 的 "Container width clamping"。
3. **`src/tui.ts` — 超宽行截断替代 throw**：`doRender` 在 `applyLineResets` 前对超宽行统一 `sliceByColumn` 截断；上游差分渲染路径的"写崩溃日志 + throw"块已删除，不要在同步时带回来。守护测试：`test/tui-render.test.ts` 的 "TUI overwide line handling"。
4. **`src/components/text.ts` / `markdown.ts` / `truncated-text.ts` — 负宽度 repeat 防御**：空行/分隔线的 `repeat` 参数钳到 ≥0。守护测试：各自测试文件的 "negative width safety"。

## 同步上游后的验收

- 必须跑 `pnpm --filter @moonshot-ai/pi-tui test` 且全绿；上述守护测试任何一个失败都说明本地分歧被覆盖丢失。

## 测试

- 本包测试用 `node --test`（`pnpm --filter @moonshot-ai/pi-tui test`），不是 vitest；根目录 `vitest run` 不会执行本包测试。
- 新增窄宽度相关测试优先加进对应组件的现有测试文件。
```

- [ ] **Step 2: Commit（需用户授权）**

```bash
git add packages/pi-tui/AGENTS.md
git commit -m "docs(pi-tui): document local divergences from upstream"
```

---

### Task 7: 全量验证 + changeset

**Files:**
- Create: `.changeset/`（由 gen-changesets 技能生成）

- [ ] **Step 1: pi-tui 全套测试 + 类型检查**

Run: `pnpm --filter @moonshot-ai/pi-tui test && pnpm --filter @moonshot-ai/pi-tui typecheck`
Expected: 测试全绿，tsc 无报错。

- [ ] **Step 2: 根仓库测试（确认下游无回归）**

Run: `pnpm test`
Expected: PASS（vitest projects 模式；pi-tui 本身被排除，但 `apps/kimi-code` 等依赖方的用例会覆盖到集成路径）。

- [ ] **Step 3: 手工冒烟（可选但推荐）**

本地启动 kimi-code TUI，输入中文后把终端窗口拖到 5 列以内再拖回：进程不退出、UI 随宽度恢复正常。

- [ ] **Step 4: 生成 changeset**

调用 `gen-changesets` 技能（`.agents/skills/gen-changesets/SKILL.md`）并遵循其内部规则生成 changeset（英文 changelog 文案；本次为 bug 修复，绝不写 `major`——若技能规则判断出 major 倾向，必须停下来找用户确认）。变更要点供撰写参考：fix narrow-terminal crashes — editor word-wrap infinite recursion at 1-column layout width, overwide rendered lines now truncated instead of throwing, container render width clamped, blank-line padding guarded against negative widths。

- [ ] **Step 5: Commit changeset（需用户授权）**

```bash
git add .changeset/
git commit -m "chore: add changeset for pi-tui narrow width fixes"
```
