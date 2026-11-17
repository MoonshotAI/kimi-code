# Kimi Agent Protocol (KAP)

`kimi web` 启动的本地服务（以及 Kimi Code 桌面端内嵌服务）对外提供 **Kimi Agent Protocol（KAP）**：一套基于 HTTP REST（`/api/v1`）与 WebSocket（`/api/v1/ws`）的本地 Agent 控制协议（`0.x Beta`）。KAP 最核心的用途是**让另一个活的 AI Agent 在运行时通过纯 HTTP 交互式驾驭本机 Kimi Code**（派发监工、中途纠偏、代批权限、接手续跑与批量整理会话——区别于黑盒批处理的 `kimi -p`），同时也支持自建机器人与自定义工作台轻量接入。

完整行为规范收录于 [`https://code.kimi.com/kimi-code/kap.md`](https://code.kimi.com/kimi-code/kap.md)；任何运行中的服务实例也内置提供与自身版本完全一致的 `GET /api/v1/kap.md`、`GET /openapi.json` 与 `GET /asyncapi.json`。

## KAP 能做什么

- **纯 HTTP 交互式驾驭（零 WebSocket 负担）**：另一个 Agent 只需普通 HTTP 请求即可创建或检索会话、提交输入（`/prompts`）、同步阻塞等待下一个停顿点（`POST /sessions/{id}:wait`，在轮次结束或出现挂起审批/提问时立即带回状态与待决交互）、读取并代为答复工具审批与提问（`/interactions`）、中途探头检查实时进度（`/turns`）并插话纠偏（`/steer`）。
- **接手续跑与批量会话治理**：跨工作区检索本机已有会话（含桌面端与 CLI 会话），检查卡点、分叉（`:fork`）探索替代方案、更新会话标题与配置（`/profile`）或批量归档已完成会话（`/sessions:archive`）。
- **实时事件与任务流（面向机器人与自定义界面）**：需要逐字流式渲染的 IM 机器人或内部工作台，可按需挂载单条 `/api/v1/ws` WebSocket 连接，订阅结构化 `Turn` / `Item` 增量与 Shell / subagent 后台任务输出流。

## 选择接入方式

| 你想做什么 | 使用 | 能获得什么 |
| --- | --- | --- |
| 让另一个 AI Agent 在运行时交互式驾驭 Kimi Code（观察进展、中途纠偏、代批权限、接手续跑、整理会话），或自建机器人 / 内部工作台客户端 | **KAP** | 常驻 HTTP + WebSocket 服务（桌面端内嵌或 [`kimi web`](../reference/kimi-command.md#kimi-web)），支持纯 HTTP `:wait` + `/interactions` 监工闭环、实时流式对话、中途 `/steer` 插话，以及完整的[会话管理](./sessions.md)、[Skills](../customization/skills.md)、[插件](../customization/plugins.md)与 [MCP](../customization/mcp.md) 能力。 |
| 将 Kimi Code 接入支持 ACP 标准的编辑器或 IDE（如 Zed、JetBrains AI Chat） | **[`kimi acp`](../reference/kimi-acp.md)** | 运行在子进程 `stdio` 上的 [Agent Client Protocol](https://agentclientprotocol.com/) 服务，与单个宿主 IDE 窗口绑定，支持多轮会话、工具审批，并可将文件读写与终端执行委托给 IDE（配置方法见[在 IDE 中使用](./ides.md)）。 |
| 在终端做日常交互式开发，或在脚本、CI/CD 中委派**一次性、无需中途干预**的单次任务 | **[`kimi` / `kimi -p`](../reference/kimi-command.md#非交互执行)** | 面向日常开发的终端交互界面（TUI）；一次性无交互任务直接运行 `kimi -p "任务" --output-format stream-json`，向 stdout 输出结构化 JSONL 流并在完成后自动退出，无需启动常驻服务。 |

## 用 AI Agent 快速接入 / 操控

> **前置分流**：如果只需一次性派发任务、跑完拿结果即可（无需中途观察、纠偏或代批权限），直接执行 `kimi -p "任务描述" --output-format stream-json`，无需启动 KAP 服务。

需要中途监工、接手续跑、批量整理会话或自建客户端时，直接复制下方对应提示词并替换方括号发给你的 AI Agent：

### 场景 1：派发新任务并全程监工

```text
请通过 KAP 协议驱动本机的 Kimi Code 完成以下任务：[具体开发或重构任务]。在它执行期间由你负责观察进展、按需中途插话纠偏并代为处理工具审批与提问；协议说明见 https://code.kimi.com/kimi-code/kap.md 。
```

### 场景 2：接手并续跑已有会话

```text
请通过 KAP 协议在本机 Kimi Code 中找到关于 [某个主题或会话 ID] 的会话，读取它目前的进度与卡点，基于它继续推进（必要时先 fork 出新分支再修改）直至完成；协议说明见 https://code.kimi.com/kimi-code/kap.md 。
```

### 场景 3：批量整理与盘点历史会话

```text
请通过 KAP 协议帮我整理本机的 Kimi Code 历史会话：审阅近期会话内容，通过 profile 接口为标题含糊的会话更新清晰标题，将已完成或一次性测试的会话归档，并汇总出仍在进行中的工作清单；协议说明见 https://code.kimi.com/kimi-code/kap.md 。
```

### 场景 4：自建机器人或自定义工作台客户端

```text
我在做 [飞书机器人 / 内部研发工作台]，想要底层的 Agent 服务通过 KAP 协议接入 Kimi Code，完整协议规范在 https://code.kimi.com/kimi-code/kap.md ，请按规范帮我完成接入。
```

## 连接与鉴权方式

本机调用方按需选择以下任一方式获取服务地址与 Bearer Token（连上后可随时请求 `GET /api/v1/kap.md` 读取与当前运行版本一致的内置协议文档）：

- **直连本机正在运行的桌面端或 `kimi web` 实例**：扫描 `~/.kimi-code/server/instances/*.json` 找到存活实例（校验 `pid` 存活），并使用本机 `0600` 权限的 `~/.kimi-code/server.token` 作为 `Authorization: Bearer <token>` 即可零弹窗直连。
- **子进程按需拉起独立实例**：执行 `kimi web --port 0 --json`。进程自动跳过打开浏览器，在内存中生成仅随本进程存活的随机 Bearer Token（不读写、不打印全局 `server.token`），就绪后在 `stdout` 首行输出单行纯 JSON：`{"origin":"http://127.0.0.1:<port>","ws_url":"ws://127.0.0.1:<port>/api/v1/ws","token":"...","kimi_agent_protocol_version":"0.1.0"}`。

## 快速开始（纯 HTTP 闭环）

下面用一段零依赖的 Node.js 脚本演示**不写任何 WebSocket 代码**，通过 `kimi web --port 0 --json` 拉起服务、创建会话、提交任务、用 `:wait` 循环等待停顿点并自动处理工具审批，最后读取完整回复。保存为 `demo.mjs` 后运行 `node demo.mjs`：

```js
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const proc = spawn('kimi', ['web', '--port', '0', '--json'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const { value: bootLine } = await createInterface({ input: proc.stdout })[Symbol.asyncIterator]().next();
const { origin, token } = JSON.parse(bootLine);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

try {
  const { data: session } = await fetch(`${origin}/api/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cwd: process.cwd() }),
  }).then((r) => r.json());

  await fetch(`${origin}/api/v1/sessions/${session.id}/prompts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt_id: 'p-1',
      content: [{ type: 'text', text: '用一句话介绍当前目录' }],
    }),
  });

  while (true) {
    const { data: waited } = await fetch(`${origin}/api/v1/sessions/${session.id}:wait`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ timeout_ms: 15000 }),
    }).then((r) => r.json());

    for (const item of waited.pending_interactions) {
      const body =
        item.kind === 'approval'
          ? { kind: 'approval', decision: 'approved' }
          : { kind: 'question', dismissed: true };
      await fetch(`${origin}/api/v1/sessions/${session.id}/interactions/${item.interaction_id}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    }

    if (waited.pending_interactions.length === 0 && waited.session.activity !== 'turn') {
      break;
    }
  }

  const { data: page } = await fetch(
    `${origin}/api/v1/sessions/${session.id}/agents/main/turns?page_size=5`,
    { headers },
  ).then((r) => r.json());
  const lastTurn = page.turns.at(-1);
  for (const item of lastTurn?.items ?? []) {
    if (item.type === 'assistant_message') process.stdout.write(`${item.text}\n`);
  }
} finally {
  proc.kill('SIGTERM');
}
```

需要逐 token 流式渲染对话或订阅后台任务输出的机器人与界面客户端，请参考 [`kap.md`](https://code.kimi.com/kimi-code/kap.md) 中的 WebSocket 实时流归并章节。

## 下一步

- [`kap.md` 完整协议规范](https://code.kimi.com/kimi-code/kap.md) — 纯 HTTP Agent 监工路径、WebSocket 流式归并规则、`meta.capabilities` 探测与接口目录
- [`kimi` 命令](../reference/kimi-command.md#kimi-web) — `kimi web --json` 与 `-p` 非交互模式的命令行选项
- [在 IDE 中使用](./ides.md) — 通过 `kimi acp` 接入 Zed 与 JetBrains IDE
