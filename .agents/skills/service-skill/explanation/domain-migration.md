# Domain 迁移规范

本文是 di-v3 的 **domain 迁移规范**：把现有 `packages/agent-core/src/services/<domain>/` 逐 domain 迁到 `packages/agent-core/src/<domain>/`（契约 + 厚实现 + 工具同居）。本文不展开设计取舍，只给出可机械执行的步骤、硬规则与验收命令。

本文是 ROADMAP **P3.1–P3.8** 的逐步 recipe（`plan/ROADMAP.md:296-432`）。P3.x worker 应能按本文逐条落地一个 domain 的迁移，不留下任何待定的设计决策。

权威来源（本文对它们做规范化整理，命名以本文为准）：

- `plan/PLAN.md:166-195`（§2.3 每个 domain 目录的结构、§2.4 工具注册）
- `plan/ROADMAP.md:9-27`（Global constraints：barrel-only、禁止 re-import/re-export shim、依赖方向 fence）
- `plan/ROADMAP.md:296-432`（P3 阶段，尤其 P3.0 在 `:301-311`、P3 acceptance 在 `:432`）

## 目录

- [结论](#结论)
- [1. 目的与适用](#1-目的与适用)
- [2. 目标目录结构](#2-目标目录结构)
- [3. 依赖方向（fence）](#3-依赖方向fence)
- [4. 迁移步骤（⑦ 步，每步可验证）](#4-迁移步骤-步每步可验证)
- [5. 禁止事项（硬规则）](#5-禁止事项硬规则)
- [6. 每步验证门槛（强制）](#6-每步验证门槛强制)
- [7. 提交规范](#7-提交规范)
- [8. 偏离处理](#8-偏离处理)
- [9. 参考](#9-参考)

## 结论

每迁一个 domain，按下面的硬规则落地：

- **结构按 PLAN §2.3**：`<domain>.ts`（契约）+ `<domain>Service.ts`（厚实现）+ support files + `tools/`（如有）+ `index.ts`（barrel）。见 [§2](#2-目标目录结构)。
- **barrel-only 暴露（强制）**：每层只通过 `index.ts` 暴露公共面；consumer 一律从 barrel 导入（`#/<domain>` / `#/_base/<x>` / `@moonshot-ai/agent-core`），禁止 deep-import 子模块。见 [§2](#2-目标目录结构)、[§5](#5-禁止事项硬规则)。
- **不留旧路径 re-export alias / shim**：consumer 全量改写为新 barrel，旧路径 `services/<domain>/` 在同一步内删除。没有「deprecated，P9 删除」。见 [§4 步骤⑦](#4-迁移步骤-步每步可验证)、[§5](#5-禁止事项硬规则)。
- **依赖方向 fence 已 ACTIVE**：`_utils ← _base ← domains`，由 vitest fence（`packages/agent-core/test/dependency-direction.test.ts:608-614`）唯一强制；oxlint 无法表达该规则，**不要**新增 oxlint 近似规则。见 [§3](#3-依赖方向fence)。
- **新增顶层 barrel 必须显式登记 `imports`**：在 `packages/agent-core/package.json` 的 `imports` 中加 `"#/<domain>": "./src/<domain>/index.ts"`（仿 `#/_base/di`，`:30`），不要依赖 `#/*` 通配。test-only 符号走 `#/<domain>/test` 子路径。见 [§4 步骤⑥](#4-迁移步骤-步每步可验证)。
- **每步一提交，提交前过全部门槛**：typecheck + test + fence + 两个 grep（`services/<domain>` 0 命中、deep-import 0 命中）。见 [§6](#6-每步验证门槛强制)。
- **不动 decorator 字符串**：`'coreProcessService'` 等历史字符串 P9 才允许改名。见 [§5](#5-禁止事项硬规则)。

## 1. 目的与适用

本文管辖的是**现有 domain 的平移式迁移**：把 `packages/agent-core/src/services/<domain>/` 下的契约、厚实现、support files、tools，按 di-v3 的目标布局搬到 `packages/agent-core/src/<domain>/`。迁移完成后，目标 domain 内：

- 契约（接口 + `createDecorator` + sentinel errors）与厚实现（`class XxxService`）**同居**在一个目录；
- 该域提供的工具（如有）落在 `<domain>/tools/`；
- 公共面只通过 `<domain>/index.ts` barrel 暴露；
- 该域自己的服务注册函数 `register<Domain>Services` 与工具注册函数 `register<Domain>Tools` 由 barrel 导出（命名见 PLAN §2.4，`plan/PLAN.md:180-195`）。

本文是 ROADMAP **P3.1–P3.8** 每一步的执行模板（`plan/ROADMAP.md:313-430`）。P3.1–P3.6 各迁一个独立 domain（session / workspace / mcp / skill / terminal / config）；P3.7 批量迁剩余 domain；P3.8 删除已空的 `services/`。每步都按 [§4](#4-迁移步骤-步每步可验证) 的 ⑦ 步落地，按 [§6](#6-每步验证门槛强制) 验收。

**不在本文管辖**：

- 新建 domain 的设计（见 `service-design-principles.md`、scope 概念见 `scope-mechanism.md`）；
- scope 机制本身（`LifecycleScope` / `registerScopedService` 等，见 `scope-mechanism.md`）；
- P4 / P5 的跨 domain wiring 汇总（`bootstrap.ts::registerAllBuiltinTools` 的最终形态 P5 落地；本文只规定每域导出的注册函数名）。

## 2. 目标目录结构

迁移终态（PLAN §2.3，`plan/PLAN.md:166-178`）：

```text
<domain>/
├── <domain>.ts             # 契约：IXxxService + createDecorator + sentinel errors
├── <domain>Service.ts      # 厚实现：class XxxService
├── <support files>         # 状态机 / scheduler / persistence / parser / provider 适配器
├── tools/                  # 该域提供的工具（如有）
│   └── <tool>.ts
└── index.ts                # export + register<Domain>Services + register<Domain>Tools
```

**barrel-only 暴露（强制）**：每层（`<domain>` / `_base/<x>` / `_utils/<x>`）的 `index.ts` 是其唯一公共面。consumer 一律从 barrel 导入：

```ts
// 允许
import { IFooService } from '#/foo';
import { createDecorator } from '#/_base/di';
import { SomethingPublic } from '@moonshot-ai/agent-core';

// 禁止（deep-import 子模块）
import { IFooService } from '#/foo/store';            // 错：绕过 barrel
import { InstantiationService } from '#/_base/di/instantiation'; // 错：绕过 barrel
```

公共契约（接口、`createDecorator`、sentinel errors）与对外注册函数（`register<Domain>Services` / `register<Domain>Tools`）从 `<domain>/index.ts` 导出；内部文件（store、parser、provider 适配器、未标注为公共的 support file）**不**从 barrel 导出，外部也不得 deep-import。

例外：**test-only 符号**走 `#/<domain>/test` 子路径（如 `#/_base/di/test`，落到 `src/_base/di/test.ts`），不进入生产 barrel，以把 sinon 等 dev-only 依赖隔离在生产面之外。见 [§4 步骤⑥](#4-迁移步骤-步每步可验证)。

> P1.6 通配遮蔽提醒：新增顶层 `<domain>/index.ts` barrel 后，diff `src/index.ts` 的 `^export` 列表，确认没有顶层命名冲突（同名 export 会被 barrel 通配遮蔽）。

## 3. 依赖方向（fence）

依赖方向 fence 已 ACTIVE 且 green：**`_utils ← _base ← domains`**（`packages/agent-core/test/dependency-direction.test.ts:608-614`，14/14）。P2.6 之后这两条断言扫的是真实 `src/` 树（注释见 `:604-607`），不再是 vacuously-clean 占位。

迁移新增 / 修改 `<domain>/` 目录时，从第一天起就受这条 fence 约束：

- 一个 domain **可以** import：`_base/*`、`_utils/*`、自身（barrel 内相对引用）、其他 domain 的**契约 / barrel**（`<other-domain>.ts` 或 `<other-domain>/index.ts`）。
- 一个 domain **不得** import：另一个 domain 的**具体实现**（`<other-domain>/store`、`<other-domain>Service` 等 impl 文件）。
- `_base/*` 与 `_utils/*` **不得**反向 import 任何 domain。

**唯一强制机制是 vitest fence**。`packages/agent-core/test/dependency-direction.test.ts` 里：

- `:608-610` `it('di-v3 _utils ← _base ← domains layering is clean (real src)', ...)` — 校验 `_base`/`_utils` 不反向依赖 domain，且方向为 `_utils ← _base ← domains`；
- `:612-614` `it('di-v3 cross-domain impl fence is clean (real src)', ...)` — 校验跨 domain 不 import 具体 impl。

**oxlint 不能表达这条规则**。oxlint 1.59.0 没有 `no-restricted-paths`；可用的 `no-restricted-imports` 是全局 specifier 封禁，无法表达「动态 domain 集合」与「barrel-vs-impl」区分（P2.6 已验证）。**不要**为了这条 fence 新增 oxlint 近似规则——它会制造虚假安全感且漏掉 bare specifier / 全部 domain 目标 / 跨 domain impl 规则。fence 测试即权威。

迁移中若 fence 转红，按 [§6](#6-每步验证门槛强制) 跑 fence 单测定位违规 import，改成合规路径（barrel 或契约），不要放宽 fence 规则。

## 4. 迁移步骤（⑦ 步，每步可验证）

把 ROADMAP P3.0 的 ①–⑦（`plan/ROADMAP.md:301-311`）落成可执行清单。每步完成后按 [§6](#6-每步验证门槛强制) 跑对应门槛。

> 全程优先 `git mv`，保留文件历史。删除用 `git rm`。

### ① 建 `src/<domain>/`

- 新建 `packages/agent-core/src/<domain>/`。
- 用 `git mv` 把 `services/<domain>/` 下的文件分批迁入（保留历史）。若目标目录已存在（如 session 已有 `SessionHost` / `SessionRepository`，ROADMAP P3.1，`plan/ROADMAP.md:320`），直接迁入并合并。

### ② 移契约（`<domain>.ts`）

- 把接口、`createDecorator`、sentinel errors 集中到 `<domain>/<domain>.ts`。
- **不改 decorator 字符串**（如 `'coreProcessService'`）。改名是 P9 的事（`plan/ROADMAP.md:23`）。
- 契约文件本身不应 import 任何 impl（厚实现、store、provider）。契约只允许依赖 `_base/di`（`createDecorator`）、`_base/errors` 等基础面。

### ③ 移厚实现（`<domain>Service.ts` + support files）

- 把 `class XxxService` 落到 `<domain>/<domain>Service.ts`。
- 状态机 / scheduler / persistence / parser / provider 适配器等 support files 一并迁入 `<domain>/`。
- impl 内部用相对 import 引用本域契约（`./<domain>`）与 support files；跨域依赖走 barrel / 契约。

### ④ 移工具（`<domain>/tools/`）

- 若该域提供工具，迁到 `<domain>/tools/<tool>.ts`。
- 若该域无工具，**跳过**本步并在 `STATUS.md` 记录「无 tools，步骤④跳过」。

### ⑤ 写 `src/<domain>/index.ts` barrel

- 导出**公共契约**：接口、`createDecorator`、sentinel errors。
- 导出**注册函数**：`register<Domain>Services(accessor)`（服务注册）与 `register<Domain>Tools(accessor)`（工具注册，形状见 PLAN §2.4，`plan/PLAN.md:180-195`）。
- **不泄露内部文件**：store、parser、未标注公共的 support file 不导出。

barrel 形状（模板，按域替换）：

```ts
// <domain>/index.ts（模板）
export { IFooService, FooError } from './foo';
export { registerFooServices, registerFooTools } from './fooService';
// 不导出 './foo/store'、'./foo/internalParser' 等内部文件
```

注册函数形状（模板，按域替换）：

```ts
// 服务注册（PLAN §2.4 形状）
export function registerFooServices(accessor: IServiceAccessor): IDisposable { /* ... */ }
// 工具注册
export function registerFooTools(accessor: IServiceAccessor): IDisposable { /* ... */ }
```

最终由 `agent-core/bootstrap.ts::registerAllBuiltinTools(accessor)` 汇总各域 `register<Domain>Tools`（P5 落地；本规范只规定每域导出名 `register<Domain>Services` / `register<Domain>Tools`）。

### ⑥ 更新 import

- **全量改写**所有 consumer 到 `#/<domain>` barrel，**含 `src/` 与 `test/`**。不留旧路径 alias（见 [§5](#5-禁止事项硬规则)）。
- **新增顶层 barrel 必须显式登记 `imports`**：在 `packages/agent-core/package.json` 的 `imports` 中加入 `"#/<domain>": "./src/<domain>/index.ts"`（仿已有 `#/_base/di`，`packages/agent-core/package.json:30`）。`#/*` 通配（`./src/*/index.ts`，`:42-45`）只可靠覆盖单段 `*`，嵌套 barrel（多段路径）vitest 无法解析；**必须**写显式条目，不要依赖通配。
- **test-only 符号走 `#/<domain>/test`**（如 `#/_base/di/test` → `src/_base/di/test.ts`，`packages/agent-core/package.json:43` 的 `./src/*.ts` 通配覆盖）。不要把 sinon 等 dev-only 依赖塞进生产 barrel。

`package.json` `imports` 条目形状（模板）：

```jsonc
// packages/agent-core/package.json → imports
"#/<domain>": "./src/<domain>/index.ts"
```

### ⑦ 删除旧路径 + 验证

- 同一步内 `git rm -r packages/agent-core/src/services/<domain>/`。**不留 re-export alias / shim**（见 [§5](#5-禁止事项硬规则)）。
- 跑 [§6](#6-每步验证门槛强制) 的全部命令：typecheck + test + fence + 两个 grep（`services/<domain>` 0 命中、deep-import 0 命中）。
- 若 `server` 被改：额外跑 server 的 typecheck + test（见 [§6](#6-每步验证门槛强制)）。

## 5. 禁止事项（硬规则）

P3.x worker 在迁移中**不得**做以下任一事项。违反任一即视为该 step 未通过：

- **不留旧路径 re-export alias / shim**。迁移完成后 `services/<domain>/` 必须消失；consumer 直接从 `#/<domain>` barrel 导入。没有「deprecated，P9 删除」（Global constraint，`plan/ROADMAP.md:25-26`）。
- **不 deep-import**。禁止 `#/<domain>/store`、`#/_base/di/instantiation` 等绕过 barrel 的 import（`#/foo/test` 子路径除外）。见 [§2](#2-目标目录结构)。
- **不在 `_base` / `_utils` 反向 import domain**。依赖方向恒为 `_utils ← _base ← domains`。见 [§3](#3-依赖方向fence)。
- **不绕过 fence**。fence 转红时改合规 import，不许改 fence 规则或加 allowlist 例外（除非 fence 本身需要随新 domain 同步更新规则——这种情况在 `STATUS.md` 显式说明）。见 [§3](#3-依赖方向fence)。
- **不为 fence 新增 oxlint 规则**。oxlint 无法表达该规则；vitest fence 是唯一强制。见 [§3](#3-依赖方向fence)。
- **不新增 `it.skip` / `test.skip`**。失败测试修复、删除或拆到后续 step（Global constraint，`plan/ROADMAP.md:21`）。
- **不动 decorator 字符串**。`'coreProcessService'` 等历史字符串 P9 才允许改名（`plan/ROADMAP.md:23`）。

## 6. 每步验证门槛（强制）

每个 P3.x step 提交前必须通过下列全部命令（字面验收）。任一不通过，按 [§8](#8-偏离处理) 处理，不许擅自放行。

```bash
# 1) agent-core 类型检查
pnpm --filter @moonshot-ai/agent-core typecheck

# 2) agent-core 全套测试
pnpm --filter @moonshot-ai/agent-core test

# 3) 依赖方向 fence（必须 green）
npx vitest run packages/agent-core/test/dependency-direction.test.ts

# 4) 旧路径 0 命中（无 alias，无例外）
grep -rEn "services/<domain>" packages/agent-core/src packages/agent-core/test
#    期望：0 命中

# 5) deep-import 0 命中（除 /test 子路径外，禁止 #/<domain>/<file>）
grep -rEn "#/<domain>/[a-zA-Z]" packages/agent-core/src packages/agent-core/test
#    期望：0 命中（#/foo/test 不计入；如有命中须改为 #/<domain> barrel 或 #/<domain>/test）
```

**若 `server` 被改**（consumer 落在 `packages/server/`）：额外跑

```bash
pnpm --filter @moonshot-ai/server typecheck
pnpm --filter @moonshot-ai/server test
```

把 `<domain>` 替换为本次迁移的域名（如 `session`）。命令 4 / 5 的 grep 是「旧路径清干净 + 无 deep-import」的字面验收，与 fence 互补：fence 管方向，grep 管残留与绕过 barrel。

## 7. 提交规范

- **Conventional Commits**，scope 用 `agent-core`（Global constraint，`plan/ROADMAP.md:11`）。
- 建议 message 形状：

  ```text
  refactor(agent-core): migrate <domain> domain → <domain>/
  ```

- **每步一提交**：一个 domain 一次提交，提交前必须通过 [§6](#6-每步验证门槛强制) 的全部门槛。
- 提交内容只允许落在该 domain 的迁移范围内（新 `<domain>/`、删除 `services/<domain>/`、consumer import 改写、`package.json` `imports` 条目）。不要夹带无关改动。

## 8. 偏离处理

若计划与现实冲突（例如某 domain 的实际依赖与本规范不符、某 consumer 无法直接改写到 barrel、某 fence 违规无法用合规 import 解决）：

- **不要擅自变通**。在 phase 状态目录写 `BLOCKER.md`，描述：冲突点、涉及的 `file:line`、尝试过的合规路径、为何走不通。
- 把偏离记录进该 step 的 `STATUS.md`（决策 / Deviations 段）。
- 停下，交回 orchestrator 决策。

可接受的、**不**算偏离的调整（在 `STATUS.md` 说明即可）：

- domain 目标位置与 ROADMAP 略有出入（如 ROADMAP P3.5 把 terminal 归入 `kaos/terminal.ts`，`plan/ROADMAP.md:374-387`）——按 ROADMAP 该步指定位置落地；
- fence 规则需随新 domain 同步更新（Global constraint 允许，「新增 domain 时同步更新 fence 规则（如需）」，`plan/ROADMAP.md:24`）——在 `STATUS.md` 写明改了哪条规则、为何需要。

## 9. 参考

- 目标结构 / 工具注册：`plan/PLAN.md:166-195`（§2.3 / §2.4）。
- 全局硬规则：`plan/ROADMAP.md:9-27`（barrel-only `:25`、禁止 shim `:26`、fence `:24`、禁止 skip `:21`、decorator 字符串 `:23`）。
- P3 阶段总览：`plan/ROADMAP.md:296-432`（P3.0 `:301-311`，P3 acceptance `:432`）。
- 依赖方向 fence：`packages/agent-core/test/dependency-direction.test.ts:604-614`。
- `package.json` `imports`：`packages/agent-core/package.json:29-46`（显式 barrel 条目 `:30-41`，仿 `#/_base/di` `:30`；`#/*` 通配 `:42-45`）。
- `/test` 子路径先例：`packages/agent-core/src/_base/di/test.ts`（消费方：`import { ... } from '#/_base/di/test'`）。
- scope 概念：`scope-mechanism.md`（domain 与 scope 正交、context service、manager 模式）。
- 各 domain 设计文档（按域引用）：`kimi-code-dev-2/plan/` 下对应文件（如 `2026.06.22-Session-Domain.md`、`2026.06.22-Workspace-Domain.md`、`2026.06.22-MCP-Domain.md`、`2026.06.22-Skill-Domain.md`、`2026.06.21-Kosong-Kaos-Loop-v2.md` 等；具体路径见 ROADMAP P3.x 各步的「源」字段，`plan/ROADMAP.md:326` 起）。
