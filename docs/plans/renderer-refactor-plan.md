# Renderer 架构治理总计划：共享收敛 → God Object 拆解 → 组件层收敛 → 现代化与防护网

> 本文档是 renderer 架构治理的唯一总计划，由两份计划合并而成（2026-08-25）：原一期计划（P0–P12 已完成）与二期计划（Q0–Q22）。两原件（`2026-08-01-renderer-architecture-refactor.md` / `2026-08-20-renderer-refactor-phase2-plan.md`）已删除，历史版本见 git。
> **编号统一**：已完成阶段保留原编号 P0–P12；剩余工作统一重编号为 **P13–P35**（原二期 Q0–Q22 顺延映射；原一期未做的 P13–P18 编号作废，映射见 §3 开头）。台账中的历史条目保留撰写时的原编号，不再回改。
> 沿用制度：每阶段 = 一个可独立合并、独立可运行的 PR；除明确列出的对齐点外，迁移 PR 的原则是 **逻辑零变化，只动位置与 import**；开工先读台账最新条目，完工追加台账。
> 仓库硬约束：Conventional Commits；每 PR 按 `.agents/skills/changeset` 规则（一律 `patch`、只写 `kimi-code-app`；纯文档/测试/无用户可见变化可免）；UI 变更必须亮+暗色视觉验证。
> 配套规范：`docs/specs/2026-08-01-renderer-architecture.md`（目标架构、归属矩阵、注入缝、平台分叉规则、组件化标准、store 规范——目标态与纪律的正本，本计划不重复）；`docs/specs/2026-08-20-vue3-best-practices.md`（Vue 3 最佳实践）。

## 0. 决策记录（已拍板）

| 决策点 | 结论 |
|---|---|
| Pinia 引入范围（2026-08-01，已落地 P8–P12） | **全量引入**：app-client 内 domain stores 全部用 Pinia setup store 承载，`useKimiWebClient` facade 降级为兼容聚合层逐步废弃 |
| 共享代码落点（2026-08-01，已落地 P1–P7b） | **两包分工**：纯逻辑进 `packages/app-core`；Vue composables / 状态层 / Pinia stores 进 `@moonshot-ai/app-client` |
| 组件化标准落地方式 | 一期定为「规范文档 + 1-2 个示范 PR」；**二期升级为「全面下沉」（该示范决策作废）**：新建 `packages/app-components`（或并入 app-ui，执行时定），零差异组件文件全量下沉（73 个，2026-08-25 复测；P17–P22） |
| 平台差异收口方式 | 组件层同样走注入缝（ProductTracker / OpenInService / ComposerEditor），禁止整文件分叉存活；残留分叉配 CI drift guard |
| 协议契约化（2026-08-20 新增战线） | wire 边界 zod 校验 + client_hello 版本协商（需 daemon 侧配合，跨仓库）；按新契约直接消费，不做旧 daemon 兼容路径（与仓规「不做旧服务端兼容逻辑」一致） |
| 现代化特性批次 | defineModel / defineSlots / InjectionKey 化作为一个独立机械批次（P26），配 lint 防回退 |
| 错误边界 | 新增：全局 errorHandler + 关键子树 onErrorCaptured + async 组件错误态（随 P13 护栏批次落地） |
| kimi-code 仓 `apps/kimi-web` 第三副本 | 一期决策冻结、不动 submodule、不回迁；P35 正式推动删除（见 §6） |
| 执行顺序 | 一期「先收敛副本，再拆解」已完成；剩余工作 **护栏先行**（P13：drift guard / build job / 错误边界 / 真 bug 修复），再续主线拆解，组件下沉与 god object 收尾可并行 |

## 1. 现状盘点

### 1.1 一期已建立的基线（勿返工）

- 纯逻辑/composable/状态层全部单源化：`app-core`（lib + client + api/daemon）+ `app-client`（composables + stores + client 单例）。
- 注入缝体系：`createKimiWebApi(deps)` 工厂、`setKimiClientDeps` 注册表、`setProductTracker` registry、包持 `clientPinia` 实例。
- store 纪律：setup store、`kimi.` 前缀 id、写路径只走 action、applyRecordDiff 逐 key 写回、facade 桥接过渡形态。
- 验收门禁惯例（本计划全部代码 PR 的标准模板）：test / typecheck / lint / build / check:style 五件套 + 浏览器实测双端冒烟 + 多切面 review。
- 一期的调研明细（2026-08-01 实测的副本五类清单、god object 行数解剖、drilling 链行号等）已随合并归档，历史版本见 git；当前剩余工作以 §1.2 的实测（2026-08-20 初测、2026-08-25 按 main 复测）为准。

### 1.2 剩余问题实测（2026-08-20 初测，2026-08-25 按 main 复测刷新）

**A. God object 残余（一期主线未完成部分）**
- `useKimiWebClient.ts`（6197 行，较 08-20 再涨 48%）+ `useWorkspaceState.ts`（4308 行）仍混四个内聚层级；~25 个 per-session 平行 map 手工 teardown（`forgetSession` 55 行）；P14–P16 三域未拆。
- **最 race 密集的文件测试最少**：useKimiWebClient 无专门测试套件（重连 / 订阅 / 基线对齐全靠场景测试间接覆盖；`session-work-reconnect.test.ts` 已 6583 行但属集成层）。
- 一期拆解期顺手修复清单残余（2026-08-25 复核仍在）：`useTaskPoller.ts` 整表替换（~:74）、`errorName`/`errorMessage` 双份、`PersistSessionProfilePatch` 双定义、facade 死 provide（`KimiWebClientFacadeKey` 有 provide 零 inject）。

**B. 组件层双端分叉（一期未覆盖的最大债）**
- 共享组件 2026-08-25 复测（`components/` + `views/` 同名 .vue）：**73 个零真实差异**（33 个字节级相同 + 40 个只差首行 provenance 注释）+ 30 个真实分叉 + 2 个 web 独有，可零逻辑改动下沉的部分两端各维护一份。
- 真实分叉的最大来源是 **telemetry 内联调用**（`import { track }` 撒在 15 个组件文件里）——P6 建的 ProductTracker 注入组件层没用上（组件侧 `contracts.track` 使用为 0）；其次 v-if 包裹的原生块（合理）。
- 08-20 登记的三条行为级漂移，复测两条已修复（web Composer 已迁 app-composer 的 ProseMirror、`command` emit 已补 `skillName`）；`ApprovalCard` 两端仍有 106 行差异（iOS 视口修复等只在一端）。`AttachmentChip.vue` 两端已删除。
- **CI 无任何防漂移检查**；kimi-code 仓 `apps/kimi-web` 第三份冻结副本仍在。

**C. 组件质量（原一期 P16/P17 只计划做示范）**
- 巨型组件（行数为 2026-08-25 复测 desktop/web，结构数据为 08-20 口径）：ConversationPane 3198/3155 行（内嵌 ~700 行滚动引擎，嵌套滚动接管写了三遍；58 props / 45 emits；26 行纯转发 emit）、Composer 4364/4595 行（160 行手写 keymap、工具条折叠状态机、3 个自撸下拉绕开 app-ui Menu；main 上 mention pills / attachment registry 新逻辑多在壳内，清单以当日重测为准）、Sidebar 2783/2516 行（6 条渲染路径内联、DnD 三种实现、3 个手写弹窗）、App.vue 2945/2331 行（单绑定块 103 行、无 scoped 全局样式反穿 `.chat-header`）。
- 4 层 prop drilling：同组 ~30 个 props 在 App → ConversationPane → ChatDock → Composer 逐字重复声明；facade 本是全局单例，drilling 无收益。
- 5 个裸字符串 provide key（`pinScroll` / `resolveImage` / `resolveAgentTaskId` / `modelDisplay` / `subagentEffort`）。

**D. Vue 现代化欠账**
- `defineModel` 0 次 vs 22 个文件手写 modelValue 对（app-ui 全部表单控件）；`defineSlots` 0 次（36 个插槽口无类型）；`useTemplateRef` 0 次（319 个字符串模板 ref）；facade 返回装 ref 的普通对象字面量 → 模板 `.value` 汤（App.vue 188 处，desktop，2026-08-25 复测）；`onWatcherCleanup` 0 次；AbortController 0 次（247 处监听器手工配对）。
- `ProviderForm.vue:340` 可编辑可删除表单行用 index 作 key——**真 bug**（2026-08-25 复核仍在）。

**E. 数据层与协议（#279 主线 transcript 迁移后重写，2026-08-25）**
- #279 已完成 Phase 0–3：主对话消息流改由 transcript 协议驱动，`messagesBySession` 切片与 `agentEventProjector`/`eventReducer` 的消息路径已删除（两文件保留，只剩全局事件 / agent 生命周期 / BTW 侧聊）；`frameClassifier` 仍在，但只分类上述剩余帧。
- 剩余 record slice（`tasksBySession` 等）仍是深 `reactive()`；`shallowRef` 全仓库仅 3 处、`markRaw` 0——applyRecordDiff 的写入侧优化被读取侧深遍历抵消一半。
- WS 协议仍无版本号；REST 边界零运行时校验（`as WireEnvelope<T>`）；12 处 PRESUMED 对着未上线服务端特性写代码（2026-08-25 复核仍 12 处）。
- turn 生命周期隐式散落在 facade（`turnStartBySession` generation map、`turnActiveBySession` 等）与 useWorkspaceState（队列 / 乐观气泡 / settle 清理）。
- #279 的已知取舍（其计划文档登记）：goal 卡实时流式降级为回合边界 REST 刷新；warnings 实时增量降级为会话选择时 REST 拉取；goal turn-end seam 测试缺口待按 transcript 边沿重写——吸收进 §7。

**F. 性能敞口**
- 无界 transcript 全量渲染（无虚拟化、`v-memo` 0）；`assistantVisibleBlocks(turn)` 在 `ChatPane.vue` 的 v-for 表达式里每 tick 重算；主视图 v-show 切换下隐藏视图的 watcher/observer 全活着。

**G. 工程防护网缺口**
- 零错误边界：无 `app.config.errorHandler`、`onErrorCaptured` 0、2 处 defineAsyncComponent 未配错误态。
- 组件测试为 0（@vue/test-utils 不在依赖里）；无 e2e；PR 不跑 build（ci.yml 只有 lint/typecheck/test，tsdown/vite build 坏了要等 release）；无依赖更新机制。

## 2. 目标 / 非目标

**目标**
1. god object 按一期矩阵拆完（P14–P16 三域 + 残余修复清单），facade 降为薄聚合层。
2. 组件层单源化：零差异组件文件全量下沉（73 个，2026-08-25 复测）+ 真实分叉全部改注入缝 + CI 防漂移。
3. 三个巨型组件（ConversationPane / Composer / Sidebar）拆到达标（script ≤ ~600 行）。
4. 错误边界、现代化特性、数据层浅响应化、协议契约化落地。
5. 防护网补齐：组件测试地板、CI build job、打包冒烟。

