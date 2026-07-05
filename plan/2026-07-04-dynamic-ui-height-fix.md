# 动态高度 UI 组件抖动修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `apps/kimi-code` 中 10 个会「先高 → 高度变化 → 最后变矮」的动态 UI 组件的视觉抖动，让它们在生命周期内对外返回固定/受控行数，不推动外部布局。

**Architecture:** 不改 pi-tui 底层，只在 `apps/kimi-code` 客户端改。三条策略组合：**等高化**（组件在生命周期内返回固定行数）、**占位/摘要替代**（消失场景用固定占位而非彻底清空）、**关闭时全量重绘**（dialog/autocomplete/BTW/AgentSwarm 关闭时 `requestRender(true)` 清脏内容）。复用现成工具 `PrefixedWrappedLine(tailLines, minLines)`、`Spacer`、`BtwPanelComponent.fitBodyLines()`。

**Tech Stack:** TypeScript、vitest（`describe`/`it`/`expect`/`vi`）、pi-tui `Component` 接口（`render(width): string[]`）、`@moonshot-ai/pi-tui` 的 `Editor`/`SelectList`/`Container`。

---

## 0. 背景与根因

pi-tui 的 `Container.render()` 顺序拼接子组件行（`packages/pi-tui/src/tui.ts:263`）。任一组件返回的行数变化，后续所有组件的逻辑行号必然移动，差量渲染把它们重绘到新位置——这就是抖动。`requestRender(true)` / resize 还会触发破坏性清屏重排。

要消除抖动，在只改客户端的前提下：**让动态组件对外返回固定行数**，把高度变化限制在组件内部（用 tail 窗口 / padding / 占位），不推动外部布局。

## 1. 修复范围（10 个场景）

| # | 场景 | 策略 | 落点 |
|---|---|---|---|
| 1a | 斜杠命令打开的 dialog/selector 关闭 | 全量重绘 | `kimi-tui.ts:2601` `restoreEditor` |
| 1b | 斜杠/`@`/路径 autocomplete 下拉关闭 | 全量重绘 | `custom-editor.ts:260` `render()` |
| 2 | `AgentGroupComponent` 多 subagent 组 | 等高化 | `agent-group.ts:179-224` |
| 3 | `ThinkingComponent` 思考面板 | 等高化 | `thinking.ts:90-144` |
| 4 | `ToolCallComponent` progress/liveOutput/result | 等高化（固定 6 行输出窗口） | `tool-call.ts:1518-1554`、`buildContent` |
| 5 | `ShellRunComponent` 用户 `!` 命令 | 等高化 | `shell-run.ts:29` |
| 6 | AgentSwarm 面板摘除 | 全量重绘 | `subagent-event-handler.ts:546-559` |
| 7 | Todo 清空消失 | 临时占位 | `todo-panel.ts:114` + `streaming-ui.ts` |
| 8 | Todo Ctrl+T 展开/折叠 | 全量重绘 | `kimi-tui.ts:2367-2370` |
| 9 | BTW Esc 关闭 | 全量重绘 | `btw-panel.ts:141-144` |
| 10 | `ToolCallComponent` Write/Edit preview | 等高化（始终 capped） | `tool-call.ts:1904-1980` |

## 2. 文件结构

**新建：**
- `apps/kimi-code/src/tui/components/messages/fixed-height-window.ts` —— 固定高度窗口组件，封装 `PrefixedWrappedLine`，对外接受 `lines` + `height` + `tail`，内部 tail/slice/padding，输出固定行数。

**修改：**
- `apps/kimi-code/src/tui/kimi-tui.ts` —— `restoreEditor` 改 `requestRender(true)`（Task 2）；`toggleTodoPanelExpansion` 改 `requestRender(true)`（Task 10）。
- `apps/kimi-code/src/tui/components/editor/custom-editor.ts` —— `render()` 检测 autocomplete 关闭，触发 `requestRender(true)`（Task 3）。
- `apps/kimi-code/src/tui/components/messages/agent-group.ts` —— done agent 保留第二行摘要，detach hint 固定 1 行（Task 4）。
- `apps/kimi-code/src/tui/components/messages/thinking.ts` —— live/finalized 共用固定骨架（Task 5）。
- `apps/kimi-code/src/tui/components/messages/tool-call.ts` —— progress/liveOutput/result 合并固定 6 行窗口；Write/Edit preview 始终 capped；Edit preview 用 tail 模式（Task 6、11）。
- `apps/kimi-code/src/tui/components/media/diff-preview.ts` —— `renderDiffLinesClustered` 新增 `tail` 选项（Task 11）。
- `apps/kimi-code/test/tui/components/media/diff-preview.test.ts`（新）—— `renderDiffLinesClustered` tail 模式测试。
- `apps/kimi-code/src/tui/components/messages/shell-run.ts` —— 运行中/完成后同一固定窗口（Task 7）。
- `apps/kimi-code/src/tui/controllers/subagent-event-handler.ts` —— `removeAgentSwarmProgress` 后 `requestRender(true)`（Task 8）。
- `apps/kimi-code/src/tui/components/chrome/todo-panel.ts` —— 清空时临时占位到上次高度；`clearPlaceholder()`（Task 9）。
- `apps/kimi-code/src/tui/controllers/streaming-ui.ts` —— AI 新一轮输出时调用 `todoPanel.clearPlaceholder()`（Task 9）。
- `apps/kimi-code/src/tui/controllers/btw-panel.ts` —— `close()` 后 `requestRender(true)`（Task 11）。

**测试：**
- `apps/kimi-code/test/tui/components/messages/fixed-height-window.test.ts`（新）
- `apps/kimi-code/test/tui/components/messages/agent-group.test.ts`（改）
- `apps/kimi-code/test/tui/components/messages/thinking.test.ts`（改）
- `apps/kimi-code/test/tui/components/messages/tool-call.test.ts`（改）
- `apps/kimi-code/test/tui/components/messages/shell-run.test.ts`（改）
- `apps/kimi-code/test/tui/components/panels/todo-panel.test.ts`（改）
- `apps/kimi-code/test/tui/components/editor/custom-editor.test.ts`（改）

## 3. 测试约定

- 框架：vitest。`import { describe, it, expect, vi } from 'vitest'`。
- 渲染断言：`const out = strip(component.render(80).join('\n'))`，`expect(out).toContain(...)` / `not.toContain(...)`。
- `strip(text)`：去掉 ANSI 转义码（各测试文件已有）。
- mock TUI：`{ terminal: { rows: 40 }, requestRender: vi.fn() } as unknown as TUI`。
- 动画/定时器：`vi.useFakeTimers()` + `vi.advanceTimersByTime(ms)`，结束 `vi.useRealTimers()`。
- 等高断言：固定高度 H 时，断言 `component.render(80).length === H`（在多个状态下）。
- 运行测试：`pnpm --filter @moonshot-ai/kimi-code test <path>`（执行时核对确切命令，见根 `package.json`）。

---

