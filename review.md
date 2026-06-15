# PR #691 深度 Review

- PR：<https://github.com/MoonshotAI/kimi-code/pull/691>
- 本地分支：`auto-update`
- 对比范围：`origin/main...HEAD`
- 变更规模：16 files，`+1267 / -29`
- 主要模块：`apps/kimi-code/src/cli/update/*`、`apps/kimi-code/src/cli/sub/upgrade.ts`、相关测试与数据路径文档
- CI：GitHub checks 全绿（build / lint / typecheck / test / nix 等均 pass）
- 本地验证：已跑目标测试通过

```sh
pnpm --filter @moonshot-ai/kimi-code exec vitest run \
  test/cli/update/rollout.test.ts \
  test/cli/update/cdn.test.ts \
  test/cli/update/cache.test.ts \
  test/cli/update/refresh.test.ts \
  test/cli/upgrade.test.ts \
  test/cli/update/preflight.test.ts
```

结果：6 个测试文件、108 个测试全部通过。

## 总体判断

核心设计整体是成立的：

- `latest.json` 解析失败时会 fallback 到明文 `/latest`，保留旧行为。
- passive update 路径通过 `sha256(deviceId:version) % 100` 做稳定分桶，并随版本重新洗牌。
- 24h 硬上限和 uncovered bucket fallback 已实现。
- `kimi upgrade` 没有被 rollout gate，仍直接安装 `cache.latest`。
- 测试覆盖了主要边界：bucket boundary、24h clamp、malformed manifest fallback、held/eligible 状态、experimental bypass、manual upgrade 不被 gate。

但这次 review 仍发现 4 个建议合并前处理的重要问题，以及若干测试/文档/可观测性缺口。没有观察到会立即破坏更新链路的 critical blocker，但下面第 1、2、3、4 条会影响首次启动归因、rollout 数据可信度、更新可靠性和 fallback 语义。

---

## 重要问题

### 1. 首次正常启动时，update preflight 会抢先创建 `device_id`，导致后续 telemetry 丢失 `first_launch`（本轮已修复）

位置：

- `apps/kimi-code/src/main.ts:53-66`
- `apps/kimi-code/src/cli/update/rollout.ts:188-190`
- `apps/kimi-code/src/cli/update/preflight.ts:654`
- `packages/oauth/src/identity.ts:35-62`
- `apps/kimi-code/src/cli/telemetry.ts:22-47`
- `apps/kimi-code/src/cli/run-shell.ts:53-111`
- `apps/kimi-code/src/cli/run-prompt.ts:67-86`

`handleMainCommand()` 先调用 `runUpdatePreflight()`，然后才进入 `runShell()` / `runPrompt()`：

```ts
const preflightResult = await runUpdatePreflight(version, ...);
...
if (validated.uiMode === 'print') {
  await runPrompt(validated.options, version);
  return;
}
await runShell(validated.options, version);
```

`runUpdatePreflight()` 现在会调用：

```ts
const deviceId = resolveUpdateDeviceId();
```

而 `resolveUpdateDeviceId()` 直接调用：

```ts
createKimiDeviceId(resolveKimiHome());
```

这个调用没有传 `onFirstLaunch` callback。`createKimiDeviceId()` 在 `device_id` 不存在时会同步创建文件：

```ts
const deviceIdPath = join(homeDir, 'device_id');
...
writeFileSync(deviceIdPath, id, { encoding: 'utf-8', mode: 0o600 });
```

问题是：normal launch 的 telemetry bootstrap 是在 preflight 之后才发生。`runShell()` / `runPrompt()` 之后会调用 `createCliTelemetryBootstrap()`，它会再次调用 `createKimiDeviceId(homeDir, { onFirstLaunch: ... })`，并依赖 callback 设置 `firstLaunch`：

```ts
let firstLaunch = false;
const deviceId = createKimiDeviceId(homeDir, {
  onFirstLaunch: () => {
    firstLaunch = true;
  },
});
...
if (options.bootstrap.firstLaunch) {
  options.harness.track('first_launch');
}
```

由于 preflight 已经把 `~/.kimi-code/device_id` 写好了，telemetry bootstrap 看到的是一个已存在 id，`onFirstLaunch` 不会触发，`firstLaunch` 恒为 `false`，最终不上报 `first_launch`。

后果：

- 首次正常启动且 auto-update 开启的默认用户会丢失 first-launch attribution。
- 这个丢失发生在用户做任何会真正初始化 telemetry 的事情之前，仅仅因为 passive rollout check 需要 bucket。
- `KIMI_CODE_NO_AUTO_UPDATE` 用户不会触发该路径，因为 `runUpdatePreflight()` 在 `resolveUpdateDeviceId()` 前已经 early return。

