# 生命周期模型

XState v5 状态节点的完整时序，全部结论来自 xstate 5.33.2 实测（验证脚本见 [verify-order.mjs](../tutorials/verify-order.mjs)）。

## 直线时序

不要用「配置嵌套层级」理解执行顺序。一个带 invoke 的状态节点，生命周期是一条直线：

```
进入状态:   invoke.src 启动  ≈  entry           （同一 tick，先后不保证）
            （invoke 运行中……）
invoke 完成: 触发 onDone / onError 转移
              → exit
              → 转移自身的 actions
              → target 状态的 entry（及 target 的 invoke 启动）
```

onError 与 onDone 结构完全相同（实测：`exit → onError 的 actions → E 的 entry`）。

## 三个关键机制

### 1. macrostep：先算状态，后执行 actions

v5 先把整个 macrostep（初始状态 + 沿途所有 `always` 事件less转移，直到状态稳定）计算完，再统一执行收集到的 actions。而 invoke 的 actor 在「算状态」阶段就启动了。

直接后果（实测）：初始状态、或经 `always` 在同一拍内进入的状态，其 `invoke.src` 先于 `entry` 执行，entry 里的同步阻塞也拦不住：

```
[  1ms] A 的 invoke.src 启动
[  1ms] prepare 的 entry: 同步阻塞命令开始   ← 阻塞 60ms 也拦不住，invoke 已先跑
```

而经事件触发的转移进入的状态，顺序是「转移 actions → entry → invoke.src 启动」。因此 entry 与 invoke 的先后依赖进入路径，不可作为时序依据。

### 2. onDone / onError 是转移，不是动作

`invoke.onDone` / `invoke.onError` 和 `on` / `always` / `after` 一样，是转移配置，拥有 `target` / `guard` / `actions`。invoke 完成只是产生了一个内部事件来触发它们。

转移一旦被触发，执行链固定：源状态 exit → 转移 actions → target entry。所以「先 onAEnded 再 bStarting」这类需求，把 onAEnded 放 exit（同步）即可天然满足，无需额外编排。

### 3. actions 是 fire-and-forget，永远不会被 await

entry / exit / 转移 actions 即使返回 Promise，状态机也不等待（实测：异步 exit 开始后状态机已走到后续状态，exit 的结束日志落后 150ms）。

推论：凡是需要「等它结束再往下走」的异步过程，必须建成 invoke + 状态，不能是 action。action 只放不需要结果的同步副作用，或 fire-and-forget 的异步通知（须自行 catch，否则 unhandled rejection）。

## 内部转移：无 target 则 exit 不执行

`onDone: { actions: 'x' }`（无 target）是内部转移，状态不退出、不重进，exit 和 entry 都不执行，只跑 actions。想让 exit 一定执行，转移必须带 target（哪怕是外部自转移 `target: '自身'`）。

## 同步阻塞可以卡住 invoke 启动的两个位置

实测同步阻塞 60ms 能推迟 invoke.src 启动的，只有：

1. 前一条转移（事件触发）的 `actions`；
2. 包在 `invoke.src` 内部开头。

entry 不行（机制 1）。
