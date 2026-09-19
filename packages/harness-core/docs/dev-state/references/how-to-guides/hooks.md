# 钩子配方

为状态节点提供生命周期钩子时的标准写法。时序依据见 [生命周期模型](../explanation/lifecycle-model.md)。

## 四类钩子总表

| 钩子 | 语义 | 挂载位置 | 依据 |
|---|---|---|---|
| `onStarting`（同步，可拦截 invoke） | `invoke.src` 启动前必须跑完 | 包进 `invoke.src` 开头（推荐）；或前一条转移的 `actions` | 实测阻塞 60ms 卡住 invoke 启动 |
| `onStarting`（同步，不可拦截） | 进入时跑，与 invoke 先后不保证 | `entry` 同步 action | 进入路径不同先后不同，不保证拦截 |
| `onStarted`（异步，不可拦截） | 进入后异步触发，状态机不等待 | `entry` 里 fire-and-forget 启动 Promise | action 不会被 await |
| `onEnded`（同步，不可拦截） | 离开时执行，跑完才进下一状态 | `exit` 同步 action | exit → 转移 actions → target entry |

## 单状态完整模板

```ts
import { fromPromise } from 'xstate';

const stateNode = {
  entry: [
    // onStarting: 同步，不可拦截 —— 与 invoke 谁先谁后不保证
    () => hooks.onStarting(),
    // onStarted: 异步，不可拦截 —— fire-and-forget，状态机不等它
    () => {
      void hooks.onStarted().catch(reportError); // 必须 catch，否则 unhandled rejection
    },
  ],
  exit: [
    // onEnded: 同步，不可拦截 —— 跑完才执行转移动作、进入下一状态
    () => hooks.onEnded(),
  ],
  invoke: {
    src: fromPromise(async (args) => {
      // onStarting: 同步，可拦截 —— 它跑不完，invoke 正文不会开始
      hooks.onStartingBlocking();
      return realWork(args);
    }),
    onDone: 'B',
    onError: 'E',
  },
};
```

## 多状态应用要点

- 「可拦截」钩子优先放 `src` 包装：状态自身携带，多条入口转移（`X→A`、`Y→A`）也只写一次。转移 `actions` 写法只适用于语义上属于「某条特定路径的前置条件」的场景，且每条入口转移都要挂，漏一条即失效。
- 「进入 A 的前置同步命令」挂在到达 A 的那条转移上：

```ts
idle: {
  on: { GO: { target: 'A', actions: () => execSync('blocking-cmd') } },
},
```

## 异步门控是否需要一个前置子状态，取决于 kickoff 的形态

「异步 Before 钩子必须先于相位的工作启动」不一定意味着加子状态，按 kickoff 形态二分：

- **kickoff 是信号/action**（父 actor 收到信号才开始干活，如 `spawn_tools`、`turn.drain`）：门控 invoke 直接挂在相位状态自己身上，kickoff 信号放进门控的 `onDone`（无 target 内部转移）里发，**不需要子状态**。信号未发出前对端不可能产生后续事件，门控期间无竞态：

```ts
acting: {
  entry: [() => hooks.onWill()],
  exit: [() => hooks.onDid()],
  invoke: {
    src: 'beforeActActor',            // await onBefore，onError → failed
    onDone: { actions: 'spawnTools' }, // 拦截通过才发出 kickoff 信号
  },
},
```

- **kickoff 本身就是 invoke**（如 `llmActor`）：invoke 在进入状态时（macrostep 计算阶段）就启动，同一状态节点内没有任何机制能异步挡在它前面，**必须有一个前置（子）状态**跑门控，`onDone` 再进入真正工作的状态。重试/恢复路径要跳过哪一级门控，就由转移目标决定（如 `retrying → streamGating` 跳过 step 级门控）。
- 手工 `spawn` actor + 转发全部事件来代替 invoke 可以消掉子状态，但等于用命令式代码重建 invoke 的生命周期与 onError 接线，复杂度更高，不推荐。

配套语义（exit 一致性）：Before 钩子抛错时相位以 failed 结束，该相位的 Did（exit 钩子）仍会触发——Will/Before 与 Did 不保证配对，Did 只承诺「相位离开即触发」。

## invoke 结果分流 target

按「决定去向的逻辑是同步还是异步」二分，不为同步逻辑多开状态：

```ts
// 异步分流：中间状态 + invoke.onDone guard 数组，第一条通过者胜
bStarting: {
  invoke: {
    src: 'onBStarting',
    onDone: [
      { guard: ({ event }) => event.output === 'b1', target: 'B1' }, // v4 为 event.data
      { target: 'B2' },                                              // 兜底
    ],
    onError: 'B2',
  },
},

// 同步分流：转移 guard 数组，无需中间状态
A: {
  on: {
    FINISH_A: [
      { guard: 'goesB1', target: 'B1' },
      { target: 'B2' },
    ],
  },
},
```

## 异步收尾（onEnded 为异步时）

`exit` 不会被 await，异步收尾必须拆中间状态，让 invoke 真正等待：

```ts
A:       { invoke: { src: 'workInA', onDone: 'aEnding' } },
aEnding: { invoke: { src: 'onAEnded', onDone: 'bStarting' } }, // 收尾完成才进入分流
```

同理，异步的 onStarting（需等待）应放在 A 的 invoke 链路最前，或拆 `aStarting` 状态。

一句话记忆：**要拦截就进 `src` 或转移，要通知就进 `entry`/`exit`，要等待就单开状态。**
