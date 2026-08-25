# Vue 3 最佳实践（2026 版）

> 适用版本：Vue **3.5.x**（当前最新稳定版 3.5.41，2026-08）。技术栈前提：`<script setup>` + TypeScript + Vite。
> 3.6（RC 阶段，Vapor Mode）的升级建议见文末。
> 本文档是通用实践，不绑定任何具体项目；每条规则尽量给出"为什么"和"踩坑点"。

---

## 目录

1. [工程基线](#1-工程基线)
2. [SFC 组织与 script setup](#2-sfc-组织与-script-setup)
3. [响应式 API 选择](#3-响应式-api-选择)
4. [组件 API 设计：props / emits / v-model / slots](#4-组件-api-设计)
5. [Composables 约定](#5-composables-约定)
6. [状态管理决策树](#6-状态管理决策树)
7. [模块划分与目录结构](#7-模块划分与目录结构)
8. [模板实践](#8-模板实践)
9. [副作用与资源清理](#9-副作用与资源清理)
10. [异步与错误处理](#10-异步与错误处理)
11. [性能清单](#11-性能清单)
12. [测试策略](#12-测试策略)
13. [反模式速查表](#13-反模式速查表)
14. [Vue 3.6 前瞻](#14-vue-36-前瞻)

---

## 1. 工程基线

| 项 | 推荐 | 说明 |
|---|---|---|
| 写法 | `<script setup lang="ts">` 唯一风格 | 不要混用 Options API / `defineComponent`，一个仓库一种写法 |
| 类型 | `strict: true` + `vue-tsc` 进 CI | 组件类型检查不走 build 的转译层（esbuild 不做类型检查） |
| Lint | oxlint（type-aware）或 ESLint + `eslint-plugin-vue` | 把团队约定固化成规则，靠 CI 不靠自觉 |
| 版本 | 全仓库单一 Vue 副本 | monorepo 用 pnpm catalog/overrides 统一；两个 Vue 副本是诡异 bug 之源 |
| 运行时 | Node LTS + `engine-strict` | 避免"我机器上能跑" |

配套建议：编辑器强制 Volar（Vue 官方插件），禁用 Vetur 残留；`tsconfig` 开 `noUncheckedIndexedAccess` 对大型表单/字典类型尤其值。

## 2. SFC 组织与 script setup

**单一职责是唯一的硬标准。** 参考阈值（不是教条，是体检线）：

- script 部分 **>300 行**：一定有可提取的 composable 或子组件；
- props **>15 个**：组件大概率承担了多个角色，或该改成注入/插槽组合；
- 一个 `<style>` 块比大多数组件还长：样式在替缺失的组件拆分打补丁。

**script setup 内部顺序约定**（全仓库统一，配合 banner 注释）：

```
imports → defineProps/withDefaults → defineEmits → defineModel
→ 响应式状态（ref/reactive）→ computed → watch → 普通函数 → 生命周期钩子
```

理由：任何人打开文件，前 30 行就能看到组件的"契约"（输入、输出、模型），实现细节在后。

**其他约定**：

- 组件文件名 PascalCase，与组件名一致；一个组件一个文件。
- `<style scoped>` 是默认；全局样式只允许两层：design token（CSS 变量）和 reset。禁止用全局样式"从外部"改子组件内部（`:deep()` 同理，能不用就不用——那是组件 API 没设计对的信号）。
- 逻辑出现第二次复制就提取。复制粘贴的分叉若必须存在（如多平台），配显式台账 + CI 防漂移检查。

## 3. 响应式 API 选择

### 决策表

| 场景 | 用什么 | 为什么 |
|---|---|---|
| 原始值、需要整体替换引用的对象 | `ref` | 默认选择；替换引用即触发，语义最简单 |
| 同生共死的聚合状态（表单草稿、wizard 状态） | `reactive` | 字段间无独立替换需求；**永不直接解构**（除非配合 `toRefs`） |
| 派生状态 | `computed` | 必须**纯净**：无副作用、无 async、无 DOM 读取。需要反向写入才用 get/set 形式 |
| 大型/不可变对象：服务端记录、第三方实例、大列表 | `shallowRef` + 整体替换（identity change） | 深响应式对几千个流式对象的递归代理是实打实的 CPU 和内存税；`shallowRef` 让"数据变了"等于"引用换了"，diff 一目了然 |
| 第三方类实例、不可序列化对象 | `markRaw` | 阻止 Vue 代理，避免破坏实例内部不变量 |
| composable 返回 `reactive` 对象且调用方要解构 | `toRefs` | 保持解构后的响应性 |
| 向下游暴露的状态 | `readonly` 包一层 | 写入口唯一，改状态只能走你的 action |

### 三条铁律

1. **服务端数据默认 `shallowRef`。** 服务端推送/拉取的记录是"外部事实"，你从不就地改它的字段——那就不要为它付深代理的钱。更新 = 整条替换。这条对流式场景（聊天、日志、行情）收益最大。
2. **派生状态永远 computed，不用 watch 模仿。** "watch 一个源然后手动同步另一个 ref" 是把缓存失效这个最难的问题揽上身；computed 的依赖收集和缓存是框架白送的。
3. **watch 的源用 getter，不watch整个 reactive 对象。** `watch(() => state.x, …)` 精确表达依赖；`watch(state, …)` 隐式 deep，性能和语义都糊。

### 常见误区

- `reactive` 上展开运算符 / 直接解构 → 丢响应性（3.5 的 props 解构是编译器特批，普通 `reactive` 没有这个待遇）。
- computed 里发请求、读写 DOM、改其他 ref → 依赖追踪被污染，缓存失效时机不可预测。
- 模板里写 `{{ obj.value }}`：模板对**顶层** ref 自动解包，但对普通对象**属性**上的 ref 不自动解包—— composable 若返回"装 ref 的普通对象"，模板里就得处处 `.value`。要么返回对象本身用 `reactive`/`toRefs` 处理，要么接受 `.value` 汤并配 lint 检查。

## 4. 组件 API 设计

### 输入：props

```ts
// 类型声明 + withDefaults，布尔默认 false，对象/数组给默认值工厂
const { size = 'md', items = [] } = defineProps<{
  size?: 'sm' | 'md' | 'lg'
  items?: Item[]
}>()
```

- 3.5+ **props 响应式解构**：上面这种解构写法在 script 和模板里都保持响应性，优先于 `props.x` 满天飞的写法（看团队口味二选一，但要统一）。
- props 是**公共契约**：起名像给 API 起名。避免 `data`/`config`/`options` 这种什么都能装的口袋 prop。
- 避免深对象 prop 当"参数包"——超过 3-4 个字段时，多半是该拆成多个 prop 或改用插槽/v-model 的信号。

### 输出：emits

```ts
const emit = defineEmits<{
  submit: [value: FormValue]
  'update:filter': [f: string]
}>()
```

对象签名（3.3+），事件名 kebab-case。emits 声明了就是契约的一部分——**父组件该听的没声明、声明了没人发，都是 bug 培养皿**。

### 双向绑定：defineModel（3.4+，优先使用）

```ts
const modelValue = defineModel<string>()          // 等价于 modelValue prop + update:modelValue emit
const open = defineModel<boolean>('open')          // 命名 model
```

一行替代 3-6 行的手写 prop+emit 对。所有表单类控件（Input/Select/Switch/Tabs/Dialog 的 open）都应该用它。手写 `modelValue` + `update:modelValue` 是 3.4 之前的历史写法，新代码不要再用。

### 插槽：defineSlots

```ts
defineSlots<{
  default(props: { item: Item }): any   // 作用域插槽：数据在子组件，渲染交给父组件
  empty(): any
}>()
```

- 展示型组件优先暴露插槽而不是"配置 prop"——插槽是 Vue 里最强大的组合机制，能插槽解决的不要发明 `renderXxx` prop。
- 纯展示库可以没有作用域插槽；但凡组件持有数据而渲染需要定制（列表项、表格行、菜单项），就该用作用域插槽。

### 其他

- `defineExpose` **最小化**：只暴露命令式句柄（`focus()`、`scrollTo()`），绝不暴露内部状态——暴露状态等于把组件内部变成了公共 API。
- attrs fallthrough：默认让它落在根元素（class/style/aria 自动继承是好事）；需要转投到内层元素时 `inheritAttrs: false` + `v-bind="$attrs"`，并在注释里说明落点。
- 弹层类组件（Dialog/Sheet/Tooltip/下拉面板）一律 `Teleport` 到 body——否则 stacking context 和 overflow 裁剪会让你在 CSS 里打一场必输的仗。
- **组件通信优先级**：props/emits → v-model → 插槽 → provide/inject → 全局状态。能用前一层解决就不要升到后一层。

## 5. Composables 约定

```ts
export function useFollowScroll(
  target: MaybeRefOrGetter<HTMLElement | null>,   // 输入接受 ref/getter/裸值
) {
  watchEffect((onCleanup) => {
    const el = toValue(target)                     // toValue 归一化；放在 watchEffect 里才能对变化重新求值
    if (!el) return                                // 模板 ref 挂载前是 null
    const observer = new ResizeObserver(onResize)
    observer.observe(el)
    onCleanup(() => observer.disconnect())         // 随下次触发或作用域销毁释放
  })
  return { isFollowing, scrollToBottom }           // 返回 refs + 方法的普通对象
}
```

规则：

1. **命名 `useX`，输入 `MaybeRefOrGetter`，内部 `toValue` 归一化**——调用方传 ref、getter 或裸值都能工作。注意 `toValue` 必须放在 `watch`/`watchEffect`/`computed` 这类会重复求值的位置调用：模板 ref 在 setup 阶段还是 `null`，一次性 `toValue` 会把初始值快照死，元素挂载后 observer/监听器也绑不上去。
2. **单一职责**：一个 composable 解决一个问题（滚动跟随、草稿持久化、菜单键盘导航），不解决"这个页面需要的所有逻辑"。
3. **资源清理挂 `onScopeDispose`**（不是只挂 `onUnmounted`——composable 可能用在 `effectScope` 里）；可能在 setup 外被调用的，用 `getCurrentScope()` 守卫。
4. **DOM 逻辑接受 ref 参数**，不在 composable 内部 `document.querySelector`——后者把 composable 焊死在特定 DOM 结构上，不可测。
5. **共享单例要显式**。模块级 `ref` 的 composable 是合法模式（全局单例），但必须满足：命名或注释显式声明单例语义（如 `useSharedX`）、有 dispose 策略、依赖可注入以便测试。**最反模式的是"看似普通 composable、实则全局单例"**——调用方以为拿到的是自己的状态，其实在改全局。
6. 规模红线：单个 composable 返回 **几十个绑定**、内部混着协议处理/应用 action/视图映射多个内聚层级时，它就是一个穿着 composable 外衣的类——按域拆。

## 6. 状态管理决策树

```
状态只此组件用？          → ref/computed，别上升
父子/近亲组件间？          → props/emits、v-model
跨 2+ 层、少数消费者？      → provide/inject（必须 InjectionKey<T>）
跨模块共享、要 DevTools/
  持久化/SSR？             → Pinia（按域分 store）
服务端数据？               → 专用数据层（见下），不手塞组件
```

**provide/inject 的纪律**：一律 `InjectionKey<T>`，禁止裸字符串 key——字符串 key 对类型系统不可见、无法查找引用、改名即静默断链。provide 了就要有人 inject；类型化的 provide 无人消费是死代码，要么用起来要么删掉。

**provide/inject vs Pinia：不是替代关系。** 两者解决不同问题——inject 是**依赖注入**（子树作用域、可覆盖、可多份、测试可换 mock），Pinia 是**全局状态容器**（DevTools 时间旅行、持久化、SSR、热更新）。inject 有三个 Pinia 替代不了的主场：

1. **复合组件家族内部通信**（Tabs/Tab、Menu/MenuItem、Form/FormItem 的父子注册）——全局单例表达不了"这个 Tab 只属于这个 Tabs"；
2. **子树级局部共享**——只有这棵子树需要的上下文，放全局是污染；
3. **平台能力/服务注入**——同一接口多端不同实现（如 tracker：桌面端注入 IPC 实现、web 注入 no-op），这是 inject 的主场，Pinia 干不了。

Pinia 的主场是**跨无关组件树的业务状态**，以及一切需要"看见状态流动"（调试/持久化/SSR）的场景。inject 被骂通常是因为被拿去传业务状态——类型靠手动维护、状态流向不透明、inject 时机错了运行时拿 undefined——那是拿 inject 干了 Pinia 的活，不是 inject 本身的问题。**口诀：状态归 Pinia，能力归 inject，组件家族内部归 inject。**

**Pinia 实践**：用 setup store 风格；按**域**分 store（`useSessionStore` / `useConnectionStore`），不按技术层分（`useDataStore`）；store 之间少互相引用，组合在组件/composable 层做。

**服务端状态 ≠ 客户端状态**：远端数据有自己的生命周期（缓存、失效、重新拉取、乐观更新）。要么用 query 类方案（TanStack Query 有 Vue 版），要么自研一个明确的 repository/同步层（事件溯源、快照+增量都可以）——但**它是一个层**，不是散在各组件里的 fetch 调用。这一层的正确性（竞态、重连、过期）值得配最厚的测试。

**禁止项**：god store / god composable（几百个绑定的单一出口）；全局事件总线（mitt 当架构用）；组件通过读写 localStorage 通信。

## 7. 模块划分与目录结构

**按域（feature/domain）切，不按技术类型切。** 推荐形态：

```
src/
  modules/
    chat/           # components/ composables/ stores/ api/ types.ts
    settings/
    workspace/
  shared/
    ui/             # design system：原语组件 + token，零业务依赖
    lib/            # 纯函数
    api/            # 传输层：协议类型、HTTP/WS 客户端
```

**三层单向依赖**（依赖只能向下）：

```
UI 组件（纯展示，props in / emits out）
  → composable / store（状态与交互逻辑）
    → api / client（协议、传输、持久化）
```

判定标准：UI 组件删掉后，下层代码应该一行都不用改还能跑（并且能单测）。反过来，UI 组件里出现协议细节（请求路径、wire 字段名）就是依赖方向破了。

**monorepo / 多端的附加规则**：

- 共享 UI 库独立成包，**零业务依赖**（不知道什么是 session、什么是 daemon）。
- 平台差异用**注入接口**（adapter/provider：各端实现自己的 tracker、存储、原生桥），而不是整文件复制分叉。编译期 define 只留给真正不可调和的差异。
- 协议类型是**契约**：尽量从单一来源生成/校验（zod schema、代码生成），手写的"镜像类型"注定漂移。

## 8. 模板实践

1. **`v-for` 的 `:key` 必须是稳定业务 id。** index 只允许用在真正静态（不增删不重排）的列表；**可编辑/可删除的行用 index 作 key 是会产生真实状态错乱的 bug**（输入框内容串行、组件状态错位）。
2. **`v-if` vs `v-show`**：频繁切换用 `v-show`（display 切换）；条件成本高或首屏用不到用 `v-if`。想保留隐藏视图的完整状态（含滚动位置），考虑 `<KeepAlive>`——但记住失活视图的 watcher/observer 依然活着，重资源要在 `onDeactivated` 里收。
3. **不在模板表达式里调用有重计算的方法**（`v-for="x in computeBlocks(turn)"`）——每次 render 都会重调，N 个 item 调 N 次。派生数据用 computed 预先算好。
4. **`v-memo`**：大列表里精准跳过未变化子树的重渲染，配合稳定 key 使用。它是手术刀不是创可贴——先确认热点再上。
5. **大列表（几百项以上）必须虚拟化**：`@vueuse/core` 的 `useVirtualList` 起步，或成熟库。无界列表全量渲染是聊天/日志/表格类应用的第一性能杀手。
6. **`v-html` 只允许转义后或完全可信的内容**，每一处配 lint 例外注释说明来源为什么安全。
7. 表单校验放在 blur/submit，不在每次输入——每次输入全量校验既是性能问题也是体验问题（用户还没输完就一片红）。

## 9. 副作用与资源清理

| 场景 | 推荐写法 |
|---|---|
| 明确监听某数据源做副作用 | `watch(() => state.x, cb)`（getter 形式） |
| 依赖多且杂、同步 DOM/外部系统 | `watchEffect`（依赖自动收集；注意立即执行） |
| 需要等 DOM 更新后读取布局 | `flush: 'post'` |
| watcher 内启动的异步/订阅需要随下次触发或销毁清理 | `onWatcherCleanup`（3.5+）——必须在回调首次 `await` 之前的同步阶段注册；需要更晚注册的清理，改用 watcher 回调自带的 `onCleanup` 参数 |
| DOM 事件监听 | `addEventListener` + **`AbortController` signal** 解绑，替代手工 add/remove 配对；控制器在 `onScopeDispose`/`onBeforeUnmount` 里 `abort()`——signal 只是免去手工配对，abort 这一刀不能省，否则组件卸载后监听器仍存活 |
| Observer / timer / rAF | `onBeforeUnmount`（或 `onScopeDispose`）里**对称释放**：disconnect / clearTimeout / cancelAnimationFrame |
| 成组的可控副作用 | `effectScope()`，一次性 dispose |

**watch 的正当职业：把响应式变化同步到响应式系统之外**——DOM、第三方库实例、网络、storage、timer。它不是状态推导工具。watch 的数量多不是罪，**隐式因果链多才是**；滥用有五种典型形式：

1. **模仿 computed**：watch A → 手动同步 B。派生状态该用 computed（缓存、依赖收集是框架白送的）；watch 版要自己处理初始值（immediate）、多源顺序、缓存失效——把最难的问题揽上身。
2. **代替事件处理器**：副作用有明确触发动作（点了按钮、路由跳转）就写在动作里；写成 watch 后因果链变隐式，调试时回答不了"谁触发的"。
3. **watch 整个对象 / 滥用 `deep`**：你只关心 x，结果 y 变了也触发——性能税 + 语义模糊。源用 getter 精确表达依赖。
4. **链式 watch**：watch A 改 B、watch B 改 C……状态流向变成隐式图，级联更新和环极难排查。出现第二条链就该收敛成显式的 action 函数。
5. **异步 watch 不做竞态处理**：旧请求晚到覆盖新结果——必须配取消/序号（见下"竞态三件套"）。

**三问判断法**：① 这个值能从别的值**算**出来吗？→ 能，用 computed。② 这个副作用有明确的**触发动作**吗？→ 有，写进事件处理器。③ 我在把变化**同步到系统外**吗？→ 是，这才是 watch 的正职。

**异步竞态三件套**（每个 async 副作用都该自问）：① 回调回来时组件还在吗（disposed flag / scope 已停）？② 这是不是最新一次请求（seq 比对 / AbortController 取消上一次）？③ 失败时用户能看到什么（catch → 可见反馈，不是静默吞掉）？

`deep: true` 是代码气味的高发区：大多数时候它意味着数据源的形状不对（该用 computed 收敛出一个标量/不可变快照再 watch）。同样，监听 10+ 个源的 watcher 通常意味着"依赖没有被建模"——该把判定逻辑收进一个 computed，watch 那个 computed。

## 10. 异步与错误处理

- **代码分割**：路由级懒加载 + 重组件（编辑器、图表、设计系统目录页）用 `defineAsyncComponent`，并配 `loadingComponent` / `errorComponent` / `timeout`——不配错误态的异步组件，加载失败就是白屏。
- **错误兜底**：`app.config.errorHandler` 定位为全局上报/遥测兜底，关键子树（数据面板、第三方嵌入）加 `onErrorCaptured` 拦截传播。注意这两个钩子都只负责"知道出错了"，**不会自动渲染任何降级 UI**——友好降级要靠边界组件自己持有错误状态并条件渲染 fallback / 重试入口，否则渲染抛错只是从"带走整棵树"变成"留下一块空白"。**没有任何错误边界的应用，一个子组件渲染抛错会带走整棵树。**
- `Suspense` 可用于编排嵌套 async setup 的加载态；注意其在官方文档中的实验性标注，关键业务路径上保守使用。
- Promise 必须有人接住：每条调用链末端要么 `await`（错误上抛给边界），要么 `catch` 转成用户可见的反馈。"fire-and-forget + 无 catch" 等于把异常埋进控制台。

## 11. 性能清单

按收益排序，**测量先行**（Vue DevTools 的渲染计时 + Performance 面板），不猜：

1. 服务端/流式大数据：`shallowRef` + identity-replace；第三方实例 `markRaw`（见 §3）。
2. 大列表：虚拟化 + 稳定 key + 必要时 `v-memo`。
3. 派生计算：`computed` 缓存，模板表达式不调重方法。
4. 高频事件（scroll/resize/input/流式推送）：节流/防抖/批量提交（流式 delta 合批到 rAF 切片是成熟做法）。
5. 重视图保留：`KeepAlive`（配合 onActivated/onDeactivated 资源管理）。
6. 构建层：路由级分包、重组件异步、第三方库按需引入、检查产物里有没有混进 dev-only 代码。
7. 样式：token 化（CSS 变量）而非每个组件一份硬编码值——这不只是性能，是维护性和多主题能力。

## 12. 测试策略

| 层 | 工具 | 覆盖策略 |
|---|---|---|
| 纯逻辑（composable/store/reducer/协议映射） | vitest | **最厚的一层**。这一层可测性免费，投入产出比最高 |
| 组件 | vitest + @vue/test-utils | 测**行为**（渲染了什么、交互后 emit 了什么），不测实现细节（内部 ref 的名字） |
| 关键路径冒烟 | Playwright e2e | 少量、高价值：核心流程能走通，打包产物能起 |

两条元规则：

- **组件测不动，先怀疑组件设计**：逻辑和 DOM 测量焊死在 SFC 里就不可测——提取成 composable/纯函数后，测试自然成立。测试困难是架构反馈，不是测试问题。
- 测试文件与被测对象同域放置，命名一一对应，删除代码时测试一起删。

## 13. 反模式速查表

| 反模式 | 为什么是问题 | 正确做法 |
|---|---|---|
| 巨型组件（script 300+ 行、props 20+） | 多职责缝合，改一处牵动全身 | 提取 composable / 拆子组件 |
| god composable / god store（数百绑定出口） | 实际是全局类，依赖关系全隐式 | 按域拆 store；facade 只做组合 |
| 深 `reactive()` 吞流式大数据 | 深代理的 CPU/内存税，无收益 | `shallowRef` + identity-replace |
| 手写 `modelValue`+`update:modelValue` | 3.4+ 有一行语法 | `defineModel()` |
| 裸字符串 provide key | 类型系统看不见，改名即断 | `InjectionKey<T>` |
| provide 了无人 inject | 死代码，误导读者 | 用起来，或删掉 |
| props 四层逐层透传 | 每层重复声明，中间层被焊死 | 消费方直接 inject/用 store |
| 用 watch 同步派生状态 | 手动缓存失效，竞态温床 | `computed` |
| 模板表达式里调重计算方法 | 每次 render 重算 ×N | 预计算 computed |
| index 作可编辑列表的 key | 状态串行 bug | 稳定业务 id |
| 无界列表无虚拟化 | 长会话/大表必卡 | `useVirtualList` 等 |
| 整文件复制做多端分叉 | 漂移无感、修复只修一端 | 注入式平台接口 + CI 防漂移 |
| 无 errorHandler / 无错误边界 | 单点渲染错误带走整棵树 | 全局上报兜底 + 边界组件持有错误态渲染 fallback |
| 监听器手工 add/remove 配对 | 漏 remove 即泄漏 | `AbortController` signal（卸载时 `abort()`） |
| `querySelector` 藏在 composable 里 | 焊死 DOM 结构，不可测 | DOM 以 ref 参数传入 |

## 14. Vue 3.6 前瞻

- 3.6 目前处于 **RC 阶段**（rc.4，2026-08），核心看点是 **Vapor Mode**：不经过虚拟 DOM 的编译输出策略，显著降低运行时开销，可**按组件渐进启用**（单个 SFC 标记 vapor），与现有 VDOM 组件混用。
- 建议：**生产项目等 3.6 stable + 生态（vue-router / Pinia / Nuxt / 组件库）声明兼容后再升**；现在可以在非关键路径上试用 Vapor Mode 积累经验。
- 本文档的所有实践在 3.6 下继续成立——script setup、defineModel、shallowRef 纪律、状态分层都与渲染策略无关。Vapor Mode 是加速器，不是新的编程模型。

---

*版本说明：基于 Vue 3.5.41（2026-08 最新稳定版）撰写；3.6 特性以 RC 文档为准。*
