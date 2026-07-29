# 流式代码块高亮丢失：根因实锤与确定性修复报告

日期：2026-07-29 ｜ 结论状态：**已实锤（源码级 + 受控实验双重验证）**

## 摘要

流式输出中的代码块高亮「偶现有、偶现无，定居后也可能永久纯文本」，根因在 **markstream-vue@1.0.5** 的 `MarkdownCodeBlockNode` 组件（`dist/index8.js`）：

1. `De()` 无参调用时**永远不会断开上一个 MutationObserver**（短路 bug），流式期间每个内容 chunk 泄漏一个 observer；
2. 泄漏的过期 observer 在新 DOM 写入时抢先执行，把当前渲染周期的「待绘制键」`se` 清成 `null`；
3. 当前 observer 因此拿不到 `se`，无法把纯文本兜底切换回高亮 DOM，代码块永久停在纯文本。

**修复是一行**：让 `De()` 无参调用真正断开当前 observer。打补丁后，同一受控实验从「永久纯文本」变为「稳定上色并保持」，静态渲染无回归。

与 app 侧无关：`Markdown.vue` 的渲染计划（实测该消息判为 `shiki`）、CSP、WASM、打包产物、`app://` 协议、0.0.12 的全部 markdown 改动均已逐项排除。

## 症状与影响面

- 流式进行中的代码块：第一个 chunk 上色一次后，后续 chunk 到达即退回纯文本兜底，直到流式结束仍是纯文本（即截图状态）。
- 偶现「有」：首次上屏时机、rAF 落盘与 nextTick 的相对时序、observer 回调先后，三路随机变量叠加。
- 历史会话（重新挂载的静态块）**不受影响**——首次绘制走的是另一条必然成功的路径，这也解释了为何 bug 主要在流式期间被感知。

## 根因（源码级）

以下标识符均为 `markstream-vue@1.0.5` 压缩产物 `dist/index8.js` 中的真实符号。

### 设计机制

组件挂载即渲染纯文本兜底（`Fe()` 输出 `<pre class="shiki shiki-fallback">`），然后异步增强：

- 每个内容更新触发 watch → `Fe(u)`（显示兜底）→ `je(epoch, n)`（在渲染容器上装一个 MutationObserver，等待 shiki-stream 在 rAF 中落盘高亮 DOM）→ `kn()` 调 `updateCode` → `Ee()` 暂存待绘制键 `se = key`。
- rAF 落盘触发 observer 回调：`ue+=1; const t=se; if(t) return cn(e) ? paint(se) : (se=null, De(l))`——epoch 当前则 `Ne(t)` 绘制（`le=''`、`oe=true`，高亮 DOM 取代兜底）；epoch 过期则清理。
- `Ee` 自身的绘制条件 `a && (!ie || r || i || ie===t)` 只在**首次**（`ie` 为空）必然成立；首次之后的重绘**只能**走 MutationObserver 回调（`i` 依赖 rAF 落盘早于 nextTick，是竞态，不可靠）。

### 缺陷 A（决定性）：`De()` 无参不断开 observer

```js
function De(e){null==e||e.disconnect(),e&&re!==e||(re=void 0)}
```

- 调用 `De()`（无参，本意「断开上一个 observer」）时：`null==e` 为 true → **短路，`e.disconnect()` 永不执行**；仅把引用 `re` 置空。
- 于是每个流式 chunk 都在渲染容器上**多泄漏一个存活 observer**，且全部带 `subtree:true` 持续回调。
- 泄漏的过期 observer 回调命中 `se` 已暂存的时刻，走过期分支 `se=null, De(l)`——**把当前周期的待绘制键清掉**；当前 observer 随后回调拿到 `se===null`，放弃绘制。兜底永久驻留。

### 运行时证据（探针日志，修复前）

每个 chunk 周期稳定复现（epoch 8 窗口）：

```
[watch] epoch=8 len=126 Ie=true
[je] install epoch=8 ue=10
[Ee] a=true r=false i=false ie==t:false        ← Ee 不绘制
[MO] fire se=set  ue=10 n=4  cn=false          ← 过期 observer(n=4) 抢跑
[MO] fire se=null ue=11 n=7  cn=false          ← 过期 observer(n=7)
[MO] fire se=null ue=12 n=10 cn=true           ← 当前 observer：se 已被清，放弃
```

