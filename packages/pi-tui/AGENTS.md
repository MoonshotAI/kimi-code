# pi-tui Agent Guide

`packages/pi-tui` 是从上游 pi-mono 的 pi-tui vendor 进来的副本（基线：上游 0.80.2，见 commit `7859b0af`）。它不再通过 pnpm patch 打补丁——所有本地修复直接改源码。

## 与上游的本地分歧（re-vendor 时必须逐条保留）

从上游同步代码时，绝不能直接整目录覆盖。以下本地修复必须在同步后重新核对，全部有测试守护：

1. **`src/components/editor.ts` — `wordWrapLine` 单 grapheme 递归守卫**：segment 不可再分（单 grapheme）且比 `maxWidth` 宽时不再递归（上游在 maxWidth=1 + CJK 时无限递归栈溢出）。守卫必须基于 grapheme 数（`graphemeSegmenter.segment(...)`）而非 code-unit 长度——`grapheme.length` 对 ZWJ emoji 会误判。守护测试：`test/editor.test.ts` 的 "wordWrapLine narrow width" 与 "Editor narrow width rendering"。
2. **`src/tui.ts` — `Container.render` 宽度钳制**：入口 `width = Math.max(1, width)`。守护测试：`test/tui-render.test.ts` 的 "Container width clamping"。
3. **`src/tui.ts` — 超宽行截断替代 throw**：`doRender` 在 `applyLineResets` 前对超宽行统一 `sliceByColumn` 截断；上游差分渲染路径的"写崩溃日志 + throw"块已删除，不要在同步时带回来。性能约束：截断检查每帧扫全部行，必须先走 `utils.ts` 的 `asciiVisibleWidth` 快路径（ANSI 感知 ASCII 快扫 + 超限早退），仅对非 ASCII 行回退 `visibleWidth`；配套 `WIDTH_CACHE_SIZE` 为 4096。已知边界：>4096 条 distinct 非 ASCII 行时宽度缓存 FIFO 抖动（约 30ms/帧），根治需 prepared-frame 行级缓存，属后续任务。守护测试：`test/tui-render.test.ts` 的 "TUI overwide line handling"（精确 viewport 断言）、`test/truncate-to-width.test.ts` 的 "asciiVisibleWidth"。
4. **`src/components/text.ts` / `markdown.ts` / `truncated-text.ts` / `editor.ts` — 负宽度 repeat 防御**：空行/分隔线/编辑器上下边框的 `repeat` 参数钳到 ≥0（editor 上/下边框两处、markdown 的 emptyLine 与 hr——hr 处现从 render 入口不可达，属纯防御）。守护测试："negative width safety" 用例——Text 的在 `test/tui-render.test.ts`（Text 无独立测试文件），Markdown/TruncatedText 的在各自测试文件；编辑器为 `test/editor.test.ts` "Editor narrow width rendering" 组内的 "does not throw at zero or negative widths"。

## 同步上游后的验收

- 必须跑 `pnpm --filter @moonshot-ai/pi-tui test` 且全绿；上述守护测试任何一个失败都说明本地分歧被覆盖丢失。

## 测试

- 本包测试用 `node --test`（`pnpm --filter @moonshot-ai/pi-tui test`），不是 vitest；根目录 `vitest run` 不会执行本包测试。
- 新增窄宽度相关测试优先加进对应组件的现有测试文件。