建议修复：

不要让 rollout check 抢先创建 telemetry identity 的 `device_id`。可以考虑：

- 给 `createKimiDeviceId()` 增加“只读已有 id，不创建”的能力，rollout preflight 只读取已有 id；没有 id 时暂不创建，由 telemetry bootstrap 统一创建并触发 `first_launch`。
- 或者新增 update-only 的 rollout id 文件，独立于 telemetry `device_id`，避免副作用泄漏到 first-launch attribution。
- 至少应在 update preflight 中避免创建 `device_id`；rollout bucket 需要稳定 id，但不应以污染 telemetry first-launch 语义为代价。

建议补测试：

- 使用临时 `KIMI_CODE_HOME`，mock 真实 update preflight 的 rollout 路径而非 telemetry bootstrap。
- 断言首次 normal launch 后 `initializeCliTelemetry()` 仍能收到 `bootstrap.firstLaunch === true` 并 track `first_launch`。
- 断言 update preflight 不提前创建 telemetry 的 `device_id`，或创建时仍能保留 telemetry 的 first-launch callback 语义。

本轮修复方式：新增 `readKimiDeviceId()` 只读接口，并让 `resolveUpdateDeviceId()` 在缺少 telemetry `device_id` 时改用进程内 ephemeral id，避免 update preflight 提前创建 `~/.kimi-code/device_id`。

---

### 2. `prompt-refresh` 决策用了刷新后的 manifest，但 telemetry 仍用旧 cache manifest（本轮已修复）

位置：

- `apps/kimi-code/src/cli/update/preflight.ts:286-295`
- `apps/kimi-code/src/cli/update/preflight.ts:720-749`

`refreshUserVisibleUpdateTarget()` 内部已经用 `refreshed.manifest` 做 rollout 决策，并正确写入 `phase: 'prompt-refresh'` 的 rollout log：

```ts
const decision = decidePassiveUpdateTarget(
  currentVersion,
  refreshed.latest,
  refreshed.manifest,
  deviceId,
  new Date(),
  bypassRollout,
);
logRolloutDecision('prompt-refresh', currentVersion, refreshed.latest, refreshed.manifest, decision);
return decision.target;
```

但它只返回 `target`。回到 `runUpdatePreflight()` 后，实际用于 `update_background_install_started` / `update_prompted` telemetry 的 rollout 元数据仍然来自 `cachedManifest`：

```ts
const userVisibleRollout = rolloutTelemetryFor(
  deviceId,
  userVisibleTarget.version,
  cachedManifest,
  bypassRollout,
);
```

后果：

- 如果启动时 cache 是旧版本 manifest，refresh 后拿到新版本 manifest， telemetry 会把新版本的安装/提示错误归属到旧 manifest。
- `rollout.log` 与 telemetry 会出现不一致：log 记录的是刷新后的真实决策，telemetry 却上报旧 cache 的 rollout 信息。
- 这个 PR 的主要目标之一是“观察 ramp / 限制爆炸半径”，所以 rollout telemetry 的准确性属于核心能力，不是普通指标问题。

建议修复：

让 `refreshUserVisibleUpdateTarget()` 返回产生该 target 的上下文，例如：

```ts
type UserVisibleUpdateTarget = {
  readonly target: UpdateTarget | null;
  readonly manifest: UpdateManifest | null;
};
```

成功 refresh 时用 `refreshed.manifest` 计算 telemetry；timeout / fetch 失败 fallback 时继续使用 `cachedManifest`。

建议补测试：

- cache 中是旧 manifest，refresh 后是新 manifest。
- 两个 manifest 的 rollout delay 不同，但 refresh 后的 target 最终 eligible。
- 断言 `update_prompted` 或 `update_background_install_started` 中的 `rollout_delay_seconds` / `rollout_from_manifest` 来自 refreshed manifest，而不是 cache manifest。

本轮修复方式：`refreshUserVisibleUpdateTarget()` 现在返回 `{ target, manifest }`。刷新成功时使用 `refreshed.manifest` 计算后续 rollout telemetry；刷新超时或失败时回退到传入的 `cachedManifest`，避免 prompt / background install telemetry 与真实决策来源不一致。

---

### 3. 新增 `/latest.json` 请求没有超时，可能阻塞 fallback 和 `kimi upgrade`

位置：

- `apps/kimi-code/src/cli/update/cdn.ts:58-82`
- `apps/kimi-code/src/cli/sub/upgrade.ts:57-60`

