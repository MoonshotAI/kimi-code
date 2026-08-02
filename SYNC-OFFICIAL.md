# 二开版本同步官方提交指南

> **文档目的**：说明 `kimi-code-rebuild` 二开版本如何与官方仓库 `MoonshotAI/kimi-code` 的 `main` 分支保持同步。
> **适用范围**：所有在 `rebuild-from-fork` 分支上进行二次开发的维护者。
> **最后核对日期**：2026-08-02（官方 `main` tip = `e22479a6`）

---

## 一、当前状态快照

### 1.1 仓库与远程

| 远程名 | 仓库 | 用途 |
|---|---|---|
| `official` | `https://github.com/MoonshotAI/kimi-code.git` | 官方上游，同步来源 |
| `origin` | `https://github.com/wangfeizong1001/kimi-code.git` | 二开 fork，推送目标 |

### 1.2 分支与基点

```
official/main  ── e22479a6  (官方最新 tip，与 rebuild 基点完全相同)
       │
       │  + 10 个二开 commit (rebuild-from-fork 分支)
       │  + 未提交的 MCP 管理 / provider PATCH 改动
       ▼
     HEAD  (当前工作树)
```

- **二开分支**：`rebuild-from-fork`
- **基点 commit**：`e22479a6`（即 `official/main` 当前 tip）
- **领先官方**：10 个 commit + 工作树未提交改动
- **漂移**：0（官方自二开创建以来无新提交）

### 1.3 二开 commit 清单

```
2d2eda60 docs: 补充 AGENTS.md / kimi-binding-analysis.md / CHANGELOG 合并
c2880723 feat(kap-server): fs 写入 + session exec/git actions
2f2479d2 feat(agent-core-v2): IGitService / workspaceFs 写入 / vendors.contrib
aa0896c6 feat(kap-server): provider wire types / deleteProvider / disableAuth
7412f26e feat(oauth): 通用 OpenAI 兼容 provider
f27890b5 feat(kimi-code): --dangerous-bypass-auth
070f20da feat(kimi-web): provider 管理 + auth gate 移除
f4c6eb92 refactor(agent-core): 解耦 provider 检查
fbabef59 chore: 移植低风险 fork 定制
d91c4018 feat: 移植 fork 定制 - skills / vendors.contrib / changelog
───────────── 以上为已提交的 10 个 commit ─────────────
(工作树)  feat(kap-server): MCP 服务器配置管理 (REST + 前端)
(工作树)  fix(kap-server): 新增 PATCH /providers/{id} 部分更新路由
```

---

## 二、二开改动文件分类与冲突风险

二开共改动 **105 个文件**，按冲突风险分三级。

### 2.1 低风险：纯新增文件（官方无此文件，rebase 几乎不冲突）

约 70 个文件，主要分布：

| 目录 | 内容 |
|---|---|
| `.agents/skills/**` | 55 个 Skill 文档（brainstorming、chinese-*、systematic-debugging 等） |
| `.agents/rules.md` | 全局规则 |
| `AGENTS.md`、`kimi-binding-analysis.md` | 仓库说明文档 |
| `apps/kimi-web/src/components/settings/ProviderManager.vue` | 新增 Provider 管理组件 |
| `apps/kimi-web/src/i18n/locales/{en,zh}/providers.ts` | 新增 Provider i18n |
| `apps/kimi-web/src/lib/providerPresets.ts` | Provider 预设 |
| `packages/agent-core-v2/src/kosong/provider/providers/vendors.contrib.ts` | 厂商贡献配置 |
| `packages/agent-core-v2/src/app/git/gitService.ts` | IGitService 实现 |
| `packages/agent-core-v2/CHANGELOG.md`、`packages/kap-server/CHANGELOG.md` | 子包变更日志 |
| `packages/pi-tui/native/darwin/prebuilds/*.node` | macOS 原生二进制 |

> **同步策略**：无需处理，rebase 自动带过。

### 2.2 中风险：修改官方既有文件（可能冲突，需手工合并）

约 30 个文件，集中在 kap-server、agent-core-v2、oauth、kimi-web：

