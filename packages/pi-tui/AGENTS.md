# pi-tui

本文件补充根目录的 `AGENTS.md`，只管 `packages/pi-tui`。

本包是引入仓库的 fork，上游是 [`earendil-works/pi`](https://github.com/earendil-works/pi) 的 `packages/tui`。保持 fork 尽量小，这样同步上游的成本才低。

**从上游同步、添加本地补丁，或评审 pi-tui 的 diff 时：** 读 [UPSTREAM.md](./UPSTREAM.md)。fork 就是相对于锁定的上游提交的 diff；那个文件记录了这些 diff 存在的原因。

## 修改这个包

TUI 的产品行为放在 `apps/kimi-code/src/tui` 里（组合、子类化、现有的宿主回调）。只有公开 API 表达不了这个行为时，才修改这个包。

合入这里的补丁必须：

1. 修复库缺陷（崩溃、渲染错误），或者提供应用触及不到的扩展点（输入状态机、渲染热路径、分词器）。
2. 只做加法：可选参数、回调，或默认关闭的开关。默认行为与上游一致。
3. 在 `UPSTREAM.md` 里加一张意图卡片（intent card），并加一个没有这项改动就会失败的测试。

跳过第 3 步，改动就不算完成。不要改写渲染策略。

## 测试

这个包通过 `pnpm --filter @moonshot-ai/pi-tui test` 运行 `node --test`。仓库根目录的 vitest 运行不会执行这些测试。
