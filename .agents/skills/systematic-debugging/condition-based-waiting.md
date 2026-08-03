# 基于条件的等待

## 概述

不稳定的测试通常用硬编码延迟来猜测时序。这会造成竞态条件——在快速机器上通过，在高负载或 CI 环境下失败。

**核心原则：** 等待你真正关心的条件，而不是猜测它需要多长时间。

## 何时使用

```dot
digraph when_to_use {
    "测试使用了 setTimeout/sleep？" [shape=diamond];
    "是在测试时序行为吗？" [shape=diamond];
    "记录为什么需要超时" [shape=box];
    "使用基于条件的等待" [shape=box];

    "测试使用了 setTimeout/sleep？" -> "是在测试时序行为吗？" [label="是"];
    "是在测试时序行为吗？" -> "记录为什么需要超时" [label="是"];
    "是在测试时序行为吗？" -> "使用基于条件的等待" [label="否"];
}
```

**适用场景：**
- 测试中有硬编码延迟（`setTimeout`、`sleep`、`time.sleep()`）
- 测试不稳定（时而通过，高负载下失败）
- 并行运行时测试超时
- 等待异步操作完成

**不适用场景：**
- 测试实际的时序行为（防抖、节流间隔）
- 如果使用硬编码超时，务必注释说明原因

## 核心模式

```typescript
// ❌ 之前：猜测时序
await new Promise(r => setTimeout(r, 50));
const result = getResult();
expect(result).toBeDefined();

// ✅ 之后：等待条件满足
await waitFor(() => getResult() !== undefined);
const result = getResult();
expect(result).toBeDefined();
```

## 常用模式速查

| 场景 | 模式 |
|------|------|
| 等待事件 | `waitFor(() => events.find(e => e.type === 'DONE'))` |
| 等待状态 | `waitFor(() => machine.state === 'ready')` |
| 等待数量 | `waitFor(() => items.length >= 5)` |
| 等待文件 | `waitFor(() => fs.existsSync(path))` |
| 复合条件 | `waitFor(() => obj.ready && obj.value > 10)` |

## 实现方式

通用轮询函数：
```typescript
async function waitFor<T>(
  condition: () => T | undefined | null | false,
  description: string,
  timeoutMs = 5000
): Promise<T> {
  const startTime = Date.now();

  while (true) {
    const result = condition();
    if (result) return result;

    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    }

    await new Promise(r => setTimeout(r, 10)); // 每 10ms 轮询一次
  }
}
```

参见本目录下的 `condition-based-waiting-example.ts`，其中包含完整实现和领域专用辅助函数（`waitForEvent`、`waitForEventCount`、`waitForEventMatch`），源自实际调试过程。

## 常见错误

**❌ 轮询太频繁：** `setTimeout(check, 1)` —— 浪费 CPU
**✅ 修正：** 每 10ms 轮询一次

**❌ 没有超时：** 条件永远不满足时无限循环
**✅ 修正：** 始终设置超时并提供清晰的错误信息

**❌ 数据过期：** 在循环外缓存状态
**✅ 修正：** 在循环内调用 getter 获取最新数据

## 何时硬编码超时是正确的

```typescript
// 工具每 100ms tick 一次——需要 2 次 tick 来验证部分输出
await waitForEvent(manager, 'TOOL_STARTED'); // 首先：等待条件
await new Promise(r => setTimeout(r, 200));   // 然后：等待有明确时序依据的行为
// 200ms = 100ms 间隔的 2 次 tick——有文档说明且有充分理由
```

**使用要求：**
1. 首先等待触发条件
2. 基于已知时序（而非猜测）
3. 注释说明原因

## 实际效果

来自调试实践（2025-10-03）：
- 修复了 3 个文件中的 15 个不稳定测试
- 通过率：60% → 100%
- 执行时间：快了 40%
- 再无竞态条件