| 文件 | 改动性质 |
|---|---|
| `packages/kap-server/src/routes/modelCatalog.ts` | 新增 PATCH /providers 路由、provider 管理 |
| `packages/kap-server/src/protocol/rest-modelCatalog.ts` | 新增 patchProviderRequestSchema |
| `packages/kap-server/src/routes/sessions.ts` | session exec/git actions |
| `packages/kap-server/src/routes/fs.ts` | fs 写入扩展 |
| `packages/kap-server/src/start.ts` | disableAuth 默认值 |
| `packages/agent-core-v2/src/workspace/workspaceFs/fs.ts` | fs 写入扩展 |
| `packages/agent-core-v2/src/app/git/git.ts` | git actions 集成 |
| `packages/agent-core-v2/src/index.ts` | 导出 IGitService |
| `packages/agent-core/src/agent/llm-request-recorder.ts` | provider 解耦 |
| `packages/agent-core/src/config/kimi-env-params.ts` | 新增 env 参数 |
| `packages/oauth/src/*.ts` | 通用 OpenAI 兼容 provider |
| `apps/kimi-web/src/api/daemon/client.ts` | provider/MCP 客户端方法 |
| `apps/kimi-web/src/api/types.ts` | KimiWebApi 接口扩展 |
| `apps/kimi-web/src/components/settings/SettingsDialog.vue` | MCP/Skills 标签页 |
| `apps/kimi-web/src/composables/useKimiWebClient.ts` | MCP/provider 状态 |
| `apps/kimi-web/src/i18n/locales/{en,zh}/{common,settings}.ts` | 文案 |

> **同步策略**：rebase 时若官方同文件有改动，按「二开改动是叠加，官方改动是基线演进」原则合并；保留二开的新增函数/路由，接纳官方对既有逻辑的修正。

### 2.3 高风险：核心入口/配置文件（冲突概率高）

| 文件 | 风险点 |
|---|---|
| `apps/kimi-web/src/App.vue` | auth gate 移除 + provider 接线，与官方 UI 主入口强耦合 |
| `apps/kimi-code/package.json` | `--dangerous-bypass-auth` 入口 |
| `.gitignore` | 二开新增忽略项 |
| `CHANGELOG.md` | 合并式改动，易文本冲突 |
| `packages/klient/Dockerfile`、`scripts/run-docker-e2e.sh` | e2e 环境改动 |

> **同步策略**：逐行人工核对，优先保留官方对构建/入口的修正，再叠加二开的功能开关。

---

## 三、标准同步流程

### 3.1 前置准备

```powershell
# 1. 确保工作树干净
cd e:\git-clone\kimi-2026-8-1\kimi-code-rebuild
git status                          # 必须是 clean

# 2. 确认远程配置
git remote -v
# official  https://github.com/MoonshotAI/kimi-code.git
# origin    https://github.com/wangfeizong1001/kimi-code.git

# 3. 备份当前分支（重要）
git branch backup/pre-sync-$(Get-Date -Format yyyyMMdd)
```

### 3.2 拉取官方最新提交

```powershell
# 拉取 official/main
git fetch official main

# 查看官方新增了多少 commit
git log --oneline e22479a6..official/main
# 若为空 → 官方无新提交，无需同步
# 若有输出 → 进入 rebase 流程
```

### 3.3 Rebase 二开 commit 到官方最新

```powershell
# 切到二开分支
git checkout rebuild-from-fork

# rebase 到 official/main
git rebase official/main
```

### 3.4 处理冲突（若有）

rebase 会逐个 commit 重放。遇到冲突：

```powershell
# 1. 查看冲突文件
git status

# 2. 编辑冲突文件，按第二节的风险分级策略合并
#    - 低风险（新增文件）：直接 git add
#    - 中风险：保留二开新增函数/路由，接纳官方修正
#    - 高风险：人工逐行核对

# 3. 标记已解决
git add <已解决的文件>

# 4. 继续 rebase
git rebase --continue

# 若某个 commit 冲突过于复杂，可跳过并事后手工补：
#   git rebase --skip   (谨慎，会丢失该 commit 的改动)
```

### 3.5 验证

