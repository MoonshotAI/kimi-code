# fromCallback 的钩子写法

`fromCallback` 与 `fromPromise` 的差异：没有自动的 `onDone` 完成事件（靠 `sendBack` 自定义事件通信），返回值是清理函数（actor 停止时执行），启动时同步抛错会被 `invoke.onError` 捕获。全部结论来自 xstate 5.33.2 实测（[verify-callback.mjs](../tutorials/verify-callback.mjs)）。

## 启动时机与 fromPromise 相同

```
事件转移进入:  转移 actions → A 的 entry → callback 回调体执行
初始状态进入:  callback 回调体执行 → A 的 entry      ← 同样先于 entry
```

[生命周期模型](../explanation/lifecycle-model.md) 的 macrostep 结论对 fromCallback 同样成立，entry 依旧拦不住它。

## 四类钩子映射

| 钩子 | fromCallback 写法 | 实测依据 |
|---|---|---|
| `onStarting`（同步，可拦截） | **回调体头部同步代码**：跑不完，订阅等正文不会开始 | 阻塞 60ms，正文 61ms 才开始 |
| `onStarting`（同步，不可拦截） | `entry` 同步 action | 同 fromPromise |
| `onStarted`（异步，不可拦截） | `entry` fire-and-forget；或回调体内自行异步后 `sendBack` | 同 fromPromise |
| `onEnded`（同步，不可拦截） | **两个位置，时序不同**：`exit`（在 target entry 之前）；回调体返回的 **cleanup**（在 target entry **之后**，最后执行） | 实测 `exit → B entry → cleanup` |

## cleanup 的时序陷阱

直觉上 cleanup 应该在离开状态时最先跑，实测恰恰相反——它排在 `exit` 甚至 target 的 `entry` **之后**（同一 tick 内最后执行）：

```
[0ms] A 的 exit
[0ms] B 的 entry
[0ms] cleanup 执行      ← 最后
```

推论：

- cleanup 适合做「资源释放」（关订阅、断连接）——它随 actor 停止自动触发，离开状态、机器整体停止都会执行，不用自己挂。
- 如果 target 状态的逻辑依赖「清理已完成」，不能把清理放 cleanup，要放 `exit`（exit 在 target entry 之前）。

## 完成信号与分流：sendBack 代替 onDone

fromCallback 没有 `onDone`，完成时 `sendBack` 自定义事件，用普通 `on` 转移 + guard 数组分流；转移触发时 actor 停止，cleanup 自动执行：

```ts
const cb = fromCallback(({ sendBack }) => {
  const timer = setTimeout(
    () => sendBack({ type: 'CALLBACK_DONE', result: 'b1' }),
    1000,
  );
  return () => clearTimeout(timer); // onEnded: 释放资源
});

A: {
  invoke: { src: 'cb' },
  on: {
    CALLBACK_DONE: [
      { guard: ({ event }) => event.result === 'b1', target: 'B1' },
      { target: 'B2' },
    ],
  },
},
```

## 启动抛错 → invoke.onError

回调体启动时同步抛错会被 `invoke.onError` 捕获（实测进入 E 并执行转移 actions）。所以「可拦截」钩子不仅能阻塞正文，还能通过抛错直接改道到错误状态：

```ts
const cb = fromCallback(() => {
  hooks.onStartingBlocking(); // 同步拦截；抛错即走 onError
  // 正文：订阅、监听……
  return () => cleanup();
});

A: {
  invoke: { src: 'cb', onError: 'E' },
},
```

## 何时选 fromCallback 而不是 fromPromise

- 需要 cleanup 语义（长驻订阅/监听器，随状态退出自动释放）→ fromCallback。
- 需要父 actor 中途发消息（`onReceive`，如取消指令）→ fromCallback，fromPromise 做不到。
- 只是一次性异步任务拿结果 → fromPromise 更直白（自带 onDone/onError 和 output）。
