# coding-style: Optional 属性直接传 undefined，不用 conditional spread
tags: typescript, style, object
scope: packages/

对可选对象属性，直接传 `undefined`，不用条件展开。

- YES: `{ user }`
- NO: `{ ...(user ? { user } : undefined) }`

---

# coding-style: Optional 属性类型不需要额外加 | undefined
tags: typescript, interface, style
scope: packages/

可选属性声明时不需要额外允许 `undefined`。

- YES: `interface Options { user?: User }`
- NO: `interface Options { user?: User | undefined }`

---

# coding-style: Import 使用 #/ 前缀
tags: typescript, import, path-alias
scope: packages/

所有内部 import 使用 `#/` 路径别名（等同于 `@/`），不用相对路径 `../`。

---

# coding-style: index.ts 只做 re-export
tags: typescript, module, export
scope: packages/

除了 package 入口的 `index.ts`，其他 `index.ts` 应使用 `export * from './module'` 形式。

---

# coding-style: 单参数内部方法不要包装成 options 对象
tags: typescript, api-design
scope: packages/

只有一个参数的内部方法不应为了风格统一而转换为 options 对象。

---

# architecture: apps/kimi-code 不能直接依赖 agent-core
tags: dependency, kimi-code, agent-core
scope: apps/kimi-code/

CLI/TUI 应用通过 `@moonshot-ai/kimi-code-sdk` 消费核心能力，不可直接依赖 `@moonshot-ai/agent-core`。

---

# architecture: apps/kimi-web 不能依赖 agent-core
tags: dependency, kimi-web, agent-core
scope: apps/kimi-web/

Web UI 不依赖 `@moonshot-ai/agent-core`，wire types 在本地重新实现。

---

# architecture: Agent 类必须独立于 Session
tags: agent-core, class-design, session
scope: packages/agent-core/src/agent/

`Agent` 类构造函数不可强制要求创建 `Session` 实例，不可要求 `agentId` 或 `session`。可接受可选 `sessionId` 作为 hint，但实例不可持有 `sessionId`，不可依赖 Session 生命周期。

---

# workflow: 提交前必须生成 changeset
tags: git, changeset, pr
scope: 

每次代码变更提交 PR 前必须运行 `gen-changesets` skill（`.agents/skills/gen-changesets/SKILL.md`），在 `.changeset/` 下生成 changeset。

---

# workflow: 不可自行决定 major bump
tags: changeset, semver, breaking-change
scope: 

生成 changeset 时，**永远不能**自行决定 `major` bump。当判断变更符合 major 标准（breaking changes、不兼容配置、删除命令等），必须停下来向用户解释并请求确认。只有用户明确同意后才能写 `major`。

---

# workflow: PR 标题使用 Conventional Commit 格式
tags: git, pr, naming
scope: 

PR 标题必须遵循 Conventional Commit 风格，如 `chore: remove legacy format commands`。

---

# workflow: 每次 commit 后必须 push
tags: git, push, remote
scope: 

每次 `git commit` 之后必须立即执行 `git push`，确保本地和远程始终保持一致。禁止只提交到本地而不推送。

---

# workflow: 不要提交临时文件
tags: git, scratch, cleanup
scope: 

不提交 throwaway 文件：agent 笔记（`HANDOVER-*.md`）、原型（`*-designs.html`）等。提交前 `git status` 检查，临时文件放 `.tmp/`。

---

# workflow: 公开文本使用中性占位符
tags: security, placeholder, pr
scope: 

公开文本和测试数据中，将真实内部标识符替换为 `example.com`、`example.test`、`YOUR_API_KEY` 等中性占位符。提交 PR 前审计 diff。

---

# pitfall: pnpm-workspace.yaml 和 flake.nix 必须同步
tags: monorepo, nix, workspace
scope: 

增删 workspace 包时必须同时更新 `pnpm-workspace.yaml` 和 `flake.nix`。flake.nix 是手动维护的，CI 检查只覆盖 kimi-code 的传递依赖闭包，遗漏不会被自动发现。

---

# pitfall: flake.nix workspace 检查有盲区
tags: nix, ci, workspace
scope: 

`scripts/check-nix-workspace.mjs` 只验证 `@moonshot-ai/kimi-code` 的依赖闭包。闭包外的叶子包（如 e2e）即使缺失也不会报错。不能依赖绿色 CI 判断 flake.nix 是否完整。

---

# pitfall: Node 版本不满足时 pnpm install 会失败
tags: node, pnpm, environment
scope: 

需要 Node.js >= 24.15.0，pnpm 10.33.0。`.npmrc` 设置了 `engine-strict=true`，版本不对 `pnpm install` 直接报错。

---

# architecture: 实验特性用 flag 开关
tags: feature-flag, experimental
scope: packages/agent-core/src/flags/

新特性 gate 在 `packages/agent-core/src/flags/registry.ts` 注册 flag，用 `flags.enabled('my-feature')` 检查。环境变量 `KIMI_CODE_EXPERIMENTAL_<NAME>` 开关单个，`KIMI_CODE_EXPERIMENTAL_FLAG` 开全部。

---

# workflow: 代码是 source of truth，不是文档
tags: principle, documentation, code
scope: 

除非用户明确要求，不要通过阅读普通 Markdown 来理解实现。以代码为准。

---

# workflow: 变更必须聚焦
tags: principle, diff, refactor
scope: 

保持变更聚焦。不要夹带无关重构。

---

# workflow: 修改代码前先读代码和约束
tags: principle, read-first
scope: 

修改代码前，先读相关代码和最近的约束，遵循目录树中最近的 `AGENTS.md`。

---

# workflow: commit 不加 co-author 不暴露 agent 身份
tags: git, commit, identity
scope: 

提交时不加任何 co-author 署名，commit message / PR description 中不暴露 agent 身份。

---

# workflow: TUI 修改使用 write-tui skill
tags: tui, skill, kimi-code
scope: apps/kimi-code/

编写或修改 CLI/TUI 终端 UI 时，使用 `write-tui` skill（`.agents/skills/write-tui/SKILL.md`）。

---

# coding-style: 测试优先加入已有文件
tags: testing, file-organization
scope: 

不要添加太多新测试文件。优先将测试加入对应组件/模块的已有测试文件中。

---

# workflow: 测试失败默认修 test 不改实现
tags: testing, principle
scope: 

用户修改导致测试失败时，默认修复测试；除非实现真的有 bug，否则不改实现来迎合旧测试。