当前逻辑先请求 `/latest.json`，只有它失败后才会 fallback 到 `/latest`：

```ts
const manifest = await fetchUpdateManifestFromCdn(fetchImpl).catch(() => null);
if (manifest !== null) {
  return { latest: manifest.version, manifest };
}
const latest = await fetchLatestVersionFromCdn(fetchImpl);
return { latest, manifest: null };
```

但 `fetchUpdateManifestFromCdn()` 没有 `AbortController` / timeout：

```ts
const response = await fetchImpl(KIMI_CODE_CDN_LATEST_JSON_URL);
```

影响：

- 如果 `/latest.json` hang 或极慢，passive update 中有用户可见 prompt 的路径还能靠 `refreshUserVisibleUpdateTarget()` 的 1 秒 `Promise.race()` 兜底旧 cache；但首次启动、无 cache、非交互刷新和 `kimi upgrade` 都会被拖住。
- `kimi upgrade` 没有外层 timeout，会一直等待 `refreshUpdateCache()`。
- 这次 PR 把更新检查从单个 `/latest` 改成“先 `/latest.json`、再 `/latest`”，实际新增了一个可能阻塞旧 fallback 的前置请求。

建议修复：

- 给 `/latest.json` 加短超时；超时按 manifest unavailable 处理，继续 fallback `/latest`。
- 也可以给 `/latest` 加同样短超时，避免 fallback 自身 hang。
- `kimi upgrade` 的 refresh 最好也有明确超时，失败时进入现有的 refresh failure 分支，而不是无限等待。

建议补测试：

- `cdn.test.ts`：`/latest.json` mock 成永不 resolve，`/latest` 可返回，验证 fallback 能在超时内发生。
- `upgrade.test.ts`：refresh 超时/失败时返回非 0，且不调用 install。

---

### 4. cache 中 `manifest` 字段损坏会丢弃整个 update cache，包括原本可用的 `latest`

位置：

- `apps/kimi-code/src/cli/update/cache.ts:11-27`
- `apps/kimi-code/test/cli/update/cache.test.ts:110-124`

当前 schema 把 `manifest` 和 cache 顶层绑定校验：

```ts
const UpdateCacheSchema = z
  .object({
    source: z.literal('cdn'),
    checkedAt: z.string().min(1).nullable(),
    latest: z.string().min(1).nullable(),
    manifest: UpdateManifestSchema.nullable().default(null),
  })
  .strict();
```

如果 cache 文件里 `latest` 有效，但 `manifest` 局部损坏，`readJsonFile()` parse 失败，`readUpdateCache()` 的 catch 会返回 `emptyUpdateCache()`。当前测试也明确编写了这个行为：

```ts
await expect(readUpdateCache()).resolves.toEqual(emptyUpdateCache());
```

这和 PR 的 fallback 设计不太一致。`latest.json` CDN 损坏时会忽略 manifest、fallback 到 `/latest`；本地 cache 也应该可以只忽略坏 manifest，保留旧 `latest` 作为明文结果。

影响：

- 本地 cache 的局部损坏会让 passive update 失去原本可用的 latest。
- 如果此时 CDN 也不可用，旧行为下仍可能提示更新，新实现会变成“什么都没有”。
- 未来给 manifest 加字段时，也更容易把旧 cache 整体重置。

建议修复：

把 `manifest` 的解析从 cache 顶层硬校验中拆出来，例如：

```ts
manifest: z.preprocess(
  (value) => (value === undefined ? null : value),
  UpdateManifestSchema.nullable().catch(null),
),
```

并更新测试：malformed manifest 应返回：

```ts
{
  source: 'cdn',
  checkedAt: '...',
  latest: '0.5.0',
  manifest: null,
}
```

而不是 `emptyUpdateCache()`。

---

## 次要问题 / 测试缺口

### 5. cache 顶层继续使用 `.strict()`，前向兼容性较弱

位置：`apps/kimi-code/src/cli/update/cache.ts:11-18`

`UpdateManifestSchema` 刻意没有 `.strict()`，以允许未来字段；但 cache 顶层仍 `.strict()`。如果未来 cache 添加顶层字段，当前客户端会整个 cache parse 失败并回到 empty cache。

这不一定是当前 PR 的 blocker，cache 也可自动刷新；但这和“未来字段不应破坏既有更新路径”的目标不完全一致。

建议：

- cache 顶层改成普通 object 或 strip unknown fields，只消费当前字段。
- 增加测试：未来 cache 多一个顶层 unknown field 时，应仍保留 `latest` 与合法 `manifest`。

---