```powershell
# 全量 typecheck（必须全绿）
pnpm --filter @moonshot-ai/agent-core run typecheck
pnpm --filter @moonshot-ai/agent-core-v2 run typecheck
pnpm --filter @moonshot-ai/kap-server run typecheck
pnpm --filter @moonshot-ai/oauth run typecheck
pnpm --filter @moonshot-ai/kimi-code run typecheck
pnpm --filter @moonshot-ai/kimi-web run typecheck
pnpm --filter @moonshot-ai/vis-server run typecheck
pnpm --filter @moonshot-ai/vis-web run typecheck

# 前端风格检查
pnpm --filter @moonshot-ai/kimi-web run check:style

# 关键接口冒烟（kap-server 启动后）
# GET  /api/v1/meta
# GET  /api/v1/providers
# GET  /api/v1/mcp/config/servers
# PATCH /api/v1/providers/__test__   (期望 PROVIDER_NOT_FOUND，证明路由在)
```

### 3.6 推送

```powershell
# rebase 改写了历史，必须 force-with-lease（不要用裸 force）
git push origin rebuild-from-fork --force-with-lease
```

> **警告**：永远不要 `git push --force`（裸 force）。`--force-with-lease` 会在远程被他人更新时拒绝推送，保护协作者的工作。

---

## 四、关键接缝区合并原则

二开与官方的「接缝」集中在以下功能点，rebase 时按原则处理：

| 接缝 | 二开改动 | 合并原则 |
|---|---|---|
| MCP 配置管理 | 新增 `/api/v1/mcp/config/servers` 路由 | 独立命名空间，若官方未来加 MCP 管理路由，优先采用官方实现，二开路由降级或移除 |
| Provider PATCH | 新增 `PATCH /providers/{id}` | 与官方 PUT 互补；若官方自带 PATCH，删除二开版本 |
| Provider CRUD UI | kimi-web ProviderManager.vue | 若官方原生支持 provider 管理 UI，评估替换 |
| OAuth 通用 provider | `packages/oauth/src` 扩展 | 若官方 OAuth 演进，逐文件合并 |
| `--dangerous-bypass-auth` | kimi-code 入口开关 | 若官方提供等价机制，移除二开开关 |
| workspaceFs 写入 | agent-core-v2 fs 扩展 | 接纳官方 fs 演进，保留二开的写入方法 |
| IGitService | agent-core-v2 新接口 | 若官方自带等价接口，迁移到官方接口 |

---

## 五、回滚方案

若 rebase 后验证失败且无法快速修复：

```powershell
# 1. 中止进行中的 rebase
git rebase --abort

# 2. 回到同步前的备份分支
git reset --hard backup/pre-sync-<日期>

# 3. 二开工作完整恢复，可重新分析冲突原因后再试
```

---

## 六、FAQ

### Q1：官方一直没新提交，我需要做什么？
无需任何操作。当前基点 `e22479a6` 即官方最新，二开工作直接在 `rebuild-from-fork` 上继续即可。定期执行 `git fetch official main` 检查即可。

### Q2：rebase 时 `CHANGELOG.md` 总是文本冲突，怎么处理？
`CHANGELOG.md` 是合并式改动。建议：rebase 时先 `git checkout --theirs CHANGELOG.md`（采纳官方版本），rebase 完成后手工把二开的变更条目追加到官方版本顶部。

### Q3：能否用 merge 代替 rebase？
技术上可以（`git merge official/main`），但会产生 merge commit，长期积累会让历史变臃肿、难追踪二开到底改了什么。**推荐 rebase**，保持线性历史，二开改动始终清晰叠加在官方基线之上。

### Q4：force push 后协作者怎么办？
协作者执行：
```powershell
git fetch origin
git checkout rebuild-from-fork
git reset --hard origin/rebuild-from-fork
```
（前提是协作者本地没有未推送的工作，否则需先 stash 或备份。）

### Q5：如何快速判断本次同步是否需要手工合并？
```powershell
git fetch official main
# 看官方新提交动了哪些「中/高风险」文件
git diff --name-only e22479a6..official/main | Select-String -Pattern "modelCatalog|App\.vue|oauth|types\.ts|start\.ts"
```
若输出为空，本次同步大概率可自动 rebase 无冲突。

---

## 七、维护约定

- 本文档每次完成官方同步后更新「最后核对日期」与基点 commit
- 二开新增 commit 后，补充到第 1.3 节清单
- 接缝区（第四节）若官方已提供等价实现，及时标注并安排替换
