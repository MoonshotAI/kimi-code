# Feature 模型

一个产品能力只落地一次 `createFeature`：配方是一份纯定义，挂载与卸载全部由产品树驱动。

## 配方与实例

```ts
export const todo = createFeature('todo', {
  agent() { /* 同步 setup */ },
});
```

`createFeature(name, slots)` 把每个 slot 收成 `createUnit(\`${name}:${tier}\`, setup)`。同一 spec 装进不同 session / agent，得到独立节点、独立状态。名单是 pull：`features`（`src/preset.ts`）或宿主传入的数组；运行中再用 `app.installFeature` / `uninstallFeature`。

需要构造期依赖时用工厂，返回 `FeatureSpec`：

```ts
export function createCompaction(deps: CreateCompactionDeps): FeatureSpec {
  return createFeature('compaction', { agent() { /* 闭包里用 deps */ } });
}
```

`createMedia`、`createToolSelect`、`createHttp` 同此。它们不进默认 preset，由宿主推进名单。

## 三层 slot 怎么选

| 层 | 何时用 | 现成例子 |
|---|---|---|
| `app()` | 进程内单例：HTTP 路由、全局 catalog | `createHttp` |
| `session()` | 会话共享：Interaction 登记表、session journal 投影 | `interaction` |
| `agent()` | 跟 journal / 工具 / turn hook / 机器事件绑定 | `todo`、`usage`、`timing`、`waitFor` |

一个 Feature 可以同时占多层。上层 `useExpose`，下层 `inject`。`interaction`：session 持表并 `useFire`，agent 取同一份表、挂 `AskUserQuestion`、卸载时 `cancelAgent`。

## 贡献面

agent slot 里读命令面用 `useAgent` / `useSession` / `useApp`：它们给出收窄后的 Commands 面（提交、配置、订阅），Feature 摸不到节点内部结构。绑 generate 用 `useAgent().setConfig` / `setCredentialProvider` / `setRequester`。往回合里加东西用贡献 hook，卸载自动撤回：

- 工具 / 系统提示：`useAgentTools`、`useSystemPrompt`
- 拦截缝：`useBeforeStep`、`useBeforeTool`、`useAfterTool`、`usePromptGate`
- LLM：`useMessageResolver`、`useLlmRecovery`、`useLlmRetryable`、`useMediaLower`
- 状态：`useAgentStore` / `useSessionStore` 的 `fold` / `dispatch`，大字段 `useBlobs`

system prompt 的 `host` 段留给创建 agent 时的 `systemPrompt`。第一次组包冻住拼装，之后改 text、卸载、晚到的 section 都不改已出示的字节。

完整表见 [contribution-hooks](../reference/contribution-hooks.md)。

## 对外契约

宿主和兄弟只依赖包入口导出的符号，契约因此收窄到一个 token：

1. `createToken` 一个 facade。
2. slot 里 `useExpose(Token, face)`，挂到父节点，随本节点撤销。
3. 包入口导出 Token 与类型。
4. 外部 `session.resolve(Token)` 或 `app.resolve(Token)`。

有自己的节点事件时，把联合类型挂在配方上：`createFeature<InteractionEvent>('interaction', …)`。订阅写成 `session.on(interaction, 'interaction.requested', handler)`；`on(feature, '*')` 按 `featureName.` 前缀过滤。

## 跨 Feature

协作只走 token / collection：拥有方导出 collection，贡献方 `useContribute`，依赖方向只剩包入口的导出符号，每个 Feature 才能独立装卸。宿主端口同样：`host/` 定义 token，Feature `inject`，CLI 在 `mountApp({ provide })` 注入。

## 相关文档

- 动手写一个 → [02](../how-to-guides/02-add-todo-feature.md) · [08](../how-to-guides/08-develop-feature.md)
- 外部怎么取 facade → [04](../how-to-guides/04-expose-facade.md)
- hook 契约 → [contribution-hooks](../reference/contribution-hooks.md)