### 6. `publishedAt` 只校验 `Date.parse()`，允许无时区时间

位置：

- `apps/kimi-code/src/cli/update/cdn.ts:21-23`
- `apps/kimi-code/test/cli/update/cdn.test.ts:41-50`

当前 schema：

```ts
.refine((value) => Number.isFinite(Date.parse(value)), { error: 'invalid timestamp' })
```

测试都使用 UTC ISO 字符串，例如 `2026-06-12T00:00:00.000Z`。但代码也接受 `2026-06-12T00:00:00`，这种字符串在 JS 中通常按客户端本地时区解析，不同地区的设备会在不同绝对时间 eligible。

建议：

- CDN manifest 规范要求显式 timezone，例如 `Z` 或 `+08:00`。
- schema 拒绝缺少 timezone 的 `publishedAt`，让客户端 fallback 到 `/latest`。
- 增加 `publishedAt: '2026-06-12T00:00:00'` fallback 测试。

---

### 7. experimental bypass 的 rollout log 丢失了 bucket / delay 信息

位置：

- `apps/kimi-code/src/cli/update/rollout.ts:101-115`
- `apps/kimi-code/src/cli/update/preflight.ts:197-210`
- `apps/kimi-code/src/cli/update/preflight.ts:223-235`

当前 `decidePassiveUpdateTarget()` 在 `bypassRollout = true` 时直接返回：

```ts
{
  target,
  reason: target === null ? 'not-newer' : 'experimental',
  bucket: null,
  delaySeconds: null,
  eligibleAt: null,
}
```

这符合“experimental 不参与 gate”的产品语义，但排查 rollout 时会少掉“这个设备原本在哪个 bucket、本来应被延迟多久”的信息。更有趣的是，`rolloutTelemetryFor()` 仍会计算 bucket，只是 delay 被置 0；所以 background install telemetry 和 `rollout.log` 会出现信息不一致。

建议：

- bypass 时仍可计算并记录原始 bucket / delay / eligibleAt。
- `reason` 继续标记为 `experimental`，这样既能看出 bypass，也能看出原始 rollout 位置。
- 更新 `rollout.test.ts` 中 experimental bypass 断言。

---

### 8. 非交互 background refresh 不写 `rollout.log`，但文档暗示每次更新检查都会记录

位置：

- `apps/kimi-code/src/cli/update/preflight.ts:248-260`
- `docs/en/configuration/data-locations.md:97`
- `docs/zh/configuration/data-locations.md:97`

`refreshAndMaybeInstallInBackground()` 中：

```ts
const refreshed = await refreshUpdateCache();
if (!isInteractive) return;
const decision = decidePassiveUpdateTarget(...);
logRolloutDecision('background-refresh', ...);
```

也就是说非交互启动时，startup-cache 可能写一条 log，但 background refresh 结果不会写。

文档却说：

> `rollout.log` records which staged-rollout case each update check hit

以及中文：

> `rollout.log` 记录每次更新检查命中的灰度分批情况

这会让排查 “为什么非交互启动后状态翻转/没翻转” 时少一条记录。

建议二选一：

1. 如果文档是目标行为：把 decision 和 log 移到 `if (!isInteractive) return;` 前面，只在非交互时跳过 install/source detection。
2. 如果当前行为有意为之：把文档改成“主要 passive 用户可见检查会写入 rollout.log”，避免误导。

---

### 9. `decidePassiveUpdateTarget()` bypass 分支只信任 `latest`，忽略 `manifest.version`

位置：`apps/kimi-code/src/cli/update/rollout.ts:101-115`

正常情况下，manifest 分支使用：

```ts
const target = selectUpdateTarget(currentVersion, manifest.version);
```

但 bypass 分支先检查 `latest === null`，然后只用 `latest`：

```ts
if (latest === null) {
  return { target: null, reason: 'no-latest', ... };
}
const target = selectUpdateTarget(currentVersion, latest);
```

生产路径中 `fetchLatestFromCdn()` 会让 `latest === manifest.version`，所以这不是 high severity。但这个函数的语义“manifest 优先于 latest”在 bypass 分支里不一致。如果 cache 被手动写入 `latest: null` + 有效 manifest，bypass 路径会错误返回 `no-latest`。

建议：

```ts
const effectiveLatest = latest ?? manifest?.version ?? null;
```

然后 bypass 和非 bypass 都基于 `effectiveLatest` 做 select。

---

### 10. 这个 PR 似乎缺少 changeset

位置：本次 diff 没有 `.changeset/*` 新增/修改。

