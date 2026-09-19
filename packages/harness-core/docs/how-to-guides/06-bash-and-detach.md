# 6. 引入 Bash：查看执行中的工具，并手动 detach

How-to：按当前 tool 协议写一个 Bash Feature；宿主从 snapshot / 机器事件读正在执行的工具，并通过 Feature facade 把前台进程挪到后台。harness-core 还没有 bash 实现，语义对齐 v2 `packages/agent-core-v2/src/agent/tools/os/bash/`。`detach` 协议见 [5](05-background-tool.md)。

没有 `agent.detach(toolCallId)`。机器只收工具 actor 自己发出的 `tool.detached`。宿主要手动后台，必须经过 Feature 持有的那次 `detach` 回调。

## Bash 工具怎么写

`run_in_background: true` 时立刻 `detach`，进程继续跑。前台跑则监听宿主的「挪到后台」信号，或超时后自行 detach（v2 的 `autoBackgroundOnTimeout`）。

```ts
const pending = new Map<string, (text: string) => void>();

function createBashTool(): ToolDefinition {
  return {
    name: 'Bash',
    description: '…',
    parameters: { /* command, cwd, timeout, run_in_background, description */ },
    async execute({ toolCall, signal, onUpdate, detach }) {
      const args = JSON.parse(toolCall.arguments ?? '{}') as {
        command?: string;
        run_in_background?: boolean;
      };
      const proc = spawn(args.command ?? '');
      const ack = (why: string) =>
        `task_id: ${toolCall.id}\nstatus: running\nreason: ${why}`;

      if (args.run_in_background === true) {
        detach?.(ack('run_in_background'));
      } else if (detach !== undefined) {
        pending.set(toolCall.id, detach);
      }

      try {
        proc.on('data', (chunk) => onUpdate?.({ key: 'stdout', text: chunk }));
        const output = await proc.wait(signal);
        return { content: [{ type: 'text', text: output }] };
      } finally {
        pending.delete(toolCall.id);
      }
    },
  };
}

export const BashRef = createToken<{
  running(): readonly string[];
  detach(toolCallId: string, text?: string): boolean;
}>('bash');

export const bash = createFeature('bash', {
  agent() {
    useAgentTools(createBashTool());
    useExpose(BashRef, {
      running: () => [...pending.keys()],
      detach: (toolCallId, text) => {
        const fn = pending.get(toolCallId);
        if (fn === undefined) return false;
        fn(text ?? `task_id: ${toolCallId}\nstatus: running\nreason: host`);
        pending.delete(toolCallId);
        return true;
      },
    });
  },
});
```

`pending` 只登记**还没** detach 的前台调用。已经 `run_in_background` 的不进这张表，已经在 `background` 里。

## 外部怎么看正在执行的工具

两层，用途不同。

**机器快照**（所有工具，含别人写的）：

```ts
const snap = agent.snapshot.value;
const turnTools = snap?.context.turnTools ?? {};
const background = snap?.context.background ?? {};

const foreground = Object.values(turnTools).map((entry) => entry.toolCall);
const asyncTools = Object.values(background).map((entry) => entry.toolCall);
```

`turnTools` 是本 turn 还没 ack 的 actor；`background` 是已 detach、结果尚未回来的 actor。`toolCall.id` / `name` / `arguments` 都在。这是活机器 context，不落盘，刷新看 `snapshot` 这支 Ref。

**机器事件**（过程）：

```ts
agent.on('turn.spawn_tools', (event) => {
  event.toolCalls; // 本步刚派出去的
});
agent.on('tool.update', (event) => {
  event.toolCallId;
  event.update; // { key, text, percent? }
});
agent.on('tool.detached', (event) => {
  event.toolCallId;
  event.text;
});
```

**产品 facade**（只暴露你想给 UI 的）：`agent.resolve(BashRef).running()`。UI 默认走这一层，不要把 `turnTools` 的 actor ref 传出进程。

## 手动 detach

```ts
const bashFace = agent.resolve(BashRef);
if (!bashFace.detach(toolCallId)) {
  throw new Error('not a foreground bash, or already detached');
}
```

`detach` 成功后：

1. 工具机发 `tool.detached`，agent 把该条从 `turnTools` 挪到 `background`
2. turn 收到 ack 文案，本步可以结束
3. 进程继续；`execute` resolve 后当 `source: 'async-tool'` notification 回来
4. 模型若必须等结果，用 WaitFor（[5](05-background-tool.md)）

已经在 `background` 里的再调 `BashRef.detach` 返回 `false`。要停掉后台进程走 abort / 你自己的 stop facade，不是再 detach。

## 相关文档

- 可后台 Tool → [05](05-background-tool.md)
- 工具事件 → [events](../reference/events.md)
- 下一篇：provider-catalog → [07](07-use-provider-catalog.md)
