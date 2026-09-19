---
name: dev-state
description: >-
  按生命周期时机编写和解释 XState v5 状态节点：entry/exit 与 invoke.src 的启动时序、
  onDone/onError 的转移结构、macrostep 对初始状态与 always 链的影响、四类生命周期钩子
  （onStarting 可拦截 / onStarting 不可拦截 / onStarted / onEnded）的可靠挂载位置、
  异步分流到不同 target 的写法，以及 fromCallback 的 cleanup 时序、sendBack 分流
  与 fromPromise 的选型。所有时序结论以 xstate 5.33.2 的实测脚本为准，
  不凭文档记忆推断执行顺序。
---

# Dev State

按 [llms.txt](llms.txt) 导航，按 Diataxis 选择文档；每次只读取当前任务需要的原子条目。

## 执行流程

1. 先读 [生命周期模型](references/explanation/lifecycle-model.md)，建立「macrostep 先算状态、后执行 actions」「onDone/onError 是转移不是动作」的模型；不了解模型时写的钩子几乎必然挂错位置。
2. 需要挂钩子、做分流、前置阻塞时，按 [钩子配方](references/how-to-guides/hooks.md) 选写法，不要自行发明挂载点。
3. 涉及时序争议时跑 [验证脚本](references/tutorials/verify-order.mjs) 拿证据，不把未执行的推断说成已验证。

## Explanation：建立模型

- [生命周期模型](references/explanation/lifecycle-model.md)：状态节点从进入到离开的完整时序；为什么 entry 拦不住 invoke；为什么 actions 永远不会被 await。

## How-to guides：完成一个操作

- [钩子配方](references/how-to-guides/hooks.md)：四类生命周期钩子的挂载位置、invoke 前同步阻塞、invoke 结果分流 target、异步收尾中间状态。
- [fromCallback 钩子写法](references/how-to-guides/from-callback.md)：cleanup 时序陷阱（在 target entry 之后执行）、sendBack 分流代替 onDone、启动抛错走 onError、与 fromPromise 的选型。

## Tutorials：完整练习

- [时序验证脚本](references/tutorials/verify-order.mjs)：六个用例覆盖全部时序结论，含实测输出；需要 `npm i xstate` 后用 node 运行。
- [fromCallback 验证脚本](references/tutorials/verify-callback.mjs)：五个用例覆盖启动时机、头部阻塞、cleanup 时序、sendBack 分流、启动抛错。

## 交付检查

- 不把异步过程放 entry/exit/转移动作里还指望状态机等它；要等待就建成 invoke + 状态。
- 不把 onStarting（可拦截 invoke）挂进 entry；初始状态或 always 链进入时 invoke 先于 entry 启动，只有「包进 invoke.src 开头」和「前一条转移的 actions」两个可靠位置。
- 不把 onDone/onError 当作排在 exit 后面的步骤；它们是转移，exit 是转移的前半段，完整链条是 exit → 转移 actions → target 的 entry。
- 不给无 target 的转移配 exit 语义；内部转移不退出状态，exit 不会执行。
- 不用「嵌套层级」理解时序；一律套用「进入：invoke.src 启动 ≈ entry → invoke 完成 → exit → 转移 actions → target.entry」的直线模型。
- 分流写法按同步/异步二分：同步决策用转移 guard 数组，异步决策用中间状态 + invoke.onDone guard 数组，第一条通过者胜。