**非目标**
- 不改 daemon（kimi-code 仓）既有行为语义；协议字段只做新增，但客户端按新契约直接消费，不为缺字段的旧 daemon 写兼容/降级路径（仓规「不做旧服务端兼容逻辑」既有口径）。
- 不做 UI 重设计；不做 Vapor Mode 迁移（等 3.6 stable，见 P35 评估项）。
- 任何功能新增与视觉变更（各阶段明确列出的行为对齐点除外）。
- Windows/Linux 签名、CDN 发布自动化不在本计划（基础设施议题另立）。
- kap-server 挪 utilityProcess 只做评估与 POC（P34），不承诺落地。

## 3. 阶段总览

**编号映射（合并时统一）**：

- 原二期 Q0–Q22 → **P13–P35**（顺延：Q0→P13、Q1→P14、…、Q22→P35）。
- 原一期未做条目的去向：旧 P13（workspace store）→ P14；旧 P14（prompt store）→ P15；旧 P15（connection store）→ P16（扩大为 + SessionRuntime 容器化）；旧 P16（drilling 示范）→ P24（扩大）；旧 P17（滚动机器 + App.vue 瘦身）→ P23（滚动，扩大）+ P24（App.vue 瘦身残项）；旧 P18（约定核对）→ P35。旧 P13–P18 编号不再使用。

**已完成（P0–P12，详见文末台账）**：

| PR | 阶段 | 完成 | 合并 |
|---|---|---|---|
| P0 | 架构与组件化规范文档 | 2026-08-05 | — |
| P1 | lib 纯函数下沉 app-core | 2026-08-11 | #185 |
| P2 | 渲染类型 + 热路径纯模块下沉 | 2026-08-11 | #196 |
| P3 | agentEventProjector 下沉 + api 壳合并 | 2026-08-11 | #197 |
| P4 | 新建 `@moonshot-ai/app-client` + ProductTracker 契约 + 无分叉 composables 迁移 | 2026-08-11 | #198 |
| P5 | icons 资产与注册表统一 | 2026-08-11 | #199 |
| P6 | telemetry / 平台分叉 composables 迁移 | 2026-08-12 | #207 |
| P7a | client 状态模块迁移（task-poller/side-chat/model-provider） | 2026-08-12 | #208 |
| P7b | 两大单例迁移，副本正式消灭 | 2026-08-17 | #255 |
| P8 | Pinia 引入 + 首个 domain store（sessions） | 2026-08-17/18 | 与 P9–P12 同批，见台账 |
| P9 | notifications store | 2026-08-18 | 同上 |
| P10 | models store | 2026-08-18 | 同上 |
| P11 | approvals store | 2026-08-18 | 同上 |
| P12 | files store | 2026-08-18 | 同上 |

**待执行（P13–P35）**：

| PR | 阶段 | 规模 | 依赖 |
|---|---|---|---|
| P13 | 护栏与快赢批次（drift guard / build job / 错误边界 / ProviderForm key / provenance 注释清理） | 中 | — |
| P14 | workspace store（原一期 P13 原样承接） | 中 | — |
| P15 | prompt store（原一期 P14 原样承接） | 中 | P14 |
| P16 | connection store + SessionRuntime 容器化（原一期 P15 扩大；先补测试保护网 P33） | 大 | P15 |
| P17 | `packages/app-components` 第一批：零差异组件文件机械下沉（73 个，按当日重测） | 中 | P13 |
| P18 | 组件 telemetry 走 ProductTracker + provide 纪律清理 | 中 | P17 |
| P19 | Composer 壳合一 + 下沉（web ProseMirror 迁移已完成） | 中 | P17 |
| P20 | OpenInMenu 注入式 catalog provider 统一 | 中 | P17 |
| P21 | Sidebar 拆分（StatusTabs/SessionList/WorkspaceDirectory + 单一 DnD） | 中 | P17 |
| P22 | DesignSystemView 收敛 desktop 单份正本 + App.vue 全局样式反穿清除 | 小 | — |
| P23 | 滚动引擎提取 `useTranscriptScroll`（原一期 P17 前半，虚拟化前置） | 大 | — |
| P24 | drilling 消除：Composer 链 + ConversationPane 收敛 + App.vue 瘦身（原一期 P16 扩大） | 大 | P14–P16 |
| P25 | Composer 拆分（keymap / 折叠状态机 / menu 测量 composable 化） | 中 | P19 |
| P26 | 现代化批次：defineModel ×22 + defineSlots + InjectionKey 化 + lint 固化 | 中 | — |
| P27 | 数据层浅响应化 + 就地变更读取点清单化 | 中 | P16 |
| P28 | 协议契约化：wire 边界 zod + client_hello 版本协商 | 大 | —（跨仓库协调） |
| P29 | turn 生命周期显式状态机 | 大 | P16、P28 |
| P30 | transcript 虚拟化 + v-memo 热点 + assistantVisibleBlocks 预计算 | 大 | P23 |
| P31 | 组件测试地板（@vue/test-utils 引入 + 提取物首批用例） | 中 | P23/P25 |
| P32 | 打包产物冒烟 + 主进程安全三件套（原一期附录 A） | 中 | P13 |
| P33 | useKimiWebClient 场景测试保护网（P16 的前置，单独成 PR） | 中 | — |
| P34 | kap-server utilityProcess 隔离评估 + POC | 中 | — |
| P35 | 收尾：约定核对（原一期 P18）+ kimi-web 第三副本删除推动 + 3.6/Vapor 评估 | 小 | 全部 |

**并行线**：线 ① P14→P15→P16（god object 收尾，一期主线）；线 ② P17→P18/P19/P20/P21（组件下沉）+ P22（DesignSystemView 单源化，无下沉依赖）；线 ③ P23→P30（滚动与性能）；线 ④ P26/P28/P29（现代化与协议）。P13 与 P33 先行，四条线之后可并行推进。

## 4. 阶段明细

### P13 — 护栏与快赢批次

先上护栏再动工，防止治理期间新债继续产生。可拆 3-4 个小 PR：

1. **CI drift guard**：脚本 diff 两端 `components/` 同名文件，超白名单（native-todos 台账）即 fail；白名单随 P17–P22 逐批缩短。同步删 51 个文件的第一行 provenance 注释（文件路径即 provenance）。
2. **CI PR build job**：`tsdown` + `vite build`（不打包），build 坏了不再等 release 才发现。
3. **错误边界三件套**：`app.config.errorHandler`（desktop 上报走 renderer-log/track IPC，web console + 可见降级）；ChatPane/transcript、SettingsDialog 子树 `onErrorCaptured`；2 处 defineAsyncComponent 补 errorComponent + timeout。
4. **ProviderForm.vue:340** 表单行 key 改稳定 id（`form.models` 行加内部 id 字段）。
5. 附带：`useTaskPoller.ts:339` deep-watch getter 返新对象改 computed；`open-external` 主进程补 http(s) 白名单（复用 `isHttpUrl`）；删死 channel `onMenu`/`kimi:menu`。

验收：五件套 + drift guard 对存量白名单外文件误报为零。

### P14–P16 — god object 收尾（承接原一期 P13–P15）

按一期拆解矩阵原样执行，两处扩大：

- **P14 `useWorkspaceStore`**：收编 workspace 排序 / pin / 分组。
- **P15 `usePromptStore`**：收编 prompt 提交 / queue / local turn 生命周期（`submitPromptInternal` 147 行拆小）。
- **P16 `useConnectionStore` + `SessionRuntime` 容器化**（原一期 P15 扩大）：connect / reconnect / baseline / resync / 快照同步 / WS 订阅 LRU（风险最高，放最后；`connectEventsIfNeeded` 196 行拆小）；~25 个 per-session 平行 map 收敛为单一容器对象 + 单 `dispose()`，`forgetSession` 的 55 行手工 teardown 随之消失；新增 per-session 状态只需在容器里加字段。
- **P16 前置 P33（测试保护网）**：拆风险最高的连接域之前，先给 useKimiWebClient 补场景测试——快照合并（staleness 一重试策略）、订阅 LRU 驱逐后重开（stale cursor → snapshot rebuild）、epoch 切换窗口、reconnect baseline 对齐。这是「先补网再动刀」，单独成 PR 便于 review。
- 一期拆解期顺手修复清单残余随所属域 PR 一并做：`useTaskPoller.ts:74` 整表替换（P14）、`errorName`/`errorMessage` 合并与 `PersistSessionProfilePatch` 双定义合并（P15）、facade 死 provide 删除（P24 组件改造完成后）。

验收：一期标准模板 + P33 新保护网全绿 + 浏览器实测双端断线重连冒烟。

### P17 — app-components 第一批：机械下沉

- 新建 `packages/app-components`（deps：app-ui / app-client / app-core / app-i18n / app-markdown；peer vue）。**先定包名与依赖面再动工**（参照本计划 P4 的教训：两端 package.json 必须显式声明 workspace 依赖；约束条目随本阶段更新 AGENTS.md，不等收尾）。
- 下沉零差异文件（2026-08-25 复测 73 个：字节一致 33 + 仅首行 40；执行时以当日重测清单为准）：`tool-calls/`（16/17）、`dialogs/`、`admin/`、`mobile/MobileTopBar`、`debug/` 等，git mv 保历史，两端 import 批量改指包。
- 每个文件逐一人肉确认在 P13 的 drift guard 白名单内（防误收真实分叉）。

验收：五件套 + 双端全量页面人工巡检一遍（这是组件层第一次大搬家）。

### P18 — 组件 telemetry 走 ProductTracker + provide 纪律

- 组件内 `import { track }` 全部改走 `contracts.track`（P6 registry 已就绪，web no-op 即现状）：ChatHeader / ApprovalCard / SessionRow / UserMenu / Sidebar 的 diff 因此归零，随改随下沉 P17 未收的这批文件。
- 5 个裸字符串 provide key 全部 `InjectionKey<T>` 化（`app-client/contracts` 或新建 `injectionKeys.ts`）；`KimiWebClientFacadeKey` 二选一：P24 组件改 inject 则保留，否则删除死 provide（**推荐删除**——P24 直接让组件消费 store/facade，注入键不再必要）。

验收：五件套 + desktop 埋点冒烟（P6 同款清单）。

### P19 — Composer 壳合一 + 下沉

- **前置已完成（2026-08-25 复测）**：web Composer 已迁到 app-composer 的 ProseMirror 内核（`createComposerEditor`），`skillName` payload 漂移已修复。两端壳现为 4364/4595 行（desktop/web），且 main 上 mention pills / attachment registry 的新逻辑大多加在壳里——合一前按当日 diff 重测分叉面。
- Composer 壳合一后下沉 app-components；编辑器内核两端已同为 app-composer，无需再抽象 `ComposerEditor` 接口，残留差异按规范文档规则「包内分支，不再整文件分叉」收口。
- 与 P25 的边界：P19 只做「两端合一 + 下沉」，拆分在 P25 做（先合一再拆，拆解只做一次）。

