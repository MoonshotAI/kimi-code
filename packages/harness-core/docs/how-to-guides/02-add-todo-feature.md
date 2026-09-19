# 2. 添加一个 Todo Feature

How-to：一个 Todo Feature 由三块组成——自有 store（投影 + `dispatch`）、reminder（听机器事件后 `notify`）、给模型的 TodoList 工具。对照实现：`src/features/todo/`。怎么写投影见 [Store 模型](../explanation/store-model.md)。builtin 扩展点表见 [contribution-hooks](../reference/contribution-hooks.md)。通用清单见 [8. 开发一个 Feature](08-develop-feature.md)。

## 三块各管什么

| 块 | 职责 | 写在哪 |
|---|---|---|
| store | `todo.updated` 是事实；`todos` 投影出列表和「第几轮写过」 | `projection.ts` |
| reminder | 列表非空、未全部 done、且两轮没人改过 → `agent.notify` 一条 system reminder | `feature.ts` 里 `agent.on('turn.started')` |
| tool | 模型读/写列表；写则 `store.dispatch` | `tool.ts` + `todo-list.md` |

不要把列表塞进 Unit 本地变量。恢复时重放事件，不重跑 `execute`。

## 1. Store：事件 + 投影

agent journal 是开放的 `RecordEvent`。`decodeAgent` 只认识 `input.submitted` / `message.appended` / `turn.started` / `turn.ended`，其它 type 原样留下。

```ts
export const TODO_UPDATED = 'todo.updated';

export const todos: Projection<TodoState, RecordEvent, BranchRef> = {
  initial: () => ({ todos: [], currentTurn: 0, lastWriteTurn: 0 }),
  reduce: (state, event) => {
    if (event.type === TODO_UPDATED) {
      return {
        todos: readTodoItems(event['todos']),
        currentTurn: state.currentTurn,
        lastWriteTurn:
          typeof event['lastWriteTurn'] === 'number' ? event['lastWriteTurn'] : state.lastWriteTurn,
      };
    }
    if (event.type === 'turn.started') {
      return { ...state, currentTurn: state.currentTurn + 1 };
    }
    return state;
  },
};
```

reducer 同步、确定、不做 I/O。setup 里：

```ts
const store = useAgentStore();
const state = store.fold(todos);
```

写入口只有 `store.dispatch({ type: TODO_UPDATED, todos, lastWriteTurn })`。原则见 [Store 模型](../explanation/store-model.md)。

## 2. Reminder：听 turn，往队列旁路塞一条

reminder 不是第二份 store。它读投影，用 `notify` 进 `notifications`，下一次 `turn.drain` 进 history。

```ts
const agent = useAgent();
agent.on('turn.started', () => {
  const current = state.value;
  if (current.todos.length === 0) return;
  if (current.todos.every((item) => item.status === 'done')) return;
  if (current.currentTurn - current.lastWriteTurn !== 2) return;
  agent.notify(
    createHistoryMessageBuilder()
      .systemReminder(`The todo list has not been updated recently.\n${renderTodoList(current.todos)}`)
      .userMessage(),
  );
});
```

`agent.on` 是机器事件。跨重启活着的 reminders 投影目前恒为空数组；stale nudge 只活在当前进程。

## 3. Tool：给模型读写口

`useAgentTools` 登记。`execute` 不在 setup 里跑，不能在 execute 里 `inject`；需要的 `store` / `state` 在 setup 闭包捕获。

```ts
useAgentTools(createTodoListTool(store, state));
```

工具自己：

- 省略 `todos` 参数 → 只读，返回当前列表文本
- 传入数组 → `dispatch(TODO_UPDATED)`，再返回渲染结果
- 空数组 → 清空

参数 schema 与说明写在 `todo-list.md`（`?raw` 导入）。卸载 Feature 时 `useAgentTools` 已 `pushCleanup`，工具从 `getTools()` 消失。

## 4. 装上

`todo` 已在 `src/preset.ts`。自己写的同类能力推进名单：

```ts
mountApp({
  features: [...features, myTodo],
});
```

宿主读列表用 facade（[4. 暴露 facade](04-expose-facade.md)）：`agent.resolve(TodoRef).items.value`。

## 相关文档

- 投影怎么写 → [store-model](../explanation/store-model.md)
- builtin 扩展点 → [contribution-hooks](../reference/contribution-hooks.md)
- 下一篇：听事件并触发请求 → [03](03-listen-and-trigger.md)