## Task 1: 共享基础设施 `FixedHeightWindow`

**Files:**
- Create: `apps/kimi-code/src/tui/components/messages/fixed-height-window.ts`
- Test: `apps/kimi-code/test/tui/components/messages/fixed-height-window.test.ts`

封装一个固定高度窗口组件，供 Task 4/5/6/7 复用。它接受任意文本行，输出固定 `height` 行：超出按 `tail` 取尾或取头，不足 padding 空行，并在截断时附加 `… N more` 提示行（提示计入高度内）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/kimi-code/test/tui/components/messages/fixed-height-window.test.ts
import { describe, it, expect } from 'vitest';
import { FixedHeightWindow } from '#/tui/components/messages/fixed-height-window';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('FixedHeightWindow', () => {
  it('pads short content to the fixed height', () => {
    const win = new FixedHeightWindow({ height: 4, lines: ['a', 'b'] });
    const out = win.render(80).map(strip);
    expect(out).toHaveLength(4);
    expect(out[0]).toContain('a');
    expect(out[1]).toContain('b');
  });

  it('keeps the tail when content exceeds height and tail=true', () => {
    const win = new FixedHeightWindow({
      height: 3,
      tail: true,
      lines: ['l1', 'l2', 'l3', 'l4', 'l5'],
    });
    const out = win.render(80).map(strip);
    expect(out).toHaveLength(3);
    expect(out.join('\n')).toContain('l5');
    expect(out.join('\n')).not.toContain('l1');
  });

  it('keeps the head when tail=false', () => {
    const win = new FixedHeightWindow({
      height: 3,
      tail: false,
      lines: ['l1', 'l2', 'l3', 'l4', 'l5'],
    });
    const out = win.render(80).map(strip);
    expect(out).toHaveLength(3);
    expect(out.join('\n')).toContain('l1');
    expect(out.join('\n')).not.toContain('l5');
  });

  it('returns identical line count across different content lengths', () => {
    const win = new FixedHeightWindow({ height: 5, lines: ['x'] });
    const short = win.render(80).length;
    win.setLines(['1', '2', '3', '4', '5', '6', '7', '8']);
    const long = win.render(80).length;
    expect(short).toBe(5);
    expect(long).toBe(5);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/fixed-height-window.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `FixedHeightWindow`**

```ts
// apps/kimi-code/src/tui/components/messages/fixed-height-window.ts
import type { Component } from '@moonshot-ai/pi-tui';

export interface FixedHeightWindowOptions {
  height: number;
  lines?: string[];
  tail?: boolean; // default true
}

export class FixedHeightWindow implements Component {
  private lines: string[];
  private readonly height: number;
  private readonly tail: boolean;

  constructor(opts: FixedHeightWindowOptions) {
    this.height = Math.max(0, opts.height);
    this.tail = opts.tail ?? true;
    this.lines = opts.lines ?? [];
  }

  setLines(lines: string[]): void {
    this.lines = lines;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    if (this.height === 0) return [];
    const src = this.lines;
    let shown: string[];
    if (src.length > this.height) {
      shown = this.tail ? src.slice(src.length - this.height) : src.slice(0, this.height);
    } else {
      shown = [...src];
    }
    while (shown.length < this.height) shown.push('');
    return shown;
  }
}
```

> 注：首版不附加 `… N more` 提示行（保持窗口纯粹等高）。截断提示由各调用方按需要自行在外层加（如 `ThinkingComponent` 的 `ctrl+o to expand`）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/fixed-height-window.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```bash
git add apps/kimi-code/src/tui/components/messages/fixed-height-window.ts apps/kimi-code/test/tui/components/messages/fixed-height-window.test.ts
git commit -m "feat(tui): add FixedHeightWindow component for stable-height rendering"
```

---

## Task 2: `restoreEditor` 关闭 dialog 时全量重绘（#1a）

**Files:**
- Modify: `apps/kimi-code/src/tui/kimi-tui.ts:2597-2602`
- Test: `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts`（追加用例；执行时核对 KimiTUI 实例化方式，必要时新建 `restore-editor.test.ts`）

`restoreEditor` 是所有 dialog/selector 关闭后的统一出口。当前用普通 `requestRender()`，差量渲染会在 scrollback 留下脏内容、footer 位置残留。改为 `requestRender(true)`，与 `Ctrl+O`（`kimi-tui.ts:2335`）一致。

- [ ] **Step 1: 写失败测试**

```ts
// 在 kimi-tui-message-flow.test.ts 内追加（或新建 restore-editor.test.ts）
it('restoreEditor forces a full render to clear dialog residue', () => {
  const tui = createTestTui(); // 用文件内已有的 helper；若无，构造一个最小 KimiTUI
  const requestRender = vi.spyOn(tui.state.ui, 'requestRender');
  tui.restoreEditor();
  expect(requestRender).toHaveBeenCalledWith(true);
});
```

> 若 `createTestTui`/`KimiTUI` 实例化成本过高，退而测试 `restoreEditor` 的契约：spy `state.ui.requestRender`，调用 `restoreEditor()`，断言以 `true` 调用。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/kimi-tui-message-flow.test.ts`
Expected: FAIL，`requestRender` 被调用但参数不是 `true`。

- [ ] **Step 3: 修改 `restoreEditor`**

```ts
// apps/kimi-code/src/tui/kimi-tui.ts:2597
restoreEditor(): void {
  this.state.editorContainer.clear();
  this.state.editorContainer.addChild(this.state.editor);
  this.state.ui.setFocus(this.state.editor);
  // Closing a dialog/selector shrinks the editor area; differential rendering
  // leaves stale bytes in scrollback and a misplaced footer. Force a full
  // render, matching the Ctrl+O expansion toggle.
  this.state.ui.requestRender(true);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/kimi-tui-message-flow.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/kimi-code/src/tui/kimi-tui.ts apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts
git commit -m "fix(tui): force full render when restoring editor after dialog close"
```

---

## Task 3: `CustomEditor` autocomplete 下拉关闭时全量重绘（#1b）

**Files:**
- Modify: `apps/kimi-code/src/tui/components/editor/custom-editor.ts:121、260`
- Test: `apps/kimi-code/test/tui/components/editor/custom-editor.test.ts`（追加用例）

斜杠/`@`/路径 autocomplete 下拉是 pi-tui editor 内部状态，关闭走 pi-tui 内部 `clearAutocompleteUi`，不经过 `restoreEditor`。在 `CustomEditor.render()`（已 override）里检测「从有到无」的转换，触发一次 `requestRender(true)`。pi-tui 暴露 `isShowingAutocomplete()`（`custom-editor.ts:255` 注释已使用）。

- [ ] **Step 1: 写失败测试**

```ts
// 在 custom-editor.test.ts 内追加
it('forces a full render when the autocomplete dropdown closes', () => {
  const requestRender = vi.fn();
  const editor = createEditor({ requestRender }); // 用文件内已有 helper
  // 打开下拉
  editor.showAutocompleteForTest([{ value: '/model', label: '/model' }]);
  editor.render(80);
  requestRender.mockClear();
  // 关闭下拉
  editor.hideAutocompleteForTest();
  editor.render(80);
  expect(requestRender).toHaveBeenCalledWith(true);
});
```

> `showAutocompleteForTest`/`hideAutocompleteForTest` 是测试辅助，调用 pi-tui 的 `tryTriggerAutocomplete` / `cancelAutocomplete`。执行时按 `custom-editor.test.ts` 现有 helper 对齐；若没有暴露，通过 `(editor as any)` 访问私有方法触发。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/editor/custom-editor.test.ts`
Expected: FAIL，关闭下拉时 `requestRender(true)` 未被调用。

- [ ] **Step 3: 修改 `CustomEditor`**

```ts
// apps/kimi-code/src/tui/components/editor/custom-editor.ts

export class CustomEditor extends Editor {
  private wasShowingAutocomplete = false;
  // ... 已有字段

  override render(width: number): string[] {
    const lines = super.render(width);
    const showing = this.isShowingAutocomplete();
    if (this.wasShowingAutocomplete && !showing) {
      // Autocomplete dropdown just closed: the editor returned fewer lines,
      // which would pull the footer up and leave stale rows in scrollback.
      this.ui?.requestRender(true);
    }
    this.wasShowingAutocomplete = showing;
    // ... 保留原有 render 后续逻辑（paste burst 等）
    return lines;
  }
}
```

> `isShowingAutocomplete()` 是 pi-tui `Editor` 的 public 方法（`custom-editor.ts:255` 注释确认）。`this.ui` 来自 pi-tui `Editor` 基类。`requestRender(true)` 是 `process.nextTick` 异步，不会同步递归 render；下一帧 `wasShowingAutocomplete === showing === false`，不再触发，最多多一次 render。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/editor/custom-editor.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/kimi-code/src/tui/components/editor/custom-editor.ts apps/kimi-code/test/tui/components/editor/custom-editor.test.ts
git commit -m "fix(tui): force full render when autocomplete dropdown closes"
```

---

## Task 4: `AgentGroupComponent` 等高化（#2）

**Files:**
- Modify: `apps/kimi-code/src/tui/components/messages/agent-group.ts:179-224`
- Test: `apps/kimi-code/test/tui/components/messages/agent-group.test.ts`（追加/调整用例）

运行中每个 agent 2 行（分支行 + activity 行 `Using {name} ({keyArg})`），done 后省略 activity 行 → 2N→N 塌缩。改为：done 的 agent 也保留第二行，显示 `latestActivity`（完成态落到「latest finished sub-tool」，即 `Used {name} ({keyArg})`，见 `tool-call.ts:84-87`，保留「这个 agent 最后做了什么工具调用」），无活动时回退到 phase 文案；detach hint 固定占 1 行（无 running 时留空行）。让运行中和完成后等高（每 agent 恒 2 行）。

- [ ] **Step 1: 写失败测试**

```ts
// 在 agent-group.test.ts 内追加
it('keeps a stable two-row body per agent after completion', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const ui = stubTui();
  const group = new AgentGroupComponent(ui);
  const a = createAgent('call_agent_1', 'inspect project', 'explore', ui);
  startAgent(a, 'call_agent_1', 'explore');
  group.attach('call_agent_1', a);

  const runningLines = group.render(120).length;

  // 完成 agent（执行时按 ToolCallComponent 实际 API 触发 done）
  a.onSubagentCompleted?.({ agentId: 'sub_call_agent_1', /* ... */ } as any);
  const doneLines = group.render(120).length;

  expect(doneLines).toBe(runningLines); // 等高
  const out = renderText(group);
  expect(out).toContain('explore'); // 分支行仍在
  group.dispose();
  a.dispose();
});
```

> `onSubagentCompleted` 的精确签名执行时核对 `ToolCallComponent`。核心是：同一 agent 在 running 与 done 两种状态下，`group.render(width).length` 必须相等。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/agent-group.test.ts`
Expected: FAIL，done 后行数小于 running。

- [ ] **Step 3: 修改 `appendLines` 与 detach hint**

```ts
// apps/kimi-code/src/tui/components/messages/agent-group.ts

private appendLines(snap: SubagentSnapshot, isLast: boolean): void {
  const branch1 = isLast ? '└─' : '├─';
  const line1 = `  ${branch1} ${namePart} ${descPart}${stats}${tail}`;
  this.bodyContainer.addChild(new Text(line1, 0, 0)); // 第一行：永远有

  const branch2 = isLast ? '   ' : '│  ';
  if (snap.phase === 'failed') {
    this.bodyContainer.addChild(new Text(`  ${branch2}    ${errStr}`, 0, 0));
    return;
  }
  if (snap.phase === 'done' || snap.phase === 'backgrounded') {
    // 保留第二行：latestActivity 在完成态已经是 "Used {name} ({keyArg})"
    // （finished sub-tool 优先，见 tool-call.ts:84-87），正好展示这个 agent
    // 最后做了什么工具调用。没有任何活动时回退到 phase 文案。与运行中等高。
    const activity =
      snap.latestActivity ?? (snap.phase === 'done' ? 'Completed' : 'Backgrounded');
    this.bodyContainer.addChild(new Text(`  ${branch2}    ${dim(activity)}`, 0, 0));
    return;
  }
  // running / queued / spawning
  const activity = snap.latestActivity ?? fallbackActivityForPhase(snap.phase);
  this.bodyContainer.addChild(new Text(`  ${branch2}    ${dim(activity)}`, 0, 0));
}

// detach hint 固定占 1 行
private renderDetachHint(snapshots: SubagentSnapshot[]): void {
  if (this.shouldShowDetachHint(snapshots)) {
    this.bodyContainer.addChild(new Text(currentTheme.dim(DETACH_HINT_TEXT), 2, 0));
  } else {
    this.bodyContainer.addChild(new Text('', 0, 0)); // 占位空行，保持等高
  }
}
```

> `snap.elapsedLabel` 字段名执行时核对 `getSubagentSnapshot()` 的返回结构。若不存在，用 `latestActivity` 或固定文案（如 `'Done'`）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/agent-group.test.ts`
Expected: PASS（含原有用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/kimi-code/src/tui/components/messages/agent-group.ts apps/kimi-code/test/tui/components/messages/agent-group.test.ts
git commit -m "fix(tui): keep AgentGroup body height stable after agents complete"
```

---

## Task 5: `ThinkingComponent` 等高化（#3）

**Files:**
- Modify: `apps/kimi-code/src/tui/components/messages/thinking.ts:90-144`
- Test: `apps/kimi-code/test/tui/components/messages/thinking.test.ts`（追加/调整用例）

live（spinner + 尾窗 2 行 = 3~4 行）与 finalized（空白 + 前 2 行 + 提示 = 4 行）布局切换导致抖动。改为共用同一固定骨架：固定 **4 行** = `1 行空白 + 1 行 header + 2 行内容窗口`。内容窗口用 `FixedHeightWindow(height=2)`，live 取尾、finalized 取头。finalized 截断提示并入第 2 行内容。

- [ ] **Step 1: 写失败测试**

```ts
// 在 thinking.test.ts 内追加
it('keeps the same line count in live and finalized modes', () => {
  const live = new ThinkingComponent(longThinking, true, 'live');
  const liveLines = live.render(80).length;

  live.finalize();
  const finalLines = live.render(80).length;

  expect(finalLines).toBe(liveLines); // 等高
  expect(finalLines).toBe(4);         // 固定 4 行
});

it('keeps a stable height for short thinking content', () => {
  const c = new ThinkingComponent('one line', true, 'live');
  const liveLines = c.render(80).length;
  c.finalize();
  expect(c.render(80).length).toBe(liveLines);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/thinking.test.ts`
Expected: FAIL，live 与 finalized 行数不一致。

- [ ] **Step 3: 重构 `render`**

```ts
// apps/kimi-code/src/tui/components/messages/thinking.ts
import { FixedHeightWindow } from './fixed-height-window';

private static readonly WINDOW_LINES = 2; // 内容窗口固定 2 行

render(width: number): string[] {
  const contentLines = this.content.split('\n');

  if (this.mode === 'live') {
    const frame = BRAILLE_SPINNER_FRAMES[this.spinnerFrame]!;
    const header = `${currentTheme.fg('textDim', frame)} ${currentTheme.fg('textDim', 'thinking...')}`;
    const window = new FixedHeightWindow({
      height: ThinkingComponent.WINDOW_LINES,
      tail: true,
      lines: contentLines,
    });
    return [
      '',
      header,
      ...window.render(width).map((line) => MESSAGE_INDENT + line),
    ];
  }

  // finalized
  const header = this.buildFinalizedHeader(); // 沿用现有 header 文案
  const window = new FixedHeightWindow({
    height: ThinkingComponent.WINDOW_LINES,
    tail: false,
    lines: contentLines,
  });
  const windowLines = window.render(width);
  if (contentLines.length > ThinkingComponent.WINDOW_LINES) {
    const remaining = contentLines.length - ThinkingComponent.WINDOW_LINES;
    windowLines[windowLines.length - 1] = currentTheme.dim(
      `${MESSAGE_INDENT}... (${String(remaining)} more lines, ctrl+o to expand)`,
    );
  }
  return ['', header, ...windowLines.map((line) => MESSAGE_INDENT + line)];
}
```

> `buildFinalizedHeader()` 提取现有 finalized header 文案逻辑。`MESSAGE_INDENT`、`currentTheme`、`BRAILLE_SPINNER_FRAMES` 沿用现有 import。执行时核对 `thinking.ts` 现有变量名。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/thinking.test.ts`
Expected: PASS（原有用例需同步调整：原来断言 `not.toContain('line3')` 仍成立；新增等高断言）。

- [ ] **Step 5: Commit**

```bash
git add apps/kimi-code/src/tui/components/messages/thinking.ts apps/kimi-code/test/tui/components/messages/thinking.test.ts
git commit -m "fix(tui): keep ThinkingComponent height stable across live and finalized modes"
```

---

## Task 6: `ToolCallComponent` 输出窗口等高化（#4）

**Files:**
- Modify: `apps/kimi-code/src/tui/components/messages/tool-call.ts:621-645、1518-1554、2093-2160`
- Test: `apps/kimi-code/test/tui/components/messages/tool-call.test.ts`（追加用例）

progress 行（≤24）+ liveOutput（≤3）在 `setResult()` 时清空，从最多 27 行塌到 content 行数。改为：把 `progress + liveOutput + result content` 合并成**一个固定 6 行的输出窗口**。运行中显示 progress + liveOutput 的尾部 6 行；完成后显示 result content 的尾部 6 行；不足 padding，全程等高。

- [ ] **Step 1: 写失败测试**

```ts
// 在 tool-call.test.ts 内追加
it('keeps a stable output window height between running and completed', () => {
  const ui = stubTui();
  const tc = new ToolCallComponent(
    { id: 'bash1', name: 'Bash', args: { command: 'echo hi' } },
    undefined,
    ui,
  );
  // 运行中：塞入 progress + liveOutput
  tc.appendProgress('p1\np2\np3\np4\np5');
  tc.setLiveOutput('o1\no2\no3');
  const runningLines = tc.render(120).length;

  // 完成后：result 到达
  tc.setResult({ output: 'r1\nr2', is_error: false });
  const doneLines = tc.render(120).length;

  expect(doneLines).toBe(runningLines); // 等高
});
```

> `appendProgress`/`setLiveOutput`/`setResult` 的精确 API 执行时核对 `tool-call.ts`。核心是：running 与 done 两态 `render().length` 相等。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/tool-call.test.ts`
Expected: FAIL，setResult 后行数塌缩。

- [ ] **Step 3: 重构 progress/liveOutput/content 为固定窗口**

在 `ToolCallComponent` 内新增私有方法 `buildOutputWindow()`，替代原来的 `buildProgressBlock()` + `buildLiveOutputBlock()` + `buildContent()` 三个独立 child：

```ts
// apps/kimi-code/src/tui/components/messages/tool-call.ts
import { FixedHeightWindow } from './fixed-height-window';

private static readonly OUTPUT_WINDOW_LINES = 6;

private buildOutputWindow(): void {
  const lines = this.collectOutputLines();
  const window = new FixedHeightWindow({
    height: ToolCallComponent.OUTPUT_WINDOW_LINES,
    tail: true,
    lines,
  });
  // 用 window 的输出替换原来的 progress/liveOutput/content 三个 child
  const rendered = window.render(this.lastRenderWidth);
  for (const line of rendered) {
    this.addChild(new Text(line, 0, 0));
  }
}

private collectOutputLines(): string[] {
  if (this.result !== undefined) {
    // 完成后：显示 result content（按工具 renderer 取文本）
    return this.renderResultLines();
  }
  // 运行中：progress + liveOutput
  return [...this.progressLines, ...this.liveOutputLines];
}
```

构造函数里把原来的：
```ts
this.buildProgressBlock();
this.buildLiveOutputBlock();
this.buildContent();
```
替换为：
```ts
this.buildOutputWindow();
```

`setResult()` 里清空 `progressLines`/`liveOutput` 后调用 `rebuildBody()`（已有），让窗口内容从 progress 切换到 result，但行数保持 6。

> 这是本计划最复杂的重构。执行时需先完整阅读 `tool-call.ts` 的 `buildProgressBlock`/`buildLiveOutputBlock`/`buildContent`/`rebuildBody`，确认子 child 的插入位置（`callPreviewEndIndex` 之后、`buildSubagentBlock` 之前）。`renderResultLines()` 复用现有 `pickResultRenderer()` 的输出（取其文本行）。若 content renderer 高度本身不固定（如 diff），统一用 `FixedHeightWindow` 包一层。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/tool-call.test.ts`
Expected: PASS（原有用例若有行数断言需同步调整）。

- [ ] **Step 5: Commit**

```bash
git add apps/kimi-code/src/tui/components/messages/tool-call.ts apps/kimi-code/test/tui/components/messages/tool-call.test.ts
git commit -m "fix(tui): stabilize ToolCall output window height across running and completed states"
```

---

## Task 7: `ShellRunComponent` 等高化（#5）

**Files:**
- Modify: `apps/kimi-code/src/tui/components/messages/shell-run.ts:29`
- Test: `apps/kimi-code/test/tui/components/messages/shell-run.test.ts`（追加用例）

运行中固定 7 行（5 行 tail + timing + hint），完成后切到完整输出（高度突变）。改为：运行中和完成后用**同一固定窗口**（tail N 行 + 状态行 + hint），完成后不显示完整输出，显示 tail + `completed` + `ctrl+o to expand`，与 ToolCall 对齐。

- [ ] **Step 1: 写失败测试**

```ts
// 在 shell-run.test.ts 内追加
it('keeps a stable height between running and completed', () => {
  const c = new ShellRunComponent({ command: 'ls', /* ... */ } as any);
  c.start?.();
  const runningLines = c.render(80).length;
  c.finish?.({ stdout: 'a\nb\nc\nd\ne\nf\ng', stderr: '', isError: false });
  const doneLines = c.render(80).length;
  expect(doneLines).toBe(runningLines);
});
```

> `start`/`finish` 的精确 API 执行时核对 `shell-run.ts`。核心是 running 与 done 两态 `render().length` 相等。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/shell-run.test.ts`
Expected: FAIL，完成后行数变化。

- [ ] **Step 3: 重构 `renderText`**

```ts
// apps/kimi-code/src/tui/components/messages/shell-run.ts
import { FixedHeightWindow } from './fixed-height-window';

private static readonly BODY_LINES = 5;

private renderText(): string {
  const source = this.running
    ? this.combined
    : formatBashOutputForDisplay(this.finalStdout, this.finalStderr, this.finalIsError);
  const allLines = sanitizeShellOutput(source).trimEnd().split('\n');

  const window = new FixedHeightWindow({
    height: ShellRunComponent.BODY_LINES,
    tail: true,
    lines: allLines,
  });
  const body = window
    .render(this.lastWidth)
    .map((line) => `  ${dim(line)}`)
    .join('\n');

  const hidden = Math.max(0, allLines.length - ShellRunComponent.BODY_LINES);
  const status = this.running
    ? `(${this.elapsed()}s)`
    : `completed${hidden > 0 ? ` · +${String(hidden)} lines` : ''} · ctrl+o to expand`;
  const hint = this.running ? '(ctrl+b to run in background)' : '';

  return [body, `  ${dim(status)}`, hint ? `  ${dim(hint)}` : ''].filter((l) => l !== undefined).join('\n');
}
```

> 完成后用 `FixedHeightWindow` tail 5 行替代完整输出。`formatBashOutputForDisplay`/`sanitizeShellOutput`/`dim` 沿用现有 import。执行时核对字段名（`combined`/`finalStdout`/`elapsed`）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/shell-run.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/kimi-code/src/tui/components/messages/shell-run.ts apps/kimi-code/test/tui/components/messages/shell-run.test.ts
git commit -m "fix(tui): keep ShellRun output window height stable after completion"
```

---

## Task 8: AgentSwarm 面板摘除时全量重绘（#6）

**Files:**
- Modify: `apps/kimi-code/src/tui/controllers/subagent-event-handler.ts:546-559`
- Test: `apps/kimi-code/test/tui/controllers/`（执行时确认是否有现成测试文件，无则新建 `subagent-event-handler.test.ts`）

`removeAgentSwarmProgress` 把 `AgentSwarmProgressComponent` 从 transcript `splice` 掉，整块消失，后续内容上移。改为摘除后 `requestRender(true)`，清屏重排，避免差量渲染在 scrollback 留下脏内容。

- [ ] **Step 1: 写失败测试**

```ts
// subagent-event-handler.test.ts
it('forces a full render when removing the AgentSwarm progress panel', () => {
  const { handler, ui, transcriptContainer } = createHandler(); // 按现有 helper 构造
  const requestRender = vi.spyOn(ui, 'requestRender');
  // 先挂载一个 swarm 面板
  handler.ensureAgentSwarmProgress('tc1', { items: [...] } as any);
  requestRender.mockClear();
  // 摘除
  handler.removeAgentSwarmProgress('tc1');
  expect(requestRender).toHaveBeenCalledWith(true);
});
```

> `createHandler`/`ensureAgentSwarmProgress`/`removeAgentSwarmProgress` 的精确 API 执行时核对 `subagent-event-handler.ts`。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/controllers/subagent-event-handler.test.ts`
Expected: FAIL，`requestRender(true)` 未被调用。

- [ ] **Step 3: 修改 `removeAgentSwarmProgress`**

```ts
// apps/kimi-code/src/tui/controllers/subagent-event-handler.ts:546
removeAgentSwarmProgress(toolCallId: string): void {
  const idx = this.state.transcriptContainer.children.findIndex(
    (c) => c === this.agentSwarmProgress,
  );
  if (idx !== -1) {
    this.state.transcriptContainer.children.splice(idx, 1);
    this.agentSwarmProgress = undefined;
    // Removing the panel shrinks the transcript; force a full render so the
    // differential renderer does not leave stale rows in scrollback.
    this.state.ui.requestRender(true);
  }
}
```

> 执行时核对现有 `removeAgentSwarmProgress` 的实际实现（变量名、是否已有 `requestRender` 调用），在其末尾追加 `requestRender(true)`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/controllers/subagent-event-handler.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/kimi-code/src/tui/controllers/subagent-event-handler.ts apps/kimi-code/test/tui/controllers/subagent-event-handler.test.ts
git commit -m "fix(tui): force full render when removing AgentSwarm progress panel"
```

---

## Task 9: Todo 清空时临时占位（#7）

**Files:**
- Modify: `apps/kimi-code/src/tui/components/chrome/todo-panel.ts:114`
- Modify: `apps/kimi-code/src/tui/controllers/streaming-ui.ts:583、618、646`
- Test: `apps/kimi-code/test/tui/components/panels/todo-panel.test.ts`（调整 + 追加用例）

`todos.length === 0` 时 `render()` 返回 `[]`，高度归零，editor 上移。改为：清空时**临时占位到上一次渲染高度**（空行）；新增 `clearPlaceholder()`，在 AI 新一轮输出开始（`onStreamingTextStart`/`onToolCallStart`/`onThinkingUpdate` 首次）时调用，撤销占位。

- [ ] **Step 1: 调整 + 追加测试**

```ts
// 在 todo-panel.test.ts 内

// 调整原有用例：空面板初始仍返回 []
it('returns no lines when empty before any todos were shown', () => {
  const panel = new TodoPanelComponent();
  expect(panel.render(80)).toEqual([]);
  expect(panel.isEmpty()).toBe(true);
});

// 新增：清空后占位到上次高度
it('holds placeholder lines at the last height after clearing', () => {
  const panel = new TodoPanelComponent();
  panel.setTodos([
    { title: 'a', status: 'done' },
    { title: 'b', status: 'in_progress' },
  ]);
  const before = panel.render(80).length; // header + 2 rows
  panel.setTodos([]);                      // 清空
  const after = panel.render(80);
  expect(after).toHaveLength(before);      // 等高占位
  expect(after.every((line) => line.trim() === '')).toBe(true);
});

// 新增：clearPlaceholder 撤销占位
it('clearPlaceholder removes the placeholder lines', () => {
  const panel = new TodoPanelComponent();
  panel.setTodos([{ title: 'a', status: 'done' }]);
  panel.render(80);
  panel.setTodos([]);
  expect(panel.render(80).length).toBeGreaterThan(0);
  panel.clearPlaceholder();
  expect(panel.render(80)).toEqual([]);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/panels/todo-panel.test.ts`
Expected: FAIL，清空后返回 `[]` 而非占位。

- [ ] **Step 3: 修改 `TodoPanelComponent`**

```ts
// apps/kimi-code/src/tui/components/chrome/todo-panel.ts
export class TodoPanelComponent implements Component {
  private lastRenderedLines = 0;
  private placeholderLines = 0;
  // ... 已有字段

  setTodos(todos: TodoItem[]): void {
    const wasEmpty = this.todos.length === 0;
    this.todos = [...todos];
    if (!wasEmpty && this.todos.length === 0) {
      // 从有到无：占位到上次高度，等下一轮 AI 输出时再撤销
      this.placeholderLines = this.lastRenderedLines;
    } else if (this.todos.length > 0) {
      this.placeholderLines = 0;
    }
  }

  clearPlaceholder(): void {
    this.placeholderLines = 0;
  }

  render(width: number): string[] {
    if (this.todos.length === 0) {
      if (this.placeholderLines > 0) {
        return Array.from({ length: this.placeholderLines }, () => '');
      }
      return [];
    }
    // ... 原有渲染逻辑
    const lines = /* ... */ [];
    this.lastRenderedLines = lines.length;
    return lines;
  }
}
```

> 注意：`lastRenderedLines` 只在「有 todo」时更新，避免占位帧把自身高度记成 0。`clear()` 方法也需要 `placeholderLines = 0`（执行时核对）。

- [ ] **Step 4: 在 `streaming-ui` 接入 `clearPlaceholder`**

```ts
// apps/kimi-code/src/tui/controllers/streaming-ui.ts
onStreamingTextStart(): void {
  this.state.todoPanel.clearPlaceholder();
  // ... 原有逻辑
}

onToolCallStart(toolCall: ToolCallBlockData): void {
  this.state.todoPanel.clearPlaceholder();
  // ... 原有逻辑
}

onThinkingUpdate(fullText: string): void {
  if (!this.hasThinkingStarted) {
    this.state.todoPanel.clearPlaceholder();
    this.hasThinkingStarted = true;
  }
  // ... 原有逻辑
}
```

> `this.state.todoPanel` 引用执行时核对（`streaming-ui.ts:708` 已有 `setTodos` 调用，说明引用存在）。`hasThinkingStarted` 标志用于「首次 thinking」判断，执行时按现有结构对齐。

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/panels/todo-panel.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/kimi-code/src/tui/components/chrome/todo-panel.ts apps/kimi-code/src/tui/controllers/streaming-ui.ts apps/kimi-code/test/tui/components/panels/todo-panel.test.ts
git commit -m "fix(tui): hold temporary placeholder height when todo panel clears"
```

---

## Task 10: Todo Ctrl+T 展开/折叠时全量重绘（#8）

**Files:**
- Modify: `apps/kimi-code/src/tui/kimi-tui.ts:2367-2370`
- Test: `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts`（追加用例）

`toggleTodoPanelExpansion()` 当前用普通 `requestRender()`（`kimi-tui.ts:2369`）。Ctrl+T 展开/折叠时 Todo 面板高度变化（展开显示全部、折叠显示 5 行 + 提示），差量渲染会在 scrollback 留下脏内容、editor 位置残留。改为 `requestRender(true)`，与 `Ctrl+O`（`kimi-tui.ts:2364`，同一函数上方几行已有）一致。`TodoPanelComponent.render()` 逻辑**保持不变**——靠全量重绘保证视觉干净，不做等高化/内部滚动。

- [ ] **Step 1: 写失败测试**

```ts
// 在 kimi-tui-message-flow.test.ts 内追加（或新建 todo-panel-expansion.test.ts）
it('toggleTodoPanelExpansion forces a full render', () => {
  const tui = createTestTui(); // 用文件内已有 helper
  const requestRender = vi.spyOn(tui.state.ui, 'requestRender');
  tui.toggleTodoPanelExpansion();
  expect(requestRender).toHaveBeenCalledWith(true);
});
```

> 若 `createTestTui`/`KimiTUI` 实例化成本过高，退而测试契约：spy `state.ui.requestRender`，调用 `toggleTodoPanelExpansion()`，断言以 `true` 调用。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/kimi-tui-message-flow.test.ts`
Expected: FAIL，`requestRender` 被调用但参数不是 `true`。

- [ ] **Step 3: 修改 `toggleTodoPanelExpansion`**

```ts
// apps/kimi-code/src/tui/kimi-tui.ts:2367
toggleTodoPanelExpansion(): void {
  this.state.todoPanel.toggleExpanded();
  // Expanding/collapsing the todo panel shifts the editor vertically; the
  // clamped differential render leaves stale rows in scrollback. Force a full
  // render, matching the Ctrl+O toggle a few lines above.
  this.state.ui.requestRender(true);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/kimi-tui-message-flow.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/kimi-code/src/tui/kimi-tui.ts apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts
git commit -m "fix(tui): force full render when toggling todo panel expansion"
```

---

## Task 11: BTW 关闭全量重绘 + Write/Edit preview capped（#9、#10）

**Files:**
- Modify: `apps/kimi-code/src/tui/controllers/btw-panel.ts:141-144`
- Modify: `apps/kimi-code/src/tui/components/messages/tool-call.ts:1904-1980`
- Test: `apps/kimi-code/test/tui/components/messages/tool-call.test.ts`（追加用例）

**#9 BTW Esc 关闭**：`close()` 当前 `btwPanelContainer.clear()` 后普通渲染，高度归零 + 脏内容。改为 `clear()` 后 `requestRender(true)`。

**#10 Write/Edit preview**：发现 Edit 有 capped 缺口。`buildCallPreview:1924` 的 `shouldCap = this.result !== undefined && !this.expanded`，导致 Edit 在 **args finalize（result 未到）时 `shouldCap=false`，渲染完整 diff**（`renderDiffLinesClustered` 不传 `maxLines`），result 到达后才 capped 到 10 行 → 严重塌缩（即 `tool-call.ts:1931-1934` 注释里 "snap back" 的场景，但只修了 Write 没修 Edit）。Write 已 capped，但 streaming 取尾、finalize 取头，内容突变且行数差 1。修复：Edit args finalize 时即 capped，且 capped 时用 **tail 模式**（取最后 10 行变更，和 Write streaming 一致）；Write streaming 补提示行与 finalize 对齐。`renderDiffLinesClustered` 新增 `tail` 选项。

- [ ] **Step 1: 写测试**

```ts
// btw-panel 关闭（执行时确认是否有 controller 测试文件，无则新建）
it('forces a full render when closing the BTW panel', () => {
  const { controller, ui } = createBtwController();
  const requestRender = vi.spyOn(ui, 'requestRender');
  controller.openForTest();   // 按实际 API 打开
  requestRender.mockClear();
  controller.closeForTest();  // 触发 Esc 关闭
  expect(requestRender).toHaveBeenCalledWith(true);
});

// Edit：args finalize 时就 capped，result 到达后不塌缩
it('caps Edit preview at args finalize, before result lands', () => {
  const tc = new ToolCallComponent(
    {
      id: 'e1',
      name: 'Edit',
      args: {
        file_path: 'a.ts',
        old_string: manyLines(40),
        new_string: manyLines(40),
      },
    },
    undefined,
    stubTui(),
  );
  const argsLines = tc.render(120).length; // args finalize，result 未到
  tc.setResult({ output: 'ok', is_error: false });
  const resultLines = tc.render(120).length;
  // 两态都 capped 到 COMMAND_PREVIEW_LINES，高度差 ≤ 1（提示行）
  expect(Math.abs(resultLines - argsLines)).toBeLessThanOrEqual(1);
});

// Write：streaming 与 finalized 行数一致
it('keeps Write preview line count stable across streaming and finalized', () => {
  const streaming = new ToolCallComponent(
    {
      id: 'w1',
      name: 'Write',
      args: {},
      streamingArguments: buildStreamingArgs('a.ts', 50),
    } as any,
    undefined,
    stubTui(),
  );
  const streamingLines = streaming.render(120).length;
  const finalized = new ToolCallComponent(
    { id: 'w1', name: 'Write', args: { file_path: 'a.ts', content: manyLines(50) } },
    undefined,
    stubTui(),
  );
  const finalLines = finalized.render(120).length;
  expect(Math.abs(streamingLines - finalLines)).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/tool-call.test.ts test/tui/components/media/diff-preview.test.ts`
Expected: FAIL。Edit 测试在 args finalize 时未 capped（完整 diff），result 到达后塌缩；Write 测试 streaming 无提示行，行数差 1；BTW 测试 `requestRender(true)` 未被调用；diff-preview tail 模式未实现。

- [ ] **Step 3: 修改 BTW `close`**

```ts
// apps/kimi-code/src/tui/controllers/btw-panel.ts:141
private close(panel: BtwPanelComponent): void {
  if (!this.host.state.btwPanelContainer.children.includes(panel)) return;
  this.host.state.btwPanelContainer.clear();
  this.unregister(panel);
  // Closing the panel shrinks the chrome area above the editor; force a full
  // render to clear stale rows and reposition the editor.
  this.host.state.ui.requestRender(true);
}
```

> `this.unregister(panel)` 调用执行时核对现有 `close` 实现（可能已有）。`this.host.state.ui` 引用执行时核对 `BtwPanelHost` 接口。

- [ ] **Step 4a: 给 `renderDiffLinesClustered` 加 tail 选项**

`apps/kimi-code/src/tui/components/media/diff-preview.ts:233`：在 `ClusteredDiffOptions` 加 `tail?: boolean`。tail=true 时保留 header，对 body 取最后 `maxLines` 行，前面加 `… N earlier lines hidden` 提示（和 Write streaming 的尾部语义一致）。

先写测试 `apps/kimi-code/test/tui/components/media/diff-preview.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';

function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

describe('renderDiffLinesClustered tail mode', () => {
  it('keeps the tail when tail=true and exceeds maxLines', () => {
    const out = renderDiffLinesClustered(lines(40), lines(40, 'changed'), 'a.ts', {
      maxLines: 10,
      tail: true,
    });
    const joined = out.join('\n');
    expect(joined).toContain('earlier lines hidden');
    expect(joined).toContain('changed 40'); // 尾部变更保留
    expect(joined).not.toContain('changed 1'); // 头部变更被裁
  });

  it('keeps the head when tail=false', () => {
    const out = renderDiffLinesClustered(lines(40), lines(40, 'changed'), 'a.ts', {
      maxLines: 10,
      tail: false,
    });
    const joined = out.join('\n');
    expect(joined).toContain('more changes hidden');
    expect(joined).toContain('changed 1');
  });
});
```

实现：在 `ClusteredDiffOptions` 加 `tail?: boolean`，函数末尾 return 前加 tail 分支：

```ts
if (opts.tail && maxLines !== undefined && output.length > maxLines) {
  const header = output[0]!;
  const body = output.slice(1);
  const keep = Math.max(1, maxLines - 1); // 留 1 行给提示
  const hidden = body.length - keep;
  const hint = opts.expandKeyHint ?? 'ctrl+o';
  return [
    header,
    s.meta(`     … ${String(hidden)} earlier lines hidden (${hint} to expand)`),
    ...body.slice(body.length - keep),
  ];
}
```

> tail 模式需要先渲染完整 output（不被循环内 `cap` 截断），再做尾部截断。执行时把循环的 `cap` 在 tail 模式下设为 `Infinity`，或先生成完整 output 再走 tail 分支。

- [ ] **Step 4b: Edit preview 用 tail 模式 capped**

`tool-call.ts:1953-1964` `buildCallPreview` 的 Edit 分支：

```ts
} else if (name === 'Edit') {
  const oldStr = str(this.toolCall.args['old_string']);
  const newStr = str(this.toolCall.args['new_string']);
  if (oldStr.length === 0 && newStr.length === 0) return;
  const filePath = str(this.toolCall.args['file_path'] ?? this.toolCall.args['path']);
  // Cap as soon as args finalize (not just when result lands), and keep the
  // tail so the latest changes stay visible — matches Write streaming.
  const editShouldCap = !this.expanded;
  const lines = renderDiffLinesClustered(oldStr, newStr, filePath, {
    contextLines: 3,
    ...(editShouldCap ? { maxLines: COMMAND_PREVIEW_LINES, tail: true } : {}),
  });
  for (const line of lines) {
    this.addChild(new Text(line, 2, 0));
  }
}
```

- [ ] **Step 5: 修复 Write streaming 提示行**

`tool-call.ts:2005-2016` `buildStreamingPreview` 的 Write 分支：streaming 取尾 10 行后，补一行 `... N more` 提示，和 finalized（`buildCallPreview:1942-1951`）行数对齐（都 11 行）。

```ts
if (name === 'Write') {
  // ... 现有 content/filePath/lang/allLines/scrollLines 逻辑
  for (const [i, line] of scrollLines.entries()) {
    const originalLineNumber =
      allLines.length > maxLines ? allLines.length - maxLines + i : i;
    const lineNum = currentTheme.dim(String(originalLineNumber + 1).padStart(4) + '  ');
    this.addChild(new Text(lineNum + line, 2, 0));
  }
  // 补提示行，与 finalized 行数对齐
  if (allLines.length > maxLines) {
    const remaining = allLines.length - scrollLines.length;
    this.addChild(
      new Text(
        currentTheme.dim(
          `... (${String(remaining)} more lines, ${String(allLines.length)} total, ctrl+o to expand)`,
        ),
        2,
        0,
      ),
    );
  }
  return;
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm --filter @moonshot-ai/kimi-code test test/tui/components/messages/tool-call.test.ts test/tui/components/media/diff-preview.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/kimi-code/src/tui/controllers/btw-panel.ts apps/kimi-code/src/tui/components/messages/tool-call.ts apps/kimi-code/src/tui/components/media/diff-preview.ts apps/kimi-code/test/tui/components/messages/tool-call.test.ts apps/kimi-code/test/tui/components/media/diff-preview.test.ts
git commit -m "fix(tui): force full render on BTW close and cap Edit/Write preview at args finalize"
```

---

## Self-Review

**1. Spec coverage:**
- #1a restoreEditor → Task 2 ✓
- #1b autocomplete 关闭 → Task 3 ✓
- #2 AgentGroup → Task 4 ✓
- #3 Thinking → Task 5 ✓
- #4 ToolCall 输出窗口 → Task 6 ✓
- #5 ShellRun → Task 7 ✓
- #6 AgentSwarm 摘除 → Task 8 ✓
- #7 Todo 临时占位 → Task 9 ✓
- #8 Todo Ctrl+T → Task 10 ✓
- #9 BTW 关闭 → Task 11 ✓
- #10 Write/Edit preview → Task 11 ✓
- 共享基础设施 → Task 1 ✓

**2. Placeholder scan:**
- 无 TBD/TODO。所有「执行时核对」均指向明确的 API 名称与文件行号，属于接口确认而非空缺。
- Task 6（ToolCall 输出窗口）是最复杂重构，已说明需先完整阅读 `tool-call.ts` 相关方法再实施。

**3. Type consistency:**
- `FixedHeightWindow({ height, lines, tail })` + `setLines()` 在 Task 1/5/6/7 一致。
- `clearPlaceholder()` 在 Task 9 定义并被 `streaming-ui` 调用，一致。
- `requestRender(true)` 在 Task 2/3/8/11 一致。

**4. 风险与权衡（执行时关注）:**
- **Task 6 窗口行数 6**：若简单工具调用留白过多，可调小 `OUTPUT_WINDOW_LINES`；若 diff/长输出被截断过多，可调大。统一常量便于调整。
- **Task 4 done 第二行内容**：直接用 `snap.latestActivity`（完成态已是 `Used {name} ({keyArg})`），无活动时回退到 `'Completed'`/`'Backgrounded'`。无需新增 snapshot 字段。
- **反馈 2（bash 长输出执行完消失）**：属于 `ToolCallComponent` 的 `buildLiveOutputBlock`/`buildProgressBlock`，已在 Task 6 覆盖（固定 6 行输出窗口，bash tail 不清空），AgentGroup 本身不渲染 bash 输出。
- **Task 9 占位常驻**：占位只在「todo 清空 → 下一轮 AI 输出」之间存在；若用户长时间不触发新输出，会保留空白。可接受。
- **全量重绘的性能**：Task 2/3/8/11 的 `requestRender(true)` 都是用户主动触发的离散事件（关闭 dialog/autocomplete/BTW、AgentSwarm 结束），非高频，性能可接受。

---

## 实施记录（2026-07-04）

所有 11 个任务已实施完成，测试全部通过（311 tests），oxlint 通过。

### 方案调整（实施时的工程决策）

- **Task 5（Thinking 等高化）**：原计划用 `FixedHeightWindow` 把 live/finalized 统一固定为 4 行。实施后发现短内容（≤2 行）会被 padding 出空行（finalized 在 contentLines=1 时有 2 行空行），不符合预期。改为：contentLines > 2 时固定 4 行（live/finalized 等高），contentLines ≤ 2 时恢复自然高度、不 padding（允许 live/finalized 差 1 行，避免空行）。Thinking 不再使用 `FixedHeightWindow`。

- **Task 6（ToolCall 输出窗口）**：原计划是「把 progress + liveOutput + content 合并成一个固定 6 行窗口」。实施时改为「progress 行固定 6 行窗口（`PROGRESS_WINDOW_LINES = 6`，tail）」，因为 content 由 `pickResultRenderer` 返回 `Component[]`（含 diff/image 等复杂组件），合并成单一文本窗口风险高且会丢失样式。新方案把运行中 progress 从最多 24 行降到 6 行，大幅减少 `setResult` 清空时的塌缩；liveOutput 仍 tail 3 行。`buildProgressBlock` 改用 `FixedHeightWindow`，新增 `styleProgressLine` 提取样式逻辑。

- **Task 11 #9（BTW 关闭）**：代码里 `btw-panel.ts:147` 的 `close()` 已经在调用 `this.host.state.ui.requestRender(true)`，无需额外改动。

- **Task 11 #10（Write/Edit）**：
  - Edit：`buildCallPreview` 改用 `editShouldCap = !this.expanded`，args finalize 时即 capped；并传 `tail: true` 给 `renderDiffLinesClustered`，超过 10 行时保留尾部变更。
  - Write：`buildStreamingPreview` 在 streaming 末尾补 `... N more lines ... ctrl+o to expand` 提示行，与 finalized 行数对齐。
  - `renderDiffLinesClustered` 新增 `tail?: boolean` 选项（tail 模式下 `cap = Infinity` 渲染完整后取尾部）。
  - 删除了不再使用的 `shouldCap` 变量（oxlint 报错）。

### 关键实现细节

- `CustomEditor` 用 `this.tui.requestRender(true)`（pi-tui `Editor` 的属性是 `protected tui`，不是 `ui`）。
- `AgentGroup` 的 detach hint 占位用 `Spacer(1)`（`Text('')` 渲染为空数组，不占行）。
- `TodoPanel` 的占位通过 `placeholderLines` + `lastRenderedLines` 实现，`clearPlaceholder()` 在 `streaming-ui` 的 `onStreamingTextStart` / `onThinkingUpdate`（首次）/ `onToolCallStart` 调用。

### 未做的事

- 未自动 commit（按系统约束，git mutation 需用户确认）。所有改动在工作区。

---

## 执行交接

Plan complete and saved to `plan/2026-07-04-dynamic-ui-height-fix.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