### P20 — OpenInMenu 注入式统一

定义 `OpenInService`（catalog 列表 + 执行 + 图标解析）InjectionKey：web 实现 = daemon `availableApps` + 现有回退；desktop 实现 = `listNativeOpenInApps` + 图标 map，**探测不到原生桥时返回空 catalog、UI 隐藏整个 Open In 入口——这就是既定降级**，不回退 daemon 路径。props 形态两端已近乎一致，分叉只是数据源。合一后下沉。

### P21 — Sidebar 拆分

- 拆 `StatusTabs` / `SessionList` / `WorkspaceDirectory`（模板 6 条渲染路径各归其位）；
- 三种 DnD 实现收敛为一个 `useSessionDrag` composable（SessionRow/PinnedSessionList/WorkspaceGroup 的重复一并收）；
- 3 个手写弹窗换 app-ui `Menu`；
- 拆分后随批下沉 app-components。

### P22 — DesignSystemView 单源化 + App.vue 样式纪律

DesignSystemView（~3000 行 ×2，已漂移 75 行）**不下沉**——它 import 了 app-client 的 icons 与产品组件（DockIconPicker / WorkingIndicator 等），移入 app-ui 会造成 app-ui ↔ app-client 循环依赖。改为收敛为 **desktop 单份正本**：canonical 仍是 `apps/desktop/src/renderer/views/DesignSystemView.vue`，删除 web 侧副本，AGENTS.md 中设计规范「两端同步」的表述随本阶段同步改写。App.vue 无 scoped 全局样式块中对 `.chat-header` 的反穿改为组件内样式或 token。

### P23 — 滚动引擎提取（虚拟化前置，原一期 P17 前半扩大）

- `ConversationPane.vue` 的 ~700 行滚动/跟随/pin/锚点恢复/嵌套接管抽为 `useTranscriptScroll`（app-client），与既有 `useFollowScroll` 合并或取代（执行时定边界）；
- 嵌套滚动接管的三份实现（wheel/pointer/touch）合一；
- 20 个 setTimeout/rAF 调用点的 token 守卫统一为可取消形态；
- **提取后立即可单测**：几何 mock 下的跟随/钉住/历史前插锚点恢复用例随 PR 携带（喂给 P31 当地板）。
- 同步把 TOC 遮挡命中、transcript 搜索 Range 揭示、Esc-undo 三个子系统各抽一个 composable。

验收：滚动行为专项回归（跟随/钉住/折叠/TOC/Esc-undo，双端）。

### P24 — drilling 消除（原一期 P16 扩大）

- 前置 P14–P16（store 就绪）。Composer 链 + ConversationPane + ChatHeader/Sidebar 的共享状态 props 改 store 直取；删 26 行纯转发 emit；同一 prop 透传 ≥3 层即违规写入规范（P0 规范已有，本阶段强制执行）。
- facade 按域分组为 reactive 视图（**不是 `toRefs` 包装**——facade 返回的是装 ref 的普通对象字面量，`toRefs` 不会解包嵌套 ref，只会把普通方法也包成属性 ref），或组件在 setup 顶层解构出所需的状态 ref；消灭模板 `client.xxx.value`（App.vue 188 处，desktop，2026-08-25 复测）。
- ConversationPane 收敛为布局 + 滚动容器，props 从 58 降到个位数。
- App.vue 瘦身（原一期 P17 残项）：~~slash 命令解释器下沉 `lib/slashCommands.ts`~~（已完成——解释器已在 `app-core/src/lib/slashCommands.ts`，App.vue 无残留）；9 个 dialog 可见性状态收一个 composable；`ServerAuthDialog.vue` 补 i18n（仍硬编码 `"Token"` 等字符串，`app-i18n` locales 双端补词条）。

### P25 — Composer 拆分

`useComposerKeymap`（160 行 handleKeydown）/ `useToolbarCollapse`（折叠状态机 + em 换算 + 12 源 watcher 收敛为 watchEffect 或 RO-on-content）/ `useMenuDescriptionMeasure`（pretext 测字）各成 composable；3 个自撸下拉换 app-ui `Menu`。目标 script ≤600 行。提取物单测随 PR（P31 地板的一部分）。拆分清单以当日重测为准——main 上壳已从 3470 涨到 4364/4595 行（desktop/web），mention pills / attachment registry 新逻辑多在壳内，「160 行 keymap / 3 个自撸下拉」为 08-20 口径。

### P26 — 现代化批次（机械，可一人一周内完成）

- 22 处手写 modelValue 对 → `defineModel()`（app-ui 表单控件 + MobileSettingsSheet + Dialog 命名 model）；
- app-ui 36 个插槽口补 `defineSlots` 类型；
- 319 个字符串模板 ref 渐进改 `useTemplateRef`（本批只改新下沉/新拆分的文件，存量不强求一次清）；
- lint 固化：禁手写 `update:modelValue` emit、强制 `InjectionKey`、（可选）`vue/define-macros-order`——防回退靠规则不靠自觉。

### P27 — 数据层浅响应化

- 目标 slice 按 #279 后的现状重列（2026-08-25）：`messagesBySession` 已随主线 transcript 迁移删除，剩余深 `reactive()` record slice 为 `tasksBySession` 等——执行时先全量盘点再定清单。两个形态执行时二选一（默认前者，对现有写路径改动最小）：
  - **`shallowReactive`**：applyRecordDiff 的逐 key 写回（`target[key] = ...` / `delete target[key]`）保持原样即可被逐 key 追踪；
  - **`shallowRef` + identity-replace**：每批 diff 后整体替换 `.value` 引用（或显式 `triggerRef`）。注意 `shallowRef` 下逐 key 的嵌套写入**不会**触发依赖更新——若选这个形态，applyRecordDiff 的写路径必须同步改，现有写法与之并不兼容。
- 风险点：依赖深响应的就地变更读取点（如直接改条目字段的地方）需逐一核查改为替换式更新——先全量 grep `\.value\[.*\]\.` 赋值形态，列清单再动手。
- 收益：流式高峰期的深遍历税归零（规模较 #279 前缩小，但仍是最直接的运行时性能项）。

### P28 — 协议契约化（跨仓库，需 daemon 配合）

- wire 边界 zod：WS 帧（transcript ops / 残留 session_event）与 REST envelope data 在 `DaemonHttpClient.request` / `handleFrame` 单点校验（zod 依赖已传递存在，`@moonshot-ai/transcript` 有先例）；校验失败转可观测的契约违规遥测而非静默 no-op。
- `client_hello` 加 `protocol` 版本字段，daemon 声明事件模式；客户端按新契约直接消费——无该字段的旧 daemon 握手失败按普通错误处理（仓规「不做旧服务端兼容逻辑」）。#279 后 frameClassifier 只剩全局事件 / agent 生命周期 / BTW 侧聊的分类（2026-08-25 复核），其 shape sniffing 与残留 snake/camel 双回退随本阶段退役（当版本直接删，不留过渡期）。
- 12 处 PRESUMED 逐一对账 daemon 侧落地情况，转正式契约或删除。
- 错误码集中到 app-core 单出口常量模块（40401 等双定义消除）。

### P29 — turn 生命周期状态机

显式 FSM（`idle → submitting → streaming → awaitingInteraction → settling`）收编隐式状态——#279 后现存于 facade 的 `turnStartBySession` generation map、`turnActiveBySession` 与 useWorkspaceState 的队列 / 乐观气泡 / settle 清理（2026-08-25 复测口径；projector/reducer 消息路径已退役）。transcript seq 水位比较的新鲜度门禁改为状态机守卫。依赖 P16（连接域拆完）与 P28（事件契约明确后状态迁移才有据可依）。

### P30 — transcript 虚拟化与渲染热点

- 前置 P23（滚动引擎先归位，虚拟化在其上叠加窗口逻辑）。
- `useVirtualList` 或自研窗口接入 turn 列表；`assistantVisibleBlocks` 折叠态改预计算 computed；streaming 热区评估 `v-memo`（先测量再上）。
- 主视图 v-show 切换改评估 KeepAlive + `onDeactivated` 收资源（隐藏视图的 observer/watcher 停机）。

### P31 — 组件测试地板

- 引入 `@vue/test-utils`；**首批用例只给提取物**：keymap、折叠状态机、滚动引擎（P23/P25 的副产品，随对应 PR 携带），不搞快照测试。
- 组件测试规范写入规范文档：测行为不测实现；DOM 测量逻辑必须经 mock 几何注入。

### P32 — 打包冒烟 + 主进程安全三件套

- desktop-build 产物 headless 起窗（xvfb）+ `/api/v1/meta` 应答断言；
- 主进程安全三件套（原一期附录 A）落地：`app://` 响应 CSP meta（`default-src 'self'` 起步）、open-external 白名单（P13 已含，此处收尾）、`window ↔ menu` 循环依赖拆解；
- `#token=` URL fragment 改 webRequest 注入 header 的评估与实施。

### P33 — useKimiWebClient 场景测试保护网

P16 前置（「先补网再动刀」），单独成 PR。场景清单按 #279 后的 transcript 产线重列（2026-08-25 复测：08-20 清单里的 `event-batcher` / `goal-turn-end` 测试已随旧产线删除，`session-work-reconnect.test.ts` 已有 6583 行集成覆盖——本条目是补缺口而非从零建网）：

- transcript channel 池：LRU 保留 / 摘除、后台会话订阅与通知边沿；
- seq 水位与缺口恢复：ops 跳号 → onGap → REST 补 / 全量 refresh、重连 replay 与 REST 补页合流去重；
- 双通道一致性：transcript 实体边沿（turn / interaction / prompt 终态）与残留 session_event（全局 / 生命周期 / 侧聊）的副作用不重复、不遗漏；
- 重连 baseline：resync 后快照与增量的对齐（现行机制当日复核）。
- 顺带把 #279 的 goal turn-end seam 测试缺口按 transcript 边沿重写（见 §7）。

### P34 — kap-server utilityProcess 隔离（评估 + POC）

现状：server 跑在主进程（崩则全灭；quit 不敢干净关 server 是 documented tradeoff；boot 序列围绕扛住 server 加载期崩溃设计）。评估 utilityProcess 迁移：崩溃隔离、干净退出、主 bundle 启动成本。POC 验证 loopback HTTP/WS 传输不变即可行。产出 = 决策文档，落地另立阶段。

### P35 — 收尾