- 同一窗口内 3 个 observer 实例同时存活（`n=4/7/10` 分属 epoch 6/7/8 安装的实例）——直接证明 `De()` 泄漏。
- `updateCode` 每次都正常 RESOLVED（无挂起、无抛错、无任何 console 告警）；高亮 DOM 在后台持续更新（采样末期 302 个 token span、样式表 762 字符均在），只是被兜底层遮住。

## 实验

### 环境

`/tmp/hl-probe`（隔离环境，未动仓库代码）：markstream-vue@1.0.5 / stream-markdown@0.0.16 / shiki@4.3.1 / vue@3.5.39（与线上 lockfile 完全一致），Vite + 本机 Chrome headless（playwright-core），`MarkdownRender` 的 props 逐项复刻 `packages/web-markdown/src/Markdown.vue`（`mode:chat`、`code-renderer:shiki`、github 双主题、`code-block-props` 含 `loading:false`、`smooth-streaming`、`defer-nodes-until-visible:false`）。以 50ms 间隔采样 `data-markstream-enhancement-state`、token span 数、共享样式表长度、兜底 pre 可见性。

### 结果（A/B）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| S1 冷启动 + 36 chunk × 100ms | 约 1s 上色一次后退回纯文本；**流式结束及 +9s 仍 pending + 兜底可见**（= 线上截图） | 989ms 上色；流式结束 `ready`；+9s 保持 |
| S2 冷启动 + 36 chunk × 800ms | 同样永久纯文本（排除「chunk 间隔竞态」假设） | 1570ms 上色；结束 `ready`；保持 |
| S0 静态一次性渲染 | `ready`，97 span，正常 | `ready`，无回归 |

### 修复补丁（验证用）

```diff
- function De(e){null==e||e.disconnect(),e&&re!==e||(re=void 0)}
+ function De(e){const t=e||re;t&&t.disconnect(),(!e||re===e)&&(re=void 0)}
```

语义对照：显式 `De(l)`（回调内自用）行为不变；`De()` 无参现在正确断开 `re` 指向的当前 observer——过期 observer 不再存活，无法清 `se`，当前 observer 在每次 rAF 落盘后稳定完成绘制。

## 为什么「偶现有偶现无」

- **有**：首次绘制（`Ee` 的 `!ie` 分支）必然成功一次；若随后某次 rAF 落盘恰好早于 `Ee` 的 nextTick 检查（`i=true`），或当前 observer 抢在过期 observer 之前回调，就能再上色一次。三个事件同帧竞争，结果随机。
- **无**：一旦过期 observer 抢先（概率随泄漏数量逐 chunk 增大），`se` 被清，该周期及之后全部周期都只能停留在兜底——流越长、chunk 越多，越接近必然无。
- 定居（流式结束）后无新 mutation，失效状态自我锁定，即「截图里定居后仍纯文本」。

## 确定性修复方案

**方案一（推荐）：pnpm patch 锁定修复**

```bash
pnpm patch markstream-vue@1.0.5
# 编辑临时目录中的 dist/index8.js，应用上面的 De() 补丁
pnpm patch-commit <临时目录>
```

补丁作用于安装产物，随 `pnpm install` 自动应用，CI/打包链路无需改动。注意 desktop 与 web 共用同一 lockfile 依赖，单点修复两端生效。

**方案二：上游修复**

向 markstream-vue 提 issue/PR（附本报告的机制说明与复现），待发版后 bump 依赖。周期长，建议先用方案一落地，上游发版后移除 patch。

**不建议的绕道**：定居时强制重挂代码块（不治流式期间）、预热 shiki（只影响首次上屏时机，不修本 bug）、改 `code-renderer`（因噎废食）。

## 备注

- 修复后流式中 `pending→ready` 会逐 chunk 抖动一次（`Fe` 同步显示兜底、observer 同帧内切回），肉眼基本不可感；若要彻底消除需改 markstream 的兜底策略，不在本次范围。
- 早期静态分析阶段曾怀疑「epoch 中止竞态 / shiki 冷加载预热」，S2 慢 chunk 实验将其证伪（800ms 间隔仍必现），最终根因以本报告实验证据为准。
- 探针环境保留在 `/tmp/hl-probe`（含 instrumentation 补丁与 runner 脚本），可复现本报告全部数据；仓库代码未做任何改动。
