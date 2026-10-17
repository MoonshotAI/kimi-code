---
name: bobo-code-review
description: Use when the user says "代码审查", "review 一下", "帮我审查", "CR", or expresses intent to review code changes. Use when changes touch auth, API routes, sensitive data, or deletion logic. Use when the user wants a thorough review, not just a quick check.
---

# Bobo Code Review

> 八步流程：范围 -> 扫描 -> 对抗 -> 根因 -> 修复 -> 重扫 -> 报告 -> 闭环。
> 这不是"读 diff 给意见"：这是**对抗式审查 + 第一性原理根因升华**的完整工作流。
> 唯一硬输出：**通过**（零 P0/P1 + 零 plausible_blocking）或**不通过**。

## 与普通 Review 的区别

| 普通 review | 本工作流 |
|---|---|
| 读 diff -> 列问题 | 先确定性扫描（事实清单，零幻觉） |
| 单人判断 | 对抗式：review agent 判定 + skeptic agent 从三视角质疑 |
| "这里没鉴权" | "为什么鉴权靠手动加？同类还有哪些？是 isolated 还是 systemic？" |
| 修完结束 | 修完 -> 重扫 -> 重审 -> 闭环判定通过 |

## 模式选择

| 用户说 | 走哪些步 |
|---|---|
| "代码审查" / "CR" / "review 一下" | 全流程 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 |
| "快速扫一下" / "有没有明显问题" | 1 -> 2 -> 7（只扫描，不做对抗） |
| "验证修复" / "重审" | 5 -> 6 -> 8（重扫 + 重审已修复项） |

## 八步流程

### 1. 确定范围

- 确认审查目标（整个项目 / 某个子系统 / 未提交改动 / PR diff）。
- 确认当前分支；如果是在生产分支上审查工作区改动，要明确提醒用户。
- diff 基线：默认未提交改动；`--full` 全量；`--base <ref>` 指定对比基线。

### 2. 阶段 A：确定性扫描

目标：产出事实清单（非判断），零幻觉、可复现。

优先用 `review-scan`（通用确定性扫描器）。它自动发现项目结构（manifest -> project unit）、识别框架（FastAPI/Flask/Django/Express/NestJS/Koa/Spring/gin/echo/axum/actix 等）、遍历全部源码目录，并扫描以下七个维度：

- **S1 路由清单**：所有 API 端点（多框架自动识别）。
- **S2 鉴权**：每个路由是否有鉴权标志（跨框架通用标志 + 项目 `.code-review.yml` 可追加）。
- **S3 SSRF**：接受 URL 参数的端点是否校验了目标地址；无配置时降级为 INFO 事实，配了 `ssrf_guard_functions` 则精确判断。
- **S4 密钥**：硬编码的密钥、密码、Token（16 位以上字符串赋值）。
- **S5 跨存储删除**：删实体函数是否覆盖全部关联存储（通用锚点 + 项目 `.code-review.yml` 可追加）。
- **S6 裸 fetch**：前端直接 `fetch()` 调用（排除 auth client 封装和公开 URL）。
- **S7 错误吞没**：`except: pass` / `catch: return null` 不 raise。

用法：

```bash
review-scan --root <项目目录> [--full] [--json] [--base <ref>]
```

无 `review-scan` 时，降级为 `rg` / semgrep / 项目测试的手动扫描，但必须覆盖以上全部维度。

输出格式：每条 finding 含 `id / project / subsystem / file / line / category / severity / evidence`。`route` 类标 INFO（供审查参考），其余标 P0-P2。

### 3. 阶段 B：对抗审查

仅当有 actionable findings（非 INFO）时执行。分两轮：

**Round 1：Review agent** 逐条判断四种状态：

- `confirmed`：已读码确认，bug 真实存在。
- `plausible_blocking`：证据强但未 100% 确认，影响高。
- `refuted`：明确误报，有正面证据。
- `needs_repro`：需运行验证才能判定。

**Round 2：Skeptic agent** 质疑审查员判断，三视角缺一不可：

1. **正确性 lens**：审查员的判断在代码逻辑上是否正确。
2. **可复现 lens**：这个问题能否被实际触发。
3. **攻击者 lens**：恶意用户怎么利用？即使逻辑没坏，能怎么滥用？

可用时，让 skeptic 使用与 review agent 不同的模型或子 agent 角色，降低同一推理路径的盲区重叠。若当前环境不支持多模型或子 agent，也必须显式采用 skeptic 视角重新审查，不得把 Round 1 结论直接当作最终结论。

关键规则：

- 默认从 `plausible_blocking` 起评，不直接 `refuted`。
- 只有拿出正面反驳证据才能转 `refuted`。
- `plausible_blocking` 不得因"证据不足"降级为 `refuted`。
- 如果审查员说 `refuted` 但攻击者能利用，升级。

### 4. 第一性原理根因升华

对每条 `confirmed` / `plausible_blocking` 追问四问：

1. **本质是什么**：剥离表象。"PUT 无鉴权"的本质不是"漏加了 Depends"，而是"鉴权无统一抽象，必然遗漏"。
2. **为什么出现**：底层原因，不接受"开发者忘了"这种表层解释。
3. **同类还有哪些**：同一根因的其他实例。
4. **系统性判断**：`isolated`（孤立失误）还是 `systemic`（系统性设计缺陷）。

对 `systemic` 的问题再做修复检查：

- 治症状还是根因？
- 隐含假设成立吗？
- 覆盖所有同类情况吗？
- 不治根因会在哪里复发？

### 5. 修复 P0/P1

- 必须先出方案、用户确认后再改。
- 改完必须重新跑步骤 2 + 3。
- P0/P1 不修 = 不通过。

### 6. 重扫 + 验证

修完后重新跑步骤 2 + 3，确认：

- 问题已消除。
- 无新引入的 P0/P1。
- 之前 `plausible_blocking` 的项已闭环。

### 7. 报告

产出审查报告，包含：

- 结论（通过 / 不通过）。
- 每条 finding 的最终状态和处置。
- 升华出的系统性根因。
- 未闭合项（如有）。

### 8. 闭环判定

- **通过**：零 P0/P1 + 零未解决 `plausible_blocking`。
- **不通过**：有未修复 P0/P1 或未解决 `plausible_blocking`。
- **不允许**：用"我改完了"代替验证；必须实际跑通重扫、重审、验证。
- **不允许**：跳过任何一步。不允许声称"完成了"除非流程以「通过」终止。

## 例外规则识别

审查时需主动识别以下设计如此（非 bug）的模式：

- `<img>` 标签引用的图片路由（浏览器不发 Authorization 头）。
- `sendBeacon` 路由（不支持自定义请求头）。
- 登录注册入口（auth/captcha / auth/login / auth/register）。
- Webhook 入口（签名校验替代 JWT）。
- `/health` 健康检查。
- 早期或遗留子系统的已知弱鉴权现状（标注而非逐路由报 P0）。

遇到疑似例外时标注原因（如"webhook 入口，签名校验替代 JWT"），而非直接降级为 `refuted`。

## 硬规则

1. 不通过必须修复 P0/P1，修复后必须重新触发流程。
2. 只有零 P0/P1 且零 `plausible_blocking` 时才能给「通过」。
3. 不允许用"我改完了"代替验证；必须实际跑通重扫、重审、验证。
4. 不允许跳过任何一步。不允许声称"完成了"除非流程以「通过」终止。
5. 先出方案再改代码；口头"改吧"不能直接动手。
6. 有测量才给数字；所有计数必须来自工具输出。