- 原一期 P18 原样承接：AGENTS.md「开发顺序」「双仓工作流」改写为 packages 正本模式；native-todos.md 重写为「剩余 desktop 专属实现清单」；drift guard 白名单应收窄到接近空——**白名单残留量即本计划的最终验收指标**。
- kimi-code 仓 `apps/kimi-web` 第三副本：正式提删除 PR（见 §6，code-app 已全量接管）。
- Vue 3.6 / Vapor Mode 评估：3.6 stable + 生态兼容后，以 ChatPane turn/block 树为首个试点（前置 = P23/P30 完成后的组件粒度）。
- zod override 治理：推动 kimi-code 上游统一 catalog，撤掉本仓 `zod → 4.3.6` 降级 override。

## 5. 风险与对策

（原一期风险表 R1–R8 随对应阶段完成退役，本表只保留剩余工作的风险。）

| # | 风险 | 对策 |
|---|---|---|
| R1 | 组件下沉（P17–P22）期间团队在两端副本上继续叠功能 | P13 drift guard 先行；reviewer 拒绝对白名单外文件的双端不对称修改 |
| R2 | P17 大搬家 review 困难 | git mv 保历史 + commit 按「纯移动 / import 切换」拆分（P7b 同款手法）；drift guard 白名单逐个核对 |
| R3 | P27 浅响应化漏改就地变更读写点 → 更新不触发 | slice 形态与写路径配套选定（shallowReactive 或整引用替换，二者只选其一）；动手前全量清单化；五件套 + 双端流式冒烟；必要时分 slice 渐进 |
| R4 | P28 需要 daemon 侧排期，跨仓库不可控 | 客户端先行（zod 校验纯客户端可做）；协商字段按新契约直接消费，不为旧 daemon 留双形态——排期谈不拢时只推迟 client_hello 部分，zod 校验不受影响 |
| R5 | P16/P29 动连接与 turn 生命周期引入回归 | P33 保护网先行；ws-lifecycle / daemon-client 既有测试 + 浏览器实测双端断线冒烟（一期同款验收） |
| R6 | P19 web ProseMirror 迁移引入编辑器行为差异 | 桌面端已有实现为正本；mention/slash/IME/粘贴专项回归清单双端各一遍 |
| R7 | 治理周期长，业务需求插队导致半拉子 | 每个 P 独立可合并、独立有价值；P13/P26 这类快赢先给团队建立信心 |

## 6. kimi-code 仓 `apps/kimi-web` 处置

kimi-code 仓的 `apps/kimi-web` 是第三份冻结副本，明显漂移（2026-08-01 实测：`agentEventProjector` 1582 行 vs 本仓 1482、`messagesToTurns` 945 vs 1124），不在本 workspace（pnpm-workspace.yaml 注释明确排除）。一期决策为冻结、不动 submodule、不回迁；P7b 副本消灭后 code-app 已全量接管共享代码。P35 正式推动删除：在 kimi-code 仓提删除 PR（或其 `apps/kimi-web` 切换为消费 `@moonshot-ai/app-client` / `app-core`，需 kimi-code 仓把这两个包纳入其 workspace 或发布渠道——删除优先）。在此之前，kimi-code 仓对 `apps/kimi-web` 的任何修改与本仓无关。

## 7. 可穿插的独立小 PR（不阻塞主线）

- `AbortController` signal 渐进替换监听器手工配对（247 处，按文件随手做；卸载时务必 `abort()`）。
- `onWatcherCleanup` 替换 5 处旧式 onCleanup。
- dead code 清理：desktop renderer 残留的旧版 `Terminal.vue`（web 已重写、零 importer、已漂移）。
- app-core 包级 vue-tsc 门禁缺失（P3 台账登记的 79 个存量 error）治理。
- `publish-desktop-cdn.sh` 的 legacy 双 changelog 布局删除（自标「两个版本后删」，0.0.20 仍在）。
- node-pty rebuild fallback 改 fail-loud（ABI 不匹配时宁可构建失败，不要用户侧 dlopen 崩溃）。
- **内嵌 server loopback 鉴权评估**：`server.ts:86-88` `disableAuth: true` 的风险显式记录或加 loopback token（对齐外部 server 模式）。（原一期附录 A 残项；CSP / open-external 白名单 / 死 channel / `window ↔ menu` 循环依赖已分别编入 P13 / P32。）
- Dependabot/Renovate 引入。
- **#279 遗留恢复项**（其计划文档「已知取舍」登记）：goal 卡实时流式更新恢复（需 daemon 侧富化 transcript `meta.goal` 带 turns/wallClock 明细后改回实时）；warnings 实时增量恢复（transcript notice marker 边沿接线）；goal turn-end seam 测试按 transcript 边沿重写（随 P33 做）。

## 执行进度台账

每阶段合并后追加一条目：完成范围、与计划的偏差及原因、留给后面的尾巴。下一阶段执行者先读最新条目，再看 §4 自己阶段的明细。**历史条目保留撰写时的编号与文件名引用，不再回改。**

### P0 — 已完成（2026-08-05）

- 产物：`docs/specs/2026-08-01-renderer-architecture.md`（目标架构、归属矩阵、注入缝、平台分叉规则、组件化标准、store 规范、迁移期纪律、PR 验收模板）。
- 文档引用的反例已在代码中逐一核实：四个裸字符串 provide key（`pinScroll` / `resolveImage` / `resolveAgentTaskId` / `resolveSwarmMembers`）、`MobileSwitcherSheet` 复制 `SessionRow`、`ServerAuthDialog` 硬编码字符串。
- 2026-08-05 按 Codex review（#184，7 条 P2）修订总计划与规范：① AGENTS.md / apps/web 约定的更新从 P18 拆到约束实际变化的阶段（P4 放行 app-client 依赖、P8 解除 no-Pinia），P18 降为一致性核对；② P3 删除"t 注入顺带修复切语言不更新"的过度承诺（注入只影响新事件，正经修法是存 key/params 或重投影，列为已知问题）；③ P4 补"注入缝先行"（`useTerminal`/`useFilePreview` 等依赖 app api 单例或 vue-i18n，非纯移动）与两端 package.json 必须声明 app-client/pinia；④ P5 修正 iconsDir 推导建议（exports map 下 `import.meta.resolve('…/package.json')` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，需显式 export）；⑤ spec 归属矩阵澄清 config 只下沉纯 builder，runtime config 留两端接线层；⑥ 台账 P1 条目在代码 PR 合并前标「进行中」，避免后续执行者误判基线。
- 无 changeset（纯文档）。

### P1 — 已完成（2026-08-05 开 PR；2026-08-11 #185 合入 main squash 20964142）

- 完成：32 个 lib 纯函数模块下沉 `packages/app-core/src/lib/`（git mv 自 desktop 副本，头注释统一为新路径）；9 个测试迁入 `packages/app-core/test/`；两端 135 个文件 import 改指 `@moonshot-ai/app-core/lib`；web 侧副本删除。
- **与计划的偏差（实测驱动，§1.1 的分类未考虑依赖方向）**：
  - 依赖 `src/types`（P2 才动）→ 并入 P2：`parseDiff`、`diffLines`、`diffFullTexts`、`toolDiff`、`notificationXml`、`swarmCardRows`（后者依赖 `composables/swarmGroups`）。
  - 运行时依赖 app 侧 api 单例（`getKimiWebApi`）→ P3 工厂化后处理：`openFileAttachment`、`mediaPreview`（含 `.css`）。
  - 运行时 import `../i18n` → 需 t 注入解耦（同 P3 projector 模式）：`toolMeta`、`activitySummary`（另依赖 `components/chatTurnRendering` 的 `formatDuration`，其 web-only 测试一并滞留）。
  - `icons.ts` / `icons.test.ts`：按计划留 P5。
- **测试随迁的实际口径**：`searchHighlight.test` / `formatTokens.test` 实测为纯 vitest 用例（计划括号标注除外），已随迁合并去重；`shellDanger.test` / `transcriptSelectAll.test` 双份内容相同，合并为一份；desktop 独有的 `nativeWorkspaceDrop` / `planUsage` / `log` / `riveInputs` / `transcriptSearch` 测试一并迁入。`modelThinking.test` 实测 import `useModelProviderState` / `useKimiWebClient`（计划除外它的原因成立），滞留两端、仅改 import 路径，P7 后清理。
- **storage 并集**：`openInLastTarget`（web `OpenInMenu` 在用）与 `openInDefaultTarget`（desktop `nativeOpenIn` 在用）并存；全部 `kimi-web.*` key 名不变，两端零行为变化。
- **app-core package.json** 新增 `shiki` peer + dev 依赖（`codeLanguage` 仅类型引用 `BundledLanguage`，与 vue 同模式）。
- `nativeWorkspaceDrop` 实测桥门控、无桥惰性，按 P1 允许口径同批下沉。
- **坑**：desktop 主进程有自己的 `src/main/log.ts`，与 renderer `lib/log.ts` 同名——批量改写 import 时勿误扫 `src/main/`（本次误改已全部还原并验证）。
- **合入 main（2026-08-05，#178/#182/#183）的冲突处置**：冲突均为 import 块——保留 main 的新 import、路径改指包。main 对已下沉 lib 模块的修改经 rename-merge 自动落进 app-core 副本（mergeWorkspaces / modelThinking / storage / nativeWorkspaceDrop 已逐一 diff 核实零丢失）。main 新增的 `lib/rootKey.ts`（mergeWorkspaces 的依赖）与 `mergeWorkspaces.test.ts` 一并下沉 app-core；`apps/web/test/log.test.ts` 与 app-core 侧重复已删除。main 还新增了双份 `lib/rootKey.ts`（已收编）、`components/sessionRowStatus.ts` 与 `lib/providerForm.ts`（web 侧新增）——后者两个是 P2+ 待收编的新共享副本。
- **第 2/3 轮合 main（2026-08-08，#189 CI PR 等）的冲突处置**：14 个 UU 文件均为 import 块，同口径处理；`taskMerge` 遇 DU（modify/delete）——main 侧修改经 rename-merge 落进包内副本，diff 核实零丢失后 `git rm` 旧路径，`taskMerge.test.ts` 随迁并修正 import。坑：submodule 指针 bump 后必须重新 `pnpm install` 再生 lockfile，否则 CI `--frozen-lockfile` 必挂；`git add` 含不存在路径会整批静默失败，stage 后必跑 `git status` 核对。
- **main 新增双副本的最终登记**（P1 期间 #191/#192/#194 等合入）：`lib/modelDisplay.ts`、`components/sessionRowStatus.ts`、`lib/providerForm.ts` 三个已随 P2 收编；`lib/attachmentsToContent.ts` 依赖 `useKimiWebClient` 的 `PromptAttachment` 类型，P7+ 再收。
- 验收：`pnpm test` 2414 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅（合入 main 后复测全绿）；双端发消息冒烟未跑（需人工补）。
- **包改名（2026-08-05，随本 PR 落地）**：共享包与 desktop 共用，"web-" 前缀名不副实——`@moonshot-ai/{web-core,web-ui,web-markdown,web-i18n}` → `app-{core,ui,markdown,i18n}`，目录 `packages/web-*` 同步改 `packages/app-*`；计划中的 `web-client` 以 `app-client` 落地；`vite-preset` 不动；app 包名 `kimi-code-web` / `kimi-code-app` 不动（AGENTS.md 硬约束）。历史 plan/spec 文档保留旧名不改。改名后复测全绿（test 2414 / typecheck / lint / build）。注意根 `vitest.config.ts` 的 packages include 是花括号写法，批量 sed 会漏，需手改。
- 无 changeset（纯重构）。