按仓库工作流，用户可见行为变化需要在 PR 前生成 changeset。这个 PR 改变了 auto-update 的 CDN 源、passive 更新可见性、rollout log、本地 cache 结构和数据目录文档，属于用户/运维可感知变化。

建议：

- 至少补一个 `@moonshot-ai/kimi-code` 的 patch 或 minor changeset。
- 如果认为 rollout 能力值得在 release notes 中体现，倾向 `minor`；如果只是内部可靠性调整，可 `patch`。
- 不要自行写 `major`，除非维护者明确确认这是 breaking change。

---

## 已确认没有问题的核心点

### `kimi upgrade` 不被 rollout gate

`apps/kimi-code/src/cli/sub/upgrade.ts:75` 直接使用：

```ts
const target = selectUpdateTarget(currentVersion, cache.latest);
```

它完全忽略 `cache.manifest`，因此即使 manifest 显示当前 batch held，manual upgrade 仍会安装最新版。这一点符合 PR 目标，并且 `test/cli/upgrade.test.ts:217` 已覆盖。

### fallback 到 `/latest` 时保持旧行为

`fetchLatestFromCdn()` 在 `/latest.json` 缺失、 malformed、network error、schema invalid 时都会 fallback 到 plaintext `/latest`。`manifest: null` 在 passive decision 中表示“立即可见”，和旧行为一致。

### 24h 硬上限实现正确

`rolloutDelayForBucket()` 对单个 delay 做了 clamp：

```ts
Math.min(Math.max(batch.delaySeconds, 0), MAX_ROLLOUT_DELAY_SECONDS)
```

同时未覆盖 bucket 会 fallback 到 `MAX_ROLLOUT_DELAY_SECONDS`。测试覆盖了 `{ percent: 100, delaySeconds: 999_999 }` 在 24h 后 eligible。

### 分桶哈希稳定且跨版本重新洗牌

`rolloutBucket()` 使用：

```ts
sha256(`${deviceId}:${version}`) 的前 4 字节 % 100
```

测试中有 pinned vectors，也验证了不同 version 会 reshuffle。这里均匀性有理论上的极微小偏差，因为 `2^32` 不能被 100 整除，但实际可忽略。

---

## 建议优先修复顺序

1. **避免 update preflight 抢先创建 telemetry `device_id`，恢复 `first_launch` attribution（本轮已修复）。**
2. **修复 prompt-refresh telemetry 使用 stale manifest（本轮已修复）。**
3. **给 `/latest.json` / fallback 请求加超时。**
4. **让 cache 在 manifest 损坏时只降级 manifest，不丢失 latest。**
5. 补齐 changeset。
6. 处理文档与非交互 background refresh log 的不一致。
7. 收紧 `publishedAt` timezone 校验、改善 experimental bypass 日志信息。

---

## 可直接增加的测试用例

### `main.test.ts` / `telemetry.test.ts`

- 首次 normal launch 时，update preflight 不应抢先创建 telemetry `device_id`。
- `runShell()` / `runPrompt()` 后续 bootstrap telemetry 时仍应触发 `first_launch`。

### `preflight.test.ts`

- cache manifest 与 refreshed manifest 不一致时，`update_prompted` / `update_background_install_started` 的 rollout telemetry 必须来自 refreshed manifest。
- refresh 后 manifest held 时，不应对用户显示旧 cache target；现有测试已覆盖“stay silent”，但可以同时断言没有 `update_prompted` telemetry。
- 非交互 background refresh 是否写入 `rollout.log`，应与最终文档承诺一致。

### `cdn.test.ts`

- `/latest.json` hang，plaintext `/latest` 成功，验证 timeout fallback。
- `publishedAt` 缺少 timezone 时 fallback 到 `/latest`。

### `cache.test.ts`

- `latest` 有效但 `manifest` malformed 时，应保留 `latest` 并将 `manifest` 视为 `null`。
- 未来顶层 unknown field 不应导致整个 cache reset。

### `rollout.test.ts`

- experimental bypass 是否应该保留原始 bucket/delay/eligibleAt 信息；如果保留，更新断言。

---

## 结论

这个 PR 的主要行为实现得比较扎实，关键语义已经被测试覆盖：fallback、passive gate、24h ceiling、manual upgrade bypass gate 都基本正确。

第一条 `first_launch` 丢失问题和第二条 prompt-refresh telemetry stale manifest 问题已在本次修复。合并前仍建议至少处理：

- `/latest.json` 无超时导致 fallback/`upgrade` 阻塞的问题；
- cache 中坏 manifest 丢弃整个 latest 的问题。

其余主要是可观测性、前向兼容、文档一致性和 release workflow 补全。