### P2 — 已完成（2026-08-11；PR #196 合入 main squash 61135322）

- 完成：14 个模块下沉 `packages/app-core/src/client/`——`types.ts`（32 个渲染类型，两端仅头注释差异）+ `eventBatcher` / `turnsProjector` / `applyRecordDiff` / `messagesToTurns` / `latestTodos` / `swarmGroups` / `auxiliaryTranscriptToTurns` + P1 缓批 `parseDiff` / `diffLines` / `diffFullTexts` / `toolDiff` / `notificationXml` / `swarmCardRows`。两端 `src/types.ts` 改 re-export 壳（照 `api/types.ts` 先例，46 个 `./types` import 站点零改动）；app-core exports 新增 `./client` 与 `./client/types` 子路径；两端 50 个文件 import 改指包。
- **P1 缓批 6 个 lib 模块落 `client/` 而非 `lib/`**：全部依赖 client/types（渲染层 helper），保持分层单向（client → lib，不倒挂）。
- **`normalizeToolName` 抽取**：`messagesToTurns` / `latestTodos` / `toolDiff` 引它，但它住的 `toolMeta.ts` 顶层 import `../i18n`（P3 批）——纯函数部分（NAME_ALIASES + normalizeToolName）抽到 `app-core/src/lib/normalizeToolName.ts`，app 侧 `toolMeta` import 并 re-export，全部调用点不动。
- **收编 P1 期间 main 新增双副本**（P1 台账登记「P2+ 待收编」）：`lib/modelDisplay.ts` / `lib/providerForm.ts` / `components/sessionRowStatus.ts` → `app-core/src/lib/`（均纯、仅依赖 api/types），desktop 侧 3 个测试随迁，web 重复的 `sessionRowStatus.test.ts` 删除。`lib/attachmentsToContent.ts` 依赖 `useKimiWebClient` 的 `PromptAttachment` 类型，P7+ 再收。
- **测试随迁与去重**：desktop `applyRecordDiff` / `auxiliaryTranscriptToTurns` / `diffFullTexts` / `notificationXml` / `turnsProjector` + web `swarm-card-rows` / `swarm-groups` / `turn-logic` 随迁入 `packages/app-core/test/`；web `apply-record-diff.test.ts`（desktop 版复制品）与 `turns-projector.test.ts`（desktop 版子集，desktop 多 SessionPlan 历史重建用例）删除。`event-batcher.test.ts` 拆分：resync / snapshot recency 两个套件动态 import `useKimiWebClient`（P7+ god object）拆出留 `apps/web/test/`（`pendingDelta` helper 两端各留一份），3 个纯套件进包。
- 验收：`pnpm test` 2409 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅ / `check:style` 无新增 findings（.vue 仅 import 行变动）✅；双端发消息冒烟待人工补。
- 无 changeset（纯重构）。

### P3 — 已完成（2026-08-11；PR #197 合入 main squash d718ea3f）

- 完成：`agentEventProjector.ts`（1559 行）下沉 `packages/app-core/src/api/daemon/`；api 壳合并——`createKimiWebApi(deps: { origin, identity, tracer, credentialStore, t, mainAgentOnly? })` 工厂落 `packages/app-core/src/api/createKimiWebApi.ts`，两端 `api/bootstrap.ts` 各瘦身为 ~75 行接线（tracer / credentialStore / runtime config / i18n t），`mainAgentOnly` desktop `true`、web 不传（spec 归属矩阵 §102/117 原已预登记，无需改）。两端 `src/api/` 剩 `bootstrap.ts`（接线）+ `config.ts`（runtime config，按计划留端）+ re-export 壳（index/types/errors）+ desktop 独有 `devBackend.ts`。
- **t 注入口径**：`contracts.ts` 新增 `Translator` 类型；`createAgentProjector(deps: { t: Translator })`；模块级 helper（`patchSubagent` / `projectSubagentProgress` / `subagentProgressText` / `toolArgSummary`）逐线穿参。两端 bootstrap 传 `(k, p) => p === undefined ? i18n.global.t(k) : i18n.global.t(k, p)`（沿用 useKimiWebClient 的 CreateCoreDeps.t 先例）。**已知问题（计划内不修）**：已投影进 state 的文本不随切语言重算。
- **toolMeta 拆解（P1 遗留 i18n 批）**：`toolLabel` / `toolSummary` / `toolChip` + `ToolChipInput` 下沉 `lib/toolText.ts`（t 首参）；`toolIconName` / `toolGlyph` 依赖 `./icons`（P5）滞留 app 侧；app `lib/toolMeta.ts` 改薄壳——绑定 app i18n 的柯里化 re-export，全部调用点零改动。
- **activitySummary 拆解（同上批）**：下沉 `lib/activitySummary.ts`（`summarizeActivity` / `summarizeLive` t 首参）；其依赖的 `formatDuration` 从 `components/chatTurnRendering.ts` 抽至 `lib/formatDuration.ts`（chatTurnRendering 改 re-export，与 formatTokens 同模式）；app `lib/activitySummary.ts` 改薄壳。
- **测试**：projector 两端测试本就互补（desktop 8 套件 retry/goal/subagent-model + web 13 套件 streaming/cron/BTW/lifecycle），合并为包侧单文件 52 用例，identity t 桩（断言本就不依赖本地化文案）；`ws-lifecycle` / `daemon-client`（tracer 换录制假桩，web_log 脱敏断言改对录制记录——脱敏发生在包内 client.ts:739）随迁；web 独有 `activitySummary.test.ts` 随迁并改用真 `createKimiI18n`（app-core devDeps +`@moonshot-ai/app-i18n`，无循环）；删除 P2 漏网的 web 重复 `src/lib/providerForm.test.ts`（17 条与包侧全同，总数 2409→2392 全部来自此删）。
- **app-core tsconfig**：`noPropertyAccessFromIndexSignature` 显式设 `false` 与消费者对齐（web tsconfig 独立未开、desktop renderer 显式关）——否则迁入的 projector 在包自检下报 102 个 TS4111，而实际编译面（apps typecheck）一直是关的。注意：包级 `vue-tsc -p packages/app-core` 无任何门禁在跑，main 上本就有 79 个存量 error（desktopFlag 的 `__KIMI_WEB_DESKTOP__` 全局声明在 app 侧 env.d.ts 等），P3 未治理。
- **openFileAttachment / mediaPreview 未收，改归 P4（app-client）**：两者除 api 单例外还拖 PhotoSwipe / CSS / `@moonshot-ai/app-ui` 等 UI 层依赖，不该进 app-core；P4 建 client 包时连同注入缝一起处理更顺（偏差登记）。
- 验收：`pnpm test` 2392 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅；动了连接/事件层，外部 server 模式（`KIMI_SERVER_URL`）+ 双端冒烟待人工补。
- 无 changeset（纯重构）。

### P4 — 已完成（2026-08-11；PR #198 合入 main）

- 完成：新建 `@moonshot-ai/app-client` 包（`packages/app-client/`，exports `.` / `./composables` / `./contracts`，deps app-core + app-i18n，peer vue；纳入根 vitest include 花括号列表；两端 package.json 声明 workspace 依赖）。`src/contracts.ts` 定义 `ProductTracker`（`track(event, payload)` + `noopProductTracker`），**未接线**（P6 desktop 接 track 适配器、web 接 no-op）。
- **迁移 15 个 composables**（`packages/app-client/src/composables/`）：纯批 `useIsMobile` / `useViewportWidth` / `useFollowScroll` / `useResizable` / `useConfirmDialog` / `useComposerDraft` / `useComposerAutoFocus` / `useInputHistory` / `useSlashMenu` / `useMentionMenu` / `useSidebarLayout` 零改动直迁（两端副本实测仅头注释差异）；`useTerminal` / `useFilePreview` / `useDetailPanel` 落注入缝后迁；`usePageTitle` 两端合并。
- **注入缝（§3.3 模式）**：`useTerminal(sessionId, api: KimiWebApi)`（原 `getKimiWebApi()` 单例 ×3）；`useFilePreview({ client, detailTarget, t, api })`——t 注入替 `useI18n()`，api 窄化为 `Pick<KimiWebApi, 'getFileBlob'>`，god object 类型耦合改窄结构接口 `FilePreviewClient`；`useDetailPanel` 同理定义 `DetailPanelClient` / `DetailPanelAuxiliaryTranscripts` 窄接口（turns / activeAppTasks / auxiliaryTranscripts / sideChat 系列）。`TurnFileChange` 类型从 `components/chatTurnRendering.ts` 上移 `app-core/src/client/types.ts`（chatTurnRendering 改 import + re-export，8 个组件 import 站点零改动）。调用点：Terminal.vue / App.vue 两端各一处适配新签名（t 沿用 `(k, p) => …i18n.global.t` 包装先例）。
- **usePageTitle 合并**：标题参数化（默认 `Kimi Code`，web 传 `Kimi Code Web`），转圈动画按计划按 `isDesktop`（app-core/lib desktopFlag）分支关闭——desktop 静态标题、web 动画，两端行为逐字保持（行为对齐点：两端标题逻辑单源）。
- **测试**：8 个测试随迁 `packages/app-client/test/`（desktop useFollowScroll/useResizable/useMentionMenu/useDetailPanel.agentTranscript/detail-panel-toggle + web composer-draft/input-history/slash-menu），77 用例全绿；web `mention-menu` / `detail-panel-toggle` 与 desktop 版逐行相同（仅 import 路径）删除（总数 2392→2375 全部来自此）；detail-panel-toggle 随新签名去掉 vue-i18n mock 改传 t/假 api。desktop 独有 `useNativeTerminal.test.ts` 滞留（原生桥相关）。
- **约束条目随阶段更新（计划要求）**：根 AGENTS.md 目录地图 packages 清单 + apps/web 依赖约束放行 app-client；apps/web/AGENTS.md 的 api/composables/lib 布局描述与 wire.ts 引用一并刷到 P1–P4 后的实际结构。
- **openFileAttachment 收编 / mediaPreview 缓迁**：`openFileAttachment` 实测仅依赖 `getKimiWebApi().getFileBlob`，注入 api（`Pick<KimiWebApi,'getFileBlob'>` 首参）后落 `packages/app-client/src/lib/`（新增 `./lib` 出口），ChatPane/Composer 两端 4 个调用点适配；web 侧 11 用例随迁（vi.mock api 单例改直接传假 api）。`mediaPreview` 拖 PhotoSwipe + CSS 资产 + `@moonshot-ai/app-ui`（openDialogCount）——收编需要先决策 app-client 的依赖面（是否引 app-ui/photoswipe、包内 CSS 出口形态），不属于本批；登记待后续阶段（P5 icons 批前后）专项处理。
- 验收：`pnpm test` 2375 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅；双端冒烟待人工补。
- 无 changeset（纯重构）。

### P5 — 已完成（2026-08-11；PR #199 合入 main squash 3488055c）

- 完成：两端 `icons/kimi/*.svg` 合并（71 个，共有文件逐字节相同，desktop 仅多 `keyboard.svg`）移入 `packages/app-client/src/icons/kimi/`；`lib/icons.ts` 取并集（desktop 版，仅多 keyboard 一项）落 `packages/app-client/src/icons/icons.ts`，新增 `./icons` 出口；两端 16 个 import 站点改指 `@moonshot-ai/app-client/icons`。
- **vite iconsDir 指包内**：app-client 显式 export `./package.json`，四个配置（两端 vite.config + vitest.config）统一 `fileURLToPath(new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-client/package.json')))`——`import.meta.resolve` 对带 exports map 的包必须显式声明该子路径，否则抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`（计划预判的坑，按预案落地）。
- **icons.test 随迁的连锁**：`~icons/*` 虚拟模块需要 unplugin-icons 插件，根 vitest 的 packages 内联 project 无插件——app-client 新增自己的 `vitest.config.ts`（复用 vite-preset 的 plugins），根 config 把 app-client 从花括号列表拆出为独立 project 条目；app-client devDeps +`@moonshot-ai/vite-preset`。web 侧 icons.test 与 desktop 版仅头注释差异，删除（总数 2375→2366 全部来自此）。
- **mediaPreview 收编（P3/P4 登记的尾巴）**：落 `packages/app-client/src/lib/mediaPreview.ts`（css 随迁，侧效应 import 在包内源码下由消费者 vite 处理，无需 CSS 出口）；api 注入（`Pick<KimiWebApi,'getFileBlob'>` 进 `ImagePreviewOptions`，MediaLightbox 两端各一处适配）。依赖面决策：app-client deps +`photoswipe` + `@moonshot-ai/app-ui`（openDialogCount 是无头计数器，app-ui 不反向依赖 app-client，无环）——自此 app-client 分层修正为「Vue composables + 浏览器层 UI helper」，根 AGENTS.md 描述沿用。
- 验收：`pnpm test` 2366 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅ / `check:style` 29 findings 与 main 基线相同 ✅；**全量图标视觉验证**（DesignSystemView §02 图标目录页逐排核对）+ 双端冒烟待人工补。
- 无 changeset（纯重构）。

### P6 — 已完成（2026-08-12；PR #207 合入 main squash 6646cf97）

- 完成：`ProductTracker` 接线落地 + 5 个 telemetry/平台分叉 composable 收编 `packages/app-client/src/composables/`，两端副本（10 个文件）删除。
- **注入缝形态（计划只写「app-client 接线」，实测定为模块级 registry）**：`contracts.ts` 追加 `setProductTracker` / `track` 委托（no-op 默认）；desktop 在 `main.ts`（`installClientErrorCapture` 后）`setProductTracker(productTracker)`——适配器放 `lib/track.ts`（`track(event as RendererEventName, payload as never)`，包内事件绕开 desktop 编译期契约，主进程 zod schema 仍是运行时边界）；web 不动（no-op 默认即「注入 no-op」，行为与现状一致）。参数透传方案被否：track 调用点散在 4 个 composable 深层，registry 让迁移 diff 只剩 import 行。
- **useNotification**：desktop 版为正本；`NotificationKind` 改本地联合类型（对齐 track-events.ts:183 zod enum，摆脱 shared/track-events import）；i18n 解耦走 P3 模式——copy 三函数 `t: Translator` 首参（`@moonshot-ai/app-core/contracts`），`useNotification(deps: { t })`，两端 `useKimiWebClient` 传 `(k, p) => …i18n.global.t` 包装；`shouldNotifyCompletion` 保持无参纯函数。
- **useAttachmentUpload**：desktop 版为正本；`AttachmentUploadDeps` 新增必填 `api: Pick<KimiWebApi,'getFileBlob'>`（替 `getKimiWebApi()` 单例），两端 `Composer.vue` 传 `api: getKimiWebApi()`。
- **useOAuthLoginFlow / useUpdateStatus**：仅 track 改 contracts + 头注释，其余逐字节不动。行为对齐点两条（随 PR 描述声明）：① web 两处 `setAutoDownload` 调用补 `source` 参数（UpdateIndicator `'update_prompt'` / SettingsDialog `'settings'`，与 desktop 一致）；② web 获得 desktop 的 oauth `flowCancelled` poll 守卫（D 类并集）。`useUpdateStatus` 头注释保留 "Desktop-only" 字样（描述功能归属，web 无桥降级说明文件内已有）。
- **useAuxiliaryTranscripts**：两端实测已字节一致，纯移动（无头注释，未加）。
- **测试合并随迁 5 文件进 `packages/app-client/test/`**：desktop 超集版 oauth（20 例）/ updateStatus（19 例）直接收编，web 子集版删除；attachment-upload 合并 = web 上传逻辑 24 例 + desktop 埋点 4 例（无逐行重复）；notification-logic（23 例）改 `createKimiI18n({ locale: 'en' })`；useAuxiliaryTranscripts（7 例）仅改 import。埋点断言统一从「mock window.kimiDesktop / vi.mock lib/track」改为 `setProductTracker({ track: spy })` + afterEach 复位 `noopProductTracker`。
- **基线偏差**：P5 台账记的 2366 已过时——P5 后 main 前进（#200–#204），HEAD 实测 2383；本次净 -27 → 2356，全部来自 web 两个子集测试文件删除（oauth -13 / updateStatus -14），其余删除均在包内 1:1 重建。
- **环境坑**：`pnpm build` 首跑挂在 kimi-code submodule 的 node-sdk（缺 `@microsoft/api-extractor`，submodule 根 manifest 有声明但未装）——`kimi-code/` 内补跑一次 `pnpm install` 即可，tracked 内容不受影响。
- 验收：`pnpm test` 2356 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅ / `check:style` 29 findings 与基线同 ✅；**desktop 侧埋点冒烟**（notification_shown / attachment_added / oauth_login_step 各触发一次，主进程日志可见）**+ 双端发消息冒烟待人工补**。
- 无 changeset（纯重构）。

### P7a — 已完成（2026-08-12 本地实施 + 验收；PR #208 合入 main squash d11a8c89）

- 完成：三个 client 状态模块（`useTaskPoller` / `useSideChat` / `useModelProviderState`）+ `attachmentsToContent` 收编 `packages/app-client/src/client/`（新 `./client` 出口，归属矩阵指定位置），两端 8 个副本文件删除。
- **实测与计划的大幅偏差（有利）**：§1.1 登记的 184 行 `useModelProviderState` 分叉（web toast vs desktop inline banner 错误处理）在 main 上已自行收敛——三模块实测仅头注释 + 6 处日志前缀差异（`useSideChat` 字节一致、`useTaskPoller` 仅头注释）。**R4 产品确认不再必要**，web 侧表单组件无需适配。
- **迁移障碍与对策**：三模块都依赖 app 侧 `getKimiWebApi()` 单例与 god object 类型——① `ExtendedState` / `PromptAttachment`（连同被引用的 `ManagedMembership` / `GitStatusEntry` / `QueuedPrompt`）抽到 `client/types.ts`，两端 `useKimiWebClient` 删 165 行定义块、原位 re-export（消费者 App.vue / ConversationPane / ChatDock / Composer 零改动）；② api 以全量 `KimiWebApi` 注入（`useTaskPoller` 追加第三参 deps；另两个加 deps 首字段），调用点传 `getKimiWebApi()`；③ `beginLocalTurn` / `settleLocalTurn`（`useWorkspaceState` 模块级函数，P7b 才动）作 deps 函数字段注入。
- **`attachmentsToContent` 落 `client/` 而非 lib/**：依赖 `PromptAttachment`（client/types），包内保持 client → lib 单向不倒挂（沿用 P2 分层纪律）。P1/P2 台账登记的「P7+ 再收」至此收编。
- **行为对齐点**：6 处日志前缀 `[kimi-web]` → `[kimi-code]`（§3 品牌统一既定决策）。
- **`useTaskPoller` 的 tasksBySession 整体替换按计划保留原样**（P9+ 拆解期修复清单）。
- **测试**：task-poller（3 例）/ side-chat（5 例）随迁（`vi.mock` api 单例 → deps 注入 apiMock）；两端字节相同的 `modelThinking.test.ts`（各 61 例）确认对 useKimiWebClient 仅 type import，迁入包内一份、删两端——P1 台账登记的「P7 后清理」完成。总数 2356→2295（净 -61 即此），文件 154→153。
- 验收：`pnpm test` 2295 ✅ / `typecheck` ✅ / `lint` 0 error（4 warning 均存量）✅ / `build` ✅ / `check:style` 29 findings 与基线同 ✅；**provider 增删改全流程冒烟（两端）+ 双端发消息冒烟待人工补**。
- 无 changeset（纯重构）。

### P7b — 已完成（2026-08-17；PR #255 合入 main squash a657d569）

- 完成：两大单例（`useKimiWebClient.ts` 4072 行 / `useWorkspaceState.ts` 3687 行）`git mv` 自 desktop 副本进 `packages/app-client/src/client/`，web 副本删除——**双份副本正式消灭**：`apps/web/src/composables/` 只剩 `useDialogFocus`，desktop `composables/` 只剩专属文件（useNativeTerminal / usePlugins / useShortcuts 等），`composables/client/` 目录两端均消失。两端 38 个文件 import 改指 `@moonshot-ai/app-client/client`。
- **注入缝落地（`client/deps.ts` 注册表）**：`KimiClientDeps` = `api` / `t` + 可选 `traceClientEvent` / `traceKeyEvent` / `sessionExportTraceToJsonl` / `onSessionDestroyed` / `onWorkspaceDestroyed` / `consumeSessionIntent` / `onPluginsShelfEvent`；`setKimiClientDeps` 在两端 `main.ts`（composition root）注册，web 只注册 api/t/trace 三项，可选 hook 全 no-op 即 web 现状。registry cell 存 `globalThis`——`vi.resetModules` 后 fresh module graph 仍共享同一注册表，单例集成测试（event-batcher / goal-turn-end 等的动态 import 模式）接线零特殊处理。
- **模块级求值问题与对策（计划未预判）**：`useKimiWebClient` 模块级构造 4 个子组合式时调用 `getKimiWebApi()`，而注册发生在 main.ts body（imports 求值之后）——包内 `getKimiWebApi()` 改为返回**稳定 lazy facade（Proxy）**，方法查找在调用时才解析注册实例。由此 P7a 四个子模块与全部 40+ 处 `getKimiWebApi()` 调用点**零改动**，无需 provider 形态改造。
- **计划外新增注入缝**：plugins shelf（计划写就后 desktop #217 长出）——`onPluginsShelfEvent` hook；web 不注册时 pluginsChanged/capabilityChanged 落回原 reducer 路径（行为逐字保持）。`connectEventsIfNeeded` 改由包导出，desktop plugins shelf 消费不变。
- **telemetry 收编**：`track` 改走 P6 的 `contracts.track`（web no-op 即现状）；`session-intent` 为可选 hook（默认返回 fallback）；`SessionCreatedSource` 联合类型包内本地定义（P6 `NotificationKind` 先例，desktop 主进程 zod schema 仍是运行时边界）。
- **行为对齐点（web 跟随 desktop，随 PR 描述逐条声明）**：日志前缀 `[kimi-code]`、`workspaceName` 兜底 `kimi-code`、`selectSession` 的 `skipTrack`/`source` 参数链、connection_lost/restored 追踪（web 侧 track no-op，无实际事件）。
- **测试**：13 个文件随迁进 `packages/app-client/test/`（`vi.mock` api/track → `setKimiClientDeps` / `setProductTracker` 注册模式）：8 个计划内 + 5 个出清——`goal-turn-end` / `apply-event-slices` / `session-work-reconnect`（同单例集成模式，原清单漏登记，src 一删即红），两份 `workspaceStateGitStatus` 副本删除（包内已含相同覆盖）；`workspaceStateFlatPaging` 双份合并。trace 断言换录制假桩（`sessionExportTraceToJsonl` 假桩按真实实现的白名单投影序列化，保住 webLog 脱敏断言语义）；workspace-state 用 `createKimiI18n({ locale: 'en' })`。总数 2527（main 已大幅前进，与 P7a 的 2295 不可直接比）。
- **验收**：`pnpm test` 2527 ✅ / `typecheck`（两端）仅 `app-core/src/client/auxiliaryTranscriptToTurns.ts:231-232` 两个 **main 存量 error**（f88775da #251 引入，已用 origin/main worktree 复核实测，与本 PR 无关，建议独立小修）✅ / `lint` 0 error（5 warning 均在 app-core 存量，迁移文件零 findings）✅ / `build` ✅ / `check:style` 29 findings 与基线同 ✅。
- **尾巴**：① ~~会话全链路冒烟待人工补~~ **已完成（2026-08-17，agent-browser 双端实测）**：临时工作区（/tmp 两个 git repo）+ 独立 server 实例（58628，不碰用户 58627 进程）下——web：新建（draft→session）/选择/归档/prompt/Bash 工具/审批批准/AskUserQuestion 选择提交/工作区增删/杀 server 后页面不重载自动重连并恢复流式，全过；desktop（外部 server 模式 + CDP）：同清单全过，另验证原生工作区选择面板正常打开。存量会话与工作区零触碰，测试产物已清理（3 个测试会话已归档、两个临时工作区已注销）。② 存量行为确认非回归：server 不广播 `event.workspace.created`（REST 建的工作区其他客户端 reload 才见）；③ 根 AGENTS.md「开发顺序」条目涉及双副本同步的措辞待 P18 核对。
- **Review（2026-08-17，4 代理分切面全量）**：移动文件逐 hunk diff / 注入缝与接线 / import 重接与导出完整性 / 测试迁移保真度四切面，无 blocker/major。跟进修复（commit ea220f7d）：① 补掉唯一漏网的 `[kimi-web]` 前缀（session-work 重试日志，两端 main 存量同行，desktop 日志输出因此变一行）；② native-todos.md 两条指向 `useKimiWebClient.ts` 的分叉条目就地更新为注入 hook 现状（全文重写仍留 P18）；③ trace 假桩白名单去掉 `busy`（真实 export ring 不投影它）并修正注释；④ 两端 App.vue 同桶重复 value import 合并。PR 描述对齐声明补 `logout` 一条。记录在案不修：immediate watcher 安全性依赖「模块求值时 workspaces 为空」隐式不变量（当前可证明安全）。
- **合 main（2026-08-17 晚，#242 web document.title）**：冲突为两个 web 副本的 modify/delete——按 P1 既定口径，main 侧修改落进包内正本后 `git rm` 旧路径。`useDocumentTitle`（#242 新增、web 侧文件）连同其测试迁包（包单例不能 import app 侧模块），`webTitle`/`documentBaseTitle`/applyMeta 赋值/facade 导出 4 个 hunk 逐字补进包单例（其中 `webTitle: ''`、types 字段、applyMeta 行已被 rename-merge 自动落进包内，diff 核实零丢失）。desktop 标题行为不变（`usePageTitle({ running })` 静态标题，isDesktop 分支）。注意坑：`git mv` 后的文件再被 perl 改会出现 AM 状态——merge commit 里漏了头注释/测试 import 两处路径修正，追加 ec72a2b7 补齐。验收：test 2541 ✅ / typecheck 仅 2 个 main 存量 ✅ / lint 0 error ✅ / build ✅；PR mergeable=CLEAN。
- 无 changeset（纯重构）。

### P8 — 本地实施 + 验收完成（2026-08-17；与 P9–P12 同 PR 合入）

- 完成：Pinia 全量引入（pinia 4.0.3，仅 app-client 声明依赖）+ 首个 domain store `kimi.sessions`（`packages/app-client/src/stores/sessions.ts`）。state 收编：sessions / activeSessionId / pinnedSessionIds；facade 的写入漏斗（setSessions / updateSession / upsertSessionSorted / appendSession / removeSession / setActiveSessionId）与 pin 系列（pinSession / unpinSession / unpinSessions / togglePinSession）**逐字搬入 store action**。
- **关键设计（计划未预判）：pinia 实例由包持有**。`stores/pinia.ts` 导出 `clientPinia`，两端 `main.ts` `app.use(clientPinia)` 安装同一实例。起因：包内 client 单例在 import 时构造（先于任何 app），`useTaskPoller` 的模块级 immediate watcher 读 `activeSessionId`——`getActivePinia()` 时序根本不可用。每个 store 配 `xxxStore()` accessor（内部 `useXStore(clientPinia)` 显式传实例），模块级 / 测试 / 生产全场景安全；组件内 `useXStore()` 走 inject 解析到同一实例。
- **桥接而非批量替换**：facade `rawState` 的 sessions / activeSessionId 改 accessor（getter/setter 转发 store），`pinnedSessionIds` 改 computed 别名、pin 函数改委托——**~180 处存量读取点零改动**，useWorkspaceState / useModelProviderState / useTaskPoller / useSideChat 与 SessionsMutators deps 注入接口零改动，apps 两端组件零改动（facade 导出面不变）。写入纪律由 store action 收口（桥接 setter 同样转发 action，devtools 可见）。规范 §5 按实践校准（包持 pinia / `kimi.` 前缀 id / 桥接为过渡形态、新代码必须直接用 store / setup store devtools 无 mutation 记录故无需规避 / 测试模式）。
- **测试**：新增 `sessions-store.test.ts`（11 个）：漏斗行为（recency 排序 / id 去重 / pin 持久化经内存 localStorage stub）+ 桥接双向联动（store→facade computed 响应式跟踪；facade renameSession/pinSession→store action）。集成层模式：`vi.resetModules` 后动态 import facade 与 store（同一 fresh 模块图共享 fresh clientPinia）。存量 2544 测试零改动全绿（模块级 import 安全由全体 facade 集成测试顺带证明）。
- **行为对齐点**：无实质行为变化。`forgetSession` 的 pin 清理简化为 `unpinSession` action（内部 no-op 判断与原 includes 守卫等价）；pinnedSessionIds 从 import 时初始化变为首次 store 解析时初始化（均为 app 运行路径，等价）。
- **验收**：`pnpm test` 2555 ✅ / typecheck 仅 2 个 main 存量 error（同 P7b，与本 PR 无关）✅ / lint 0 error（5 warning 全 app-core 存量，与基线同）✅ / build ✅ / check:style 29 与基线同 ✅。
- **冒烟（2026-08-17，agent-browser 双端实测）**：临时工作区（/tmp git repo）+ 独立 server 实例（58628，不碰用户 58627 进程），存量会话只读浏览零触碰。**web**：列表分组渲染 / 会话切换 / draft→新建（upsertSessionSorted）/ 流式 busy / AI 自动标题 / pin（置顶区 + 「有 1 条对话被置顶」计数）/ **刷新后 pin 保持**（localStorage→store 初始化链路）/ 归档（列表移除 + pin 自动清理 + 自动选中下一会话），全过。**desktop**（外部 server 模式 + CDP 9223，不碰用户 9222 实例）：同清单全过（pin 为 per-device localStorage，两端互不干扰符合预期）。测试产物已清理（2 个测试会话已归档、临时工作区已 REST 注销、实例与端口全释放，用户 58627 未受影响）。
- **Review（2026-08-17，explore 代理全量）**：无 blocker/major。action 逐字等价 / 桥接正确性（cloneState 引用比较优化仍有效）/ 漏网零（pinnedSessionIds 无写入残留）/ import 时序安全 / 测试保真 / 文档一致。跟进：lockfile 剔除 submodule 回退衍生物（semver 修剪 hunk，仅存 pinia 新增）；规范 §5 反例行号修正（useTaskPoller.ts:34→:74）。记录在案：pinia peer `@vue/devtools-api@^8.1.5` 解析到 6.6.4（strict-peer-dependencies=false 容忍，仅影响 devtools 集成，运行时无感）；store 四个 action（updateSession/upsertSessionSorted/appendSession/removeSession）暂仅测试调用、生产走 facade 漏斗经桥接落 store——P9+ 收敛时删 facade 副本。
- 无 changeset（纯重构）。

### P9 — 本地完成（2026-08-18；与 P8 同 PR，commit 4802c7a6）

- `kimi.notifications` store 收编：notifyEnabled / notifySound / notifyPermission state + setNotifyEnabled / setNotifySound + maybeNotifyCompletion / Question / Approval（自 `composables/useNotification.ts` 逐字搬入；该文件只剩纯函数与 types——shouldNotifyCompletion / copy builders / ctx types）。facade 三处触发点（onMainTurnEnd / onQuestionRequested / onApprovalRequested 的 ctx 组装）留 facade——深嵌事件流，P14/P15 时自然迁移。
- 行为对齐点：t 的注入路径等价（旧工厂注入的 t 与 store import 的 deps t 同为注册表委托）。无实质行为变化。
- 测试：notification-logic.test.ts 23 个原样保留（preferences/tags/copy 三组），迁移为 store 模式（state 直写复位 + setKimiClientDeps 注册真 i18n t）。

### P10 — 本地完成（2026-08-18；commit a65309a7）

- `kimi.models` store 收编 state：models / starredModelIds（持久化）/ providers / draftModel / skillsBySession / skillsByWorkspace；toggleStarModel 与 loadSkillsForSession / loadSkillsForWorkspace 整体搬（api 经包内 getKimiWebApi()）。useModelProviderState 工厂保留编排 action（setModel / activateSkill / provider CRUD / OAuth / setThinking——依赖 facade 注入的 12 个回调，真整体转会成环，故 state 收编 + 工厂读写 store），return 的 state 改 computed 别名（组件 `client.models.value` 零改动）。
- useWorkspaceState 的 draftModel 读/写（startSessionAndSendPrompt 的 draft 应用）改 `modelsStore()` 直取——deps 注入接口开始按规范「跨层共享一律 store 直取」收缩。
- 测试：modelThinking.test.ts 62 个保留，播种/断言改 store（createModelProvider 内 setModels + draftModel/providers 复位隔离；625 行一处漏网的 `provider.models.value =` 直写是迁移中唯一被 computed 只读抓出来的点）。

### P11 — 本地完成（2026-08-18；commit 12f4bd73）

- `kimi.approvals` store 收编 approvalsBySession / questionsBySession（rawState 改 **getter-only 桥接**——整表替换在编译期即被拒，比 sessions 的 setter 桥更严）。actions：applyApprovalsDiff / applyQuestionsDiff（reducer 写回，包 applyRecordDiff 守逐 key 纪律）、setSession*（快照种子）、removePending*（**从 useWorkspaceState 的整表替换改为 per-key 写**——读取方全部按 `[sid]` 键或 Object.entries 读、无浅 watch，触发语义等价且跨会话失效更少，属拆解期顺手修复）、clearSession*（forgetSession / pendingInteraction 权威清理）。
- **buildApprovalBlock 双份合并**：facade 副本（useKimiWebClient.ts:2203）删除，app-core `messagesToTurns.ts` 副本改 export 成唯一实现（11 个分支逐字语义比对一致，差异仅 `d.x` vs `d['x']` 语法）。
- 测试：workspace-state.test.ts 的 respond 三例播种/断言改 store（respondApproval 保留 mock rawState 播种——其实现仍经桥接读 ExitPlanMode 查找，双播种对齐）；131 个全绿。

### P12 — 本地完成（2026-08-18；commit 2faed870）

- `kimi.files` store 收编：~/diff 视图五件套（selectedDiffPath / fileDiffLines / fileDiffLoading / fileDiffTexts / fileDiffEmptyFile）+ gitStatusBySession（getter-only 桥接）。loadFileDiff / clearFileDiff / loadGitStatus / readFileContent **整体搬入**（跨域读取仅 sessionsStore().activeSessionId 与 sessionsStore().updateSession——store 间依赖单向 files → sessions）。FS_PATH_NOT_FOUND_CODE / toSessionPullRequest / samePullRequest 随迁。loadGitStatus 的 record 整表替换顺手改 per-key 写（同 P11 修复）。
- useWorkspaceState 的 deps 接口删掉 5 个 ref 字段（facade 传参同步收缩）；facade return 的 fileDiff 系导出改 store 委托。
- 测试：workspaceStateGitStatus.test.ts 重写为 store 直测（播种 sessionsStore、断言 filesStore/sessionsStore；「无 pool churn」的 toBe 身份断言改为 reactive proxy 读取比较，语义保留）。

### P9–P12 合并验收（2026-08-18）

- **门禁**：`pnpm test` 2555 ✅ / typecheck 仅 2 个 main 存量（auxiliaryTranscriptToTurns.ts，与本 PR 无关）✅ / lint 0 error（5 warning 基线）✅ / build ✅ / check:style 29 基线 ✅。
- **Review（explore 代理全量，47f0970a..HEAD）**：无 blocker/major。搬运保真 / buildApprovalBlock 逐分支等价 / 漏网零 / 分层无环 / 模块级时序安全 / 测试保真。跟进（commit 1ff04e5f）：barrel 补 filesStore 导出、useModelProviderState 多余缩进、三个测试文件的死传参（P12 已删的 5 个 ref 字段，被 as cast 掩盖）、spec §5 桥接清单补三个 getter-only 条目。记录在案：workspace-state.test.ts 的 createDeps 缺 connectIssue 为 P8 前存量（cast 掩盖）。
- **冒烟（agent-browser 双端，独立 server 58628 + 临时工作区 /tmp/kimi-p9-ws-a，不碰用户 58627 与存量会话）**：**web**——通知设置渲染（权限未授予时系统通知开关正确置灰）/ 提示音切换 + 刷新后保持（localStorage→store 初始化）、模型选择器列表渲染 + 切换（K3 0813→K3，含 thinking 重解析）、审批卡 shell 分支渲染（命令/cwd/四操作）+ 批准（卡片消失 + 待授权 badge 消失 + echo 执行）、变更面板（分支/+1 -1/M 标记）→ diff 视图（-hello world/+hello kimi 红绿行）→ 返回（clearFileDiff）、文件预览（readFileContent 内容随修改更新），全过。**desktop**（外部 server + CDP 9223）：审批卡渲染 + 批准全链路、变更面板 → diff 视图，全过。测试产物已清理（2 个测试会话已归档、工作区已注销、实例与端口全释放）。
- 无 changeset（纯重构）。

### 二期计划立项（2026-08-20，原 Q 系列编号）

- 依据为当日全量代码评审（架构锐评 / Vue 用法专项 / gap 分析三份附件）+ 本台账 P0–P12 完成状态。原一期 P13–P15、P18 由 Q1–Q3、Q22 承接；P16/P17 被 Q10–Q12 取代并扩大。

### 两计划文档合并（2026-08-25）

- 一期计划（`2026-08-01-renderer-architecture-refactor.md`）与二期计划（`2026-08-20-renderer-refactor-phase2-plan.md`）合并为本文档，两原件删除；`docs/specs/2026-08-01-renderer-architecture.md` 中的总计划引用改指本文档。
- **编号统一**：已完成阶段保留 P0–P12；原二期 Q0–Q22 顺延重编号为 P13–P35；原一期未做的 P13–P18 编号作废（去向映射见 §3 开头）。
- 一期已完成阶段的原始 §5 明细删除（执行记录以本台账为准）；原一期未做条目的内容并入对应新阶段：P13–P15 的拆解范围并入 P14–P16，P17 的 App.vue 瘦身残项（slash 解释器下沉 / dialog 状态收编 / ServerAuthDialog i18n）并入 P24。
- 一期 §1 调研明细与 §3 目标架构不再重复保留：目标态正本为 `docs/specs/2026-08-01-renderer-architecture.md`，历史版本见 git。
- 合并前二期计划已按 PR #324 review 修订：P28（原 Q15）删旧 daemon 兼容设计（对齐仓规「不做旧服务端兼容逻辑」）；P27（原 Q14）修正「shallowRef 与逐 key 写回天然兼容」的错误结论（改 shallowReactive / 整引用替换二选一）；P22（原 Q9）DesignSystemView 改 desktop 单份正本（不下沉 app-ui，避免 app-ui ↔ app-client 循环依赖）；P20（原 Q7）明确无桥降级 = 隐藏 Open In 入口；P24（原 Q11）删 `toRefs` 包装 facade 方案。
- 无 changeset（纯文档）。

### 按 main 复测与计划修订（2026-08-25）

- **背景**：合入 main 最新 23 个 commit 后复测，其中两项颠覆性变更——#279 主线 transcript 迁移（Phase 0–3 全部完成，`messagesBySession` 切片与 projector/reducer 消息路径删除）与 web Composer 的 ProseMirror 迁移（app-composer 内核，`skillName` 漂移同步修复）。
- **条目修订**：
  - P19：前置已完成，从「迁移 + 壳下沉」简化为「壳合一 + 下沉」（规模 大→中）；壳在 main 上已涨到 4364/4595 行（desktop/web），mention pills / attachment registry 新逻辑多在壳内。
  - P27/P28/P29/P33：前提被 #279 颠覆，按 transcript 产线重写——P27 目标 slice 重列（`messagesBySession` 已删）；P28 的 frameClassifier 只剩全局事件 / 生命周期 / 侧聊分类；P29 的隐式 turn 状态改述为 facade `turnStartBySession` generation map / `turnActiveBySession` / workspaceState 队列与乐观气泡；P33 场景清单重列（`event-batcher` / `goal-turn-end` 测试已删，`session-work-reconnect.test.ts` 已 6583 行，属补缺口非从零建网）。
  - P24：删 slash 解释器下沉项（已完成，`app-core/src/lib/slashCommands.ts`）；App.vue 瘦身剩 dialog 状态收编 + ServerAuthDialog i18n（仍硬编码 `"Token"` 等）。
  - §7 新增 #279 遗留恢复项：goal 卡实时性、warnings 实时性、goal turn-end seam 测试缺口。
- **数据刷新（2026-08-25 实测）**：`useKimiWebClient.ts` 6197 行（较 08-20 +48%）/ `useWorkspaceState.ts` 4308 行；零差异组件 95→73（字节一致 33 + 仅首行 40）+ 真实分叉 30 + web 独有 2；DesignSystemView 漂移 75→130 行；App.vue `client.xxx.value` 144→188 处；巨型组件行数 ConversationPane 3198/3155、Composer 4364/4595、Sidebar 2783/2516、App.vue 2945/2331（desktop/web）。
- **复核仍成立（不改）**：P13 全部（ProviderForm:340 index key、死 channel `onMenu`/`kimi:menu`、`kimi:open-external` IPC 无 http(s) 白名单——`external-links.ts` 守卫只管 webContents、无 errorHandler/onErrorCaptured、ci.yml 无 build job）；P18（组件 `import { track }` 15 文件、组件侧 `contracts.track` 为 0）；修复清单残余（`errorName`/`errorMessage` 双份、`PersistSessionProfilePatch` 双定义、facade 死 provide）；现代化计数全 0（defineModel/defineSlots/useTemplateRef/onWatcherCleanup/AbortController/v-memo）；`shallowRef` 3 处 / `markRaw` 0；PRESUMED 12 处；`ApprovalCard` 两端仍 106 行差异；tool-calls 17 个文件 16 个零差异。
- 无 changeset（纯文档）。
