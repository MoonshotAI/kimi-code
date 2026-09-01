# 04 · BaselineManager 逐方法详解：864 行里的"后悔药"仓库

> 时效基线：基于 commit `68ddf583b`（2026-08-25 提交；行号 2026-08-29 对照源码复核）。行号会随代码演进漂移，**本篇每处 `文件:行号` 引用都附带源码原文**——日后行号对不上时，按代码文本搜索即可重新定位。
> 实测基线：`pnpm -C apps/vscode exec vitest run test/baseline.manager.test.ts` → **30 个测试全部通过**（2026-08-29）。

## 全局认知

- **定位**：`apps/vscode/src/managers/baseline.manager.ts`，864 行（四个类里最大）。职责一句话：**在工具改文件之前抢先读取原内容、保存成基线快照，之后随时能算 diff、看原文、整体回滚**——[01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第八节把这叫 Write/Edit 的"后悔药"。它不监听文件、不碰 UI——那些是 FileManager 和 handler 的事（第八节的三个角色分工：BaselineManager 存快照、FileManager 跟踪文件＋监听磁盘、file.handler.ts 的文件类 RPC 是 UI 入口）。

- **构成**：1 个错误类＋2 个字段＋9 个公开方法＋16 个私有方法＋24 个文件级函数。公开面很窄（9 个方法全是动词级 API），具体活全在私有方法和文件级函数里。

- **设计主线一：内容寻址存储。** 快照文件名＝内容的 sha256（`hash(content)`），同内容全局只存一份，读回时自校验，清理时"清单没提到的就能删"（术语表有条目）。

- **设计主线二：同步抢读、异步落盘。** `capture` 的 JSDoc（`baseline.manager.ts:79-83`）是全类的时序合同：**任何 `await` 发生之前，原文件已被同步 IO 读完**——抢在工具写入前；之后的写快照、更新清单全部排队异步完成。

- **设计主线三：每会话串行队列。** 所有写操作经 `serialize` 按 session id 排队（读操作 `waitForUpdates` 等队尾），磁盘上的清单永远不会被两个并发写撕开（术语表有条目）。

- **兼容包袱**：`acceptedLegacyPaths` 与四个 legacy 私有方法服务"从旧 kimi-cli 迁移来的会话"——它们的基线存在旧安装目录（metadata 里的 `kimi_cli_source_path`），本类读得到、搬得走。

## 总地图

**磁盘布局**（由构造器与四个路径私有方法拼出）：

```
<globalStorageRoot>/baselines/<sha256(homeNamespace)>/     ← baselinesRoot（baseline.manager.ts:76）
  <sha256(sessionId)>/                                      ← sessionRoot（baseline.manager.ts:520）
    manifest.json                                           ← manifestPath（baseline.manager.ts:524）
    snapshots/                                              ← snapshotsRoot（baseline.manager.ts:528）
      <sha256(内容)>                                        ← snapshotPath（baseline.manager.ts:532）
```

manifest.json 的形状（`BaselineManifestV1`，`baseline.manager.ts:34-39`）：`{ version: 1, sessionId, entries: { 相对路径 → { snapshot, existedBefore } }, acceptedLegacyPaths: [...] }`。`existedBefore` 记"保存快照时这个文件本来存不存在"——三态判定和回滚方式全靠它。

**2 个字段**：

| 字段 | 行号 | 声明/出生（源码原文） |
|---|---|---|
| `baselinesRoot` | `baseline.manager.ts:66` | `private readonly baselinesRoot: string;`，出生在 `baseline.manager.ts:76`：`this.baselinesRoot = path.join(globalStorageRoot, 'baselines', hash(homeNamespace));` |
| `updates` | `baseline.manager.ts:67` | `private readonly updates = new Map<string, Promise<void>>();`——串行队列的本体：每个会话当前"最后一次写"的 Promise |

**9 个公开方法**（"签名"列＝源码原文第一行；"主要调用方"grep 实数）：

| 方法 | 行号 | 签名（源码原文） | 作用 | 主要调用方（源码原文） |
|---|---|---|---|---|
| `capture` | `baseline.manager.ts:84-116` | `async capture(session: BaselineSession, filePath: string): Promise<void> {` | 保存快照（同步读＋异步存） | bridge-handler.ts:277（唯一）：`const capture = this.baselineManager.capture(session, resolved.uri.fsPath);`（链路见 [02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第九节） |
| `getChanges` | `baseline.manager.ts:118-164` | `async getChanges(session: BaselineSession): Promise<FileChange[]> {` | 算 File Changes 列表（三态） | file.manager.ts:147：`const changes = await this.baselineManager.getChanges(state.session);`；file.handler.ts:104：`const changes = await ctx.baselineManager.getChanges(session);`；session.handler.ts:154：`const changes = await ctx.baselineManager.getChanges(baseline);` |
| `getContent` | `baseline.manager.ts:166-177` | `async getContent(session: BaselineSession, filePath: string): Promise<string> {` | 取某文件基线原文 | bridge-handler.ts:301（唯一）：`return this.baselineManager.getContent(baselineSummary(summary), filePath);` |
| `undo` | `baseline.manager.ts:179-191` | `async undo(session: BaselineSession, filePath: string): Promise<void> {` | 回滚单个文件 | file.handler.ts:120：`await ctx.baselineManager.undo(session, resolved.relativePath);` |
| `undoAll` | `baseline.manager.ts:193-207` | `async undoAll(session: BaselineSession): Promise<void> {` | 回滚全部 | file.handler.ts:122：`await ctx.baselineManager.undoAll(session);` |
| `keep` | `baseline.manager.ts:209-233` | `async keep(session: BaselineSession, filePath: string): Promise<void> {` | 接受单文件改动（不再跟踪） | file.handler.ts:134：`await ctx.baselineManager.keep(session, resolved.relativePath);` |
| `keepAll` | `baseline.manager.ts:235-249` | `async keepAll(session: BaselineSession): Promise<void> {` | 接受全部 | file.handler.ts:137：`await ctx.baselineManager.keepAll(session);` |
| `materializeToFork` | `baseline.manager.ts:251-286` | `async materializeToFork(source: BaselineSession, target: BaselineSession): Promise<void> {` | 把源会话基线复制给 fork | session.handler.ts:219-222：`await ctx.baselineManager.materializeToFork(baselineSession(sourceSummary), baselineSession(targetSummary));` |
| `deleteSession` | `baseline.manager.ts:288-293` | `async deleteSession(sessionId: string): Promise<void> {` | 删某会话的全部基线数据 | session.handler.ts:186：`await ctx.baselineManager.deleteSession(params.sessionId);`、session.handler.ts:236：`await ctx.baselineManager.deleteSession(targetSummary.id).catch(...)`（删会话/fork 失败清理） |

**16 个私有方法**（"签名"列＝源码原文第一行，正文逐个展开）：

| 分组 | 方法 | 行号 | 签名（源码原文） |
|---|---|---|---|
| 有效路径与读值 | `effectivePaths` | `baseline.manager.ts:295-313` | `private async effectivePaths(session: BaselineSession, manifest: BaselineManifestV1): Promise<string[]> {` |
| | `readEffectiveBaseline` | `baseline.manager.ts:315-331` | `private async readEffectiveBaseline(session: BaselineSession, relativePath: string, manifest: BaselineManifestV1): Promise<BaselineValue \| undefined> {` |
| 清单 | `readManifest` | `baseline.manager.ts:333-354` | `private async readManifest(session: BaselineSession): Promise<BaselineManifestV1> {` |
| | `writeManifest` | `baseline.manager.ts:356-367` | `private async writeManifest(manifest: BaselineManifestV1): Promise<void> {` |
| 快照 | `writeSnapshot` | `baseline.manager.ts:369-389` | `private async writeSnapshot(sessionId: string, snapshot: string, content: string): Promise<void> {` |
| | `readSnapshot` | `baseline.manager.ts:391-411` | `private async readSnapshot(sessionId: string, snapshot: string, relativePath: string): Promise<string> {` |
| | `removeUnreferencedSnapshots` | `baseline.manager.ts:413-435` | `private async removeUnreferencedSnapshots(sessionId: string, manifest: BaselineManifestV1): Promise<void> {` |
| 遗留基线 | `listLegacyPaths` | `baseline.manager.ts:437-444` | `private async listLegacyPaths(session: BaselineSession): Promise<string[]> {` |
| | `hasLegacyBaseline` | `baseline.manager.ts:446-465` | `private async hasLegacyBaseline(session: BaselineSession, relativePath: string): Promise<boolean> {` |
| | `readLegacyBaseline` | `baseline.manager.ts:467-495` | `private async readLegacyBaseline(session: BaselineSession, relativePath: string): Promise<BaselineValue \| undefined> {` |
| 并发 | `serialize` | `baseline.manager.ts:497-514` | `private async serialize<T>(sessionIds: readonly string[], operation: () => Promise<T>): Promise<T> {` |
| | `waitForUpdates` | `baseline.manager.ts:516-518` | `private async waitForUpdates(sessionIds: readonly string[]): Promise<void> {` |
| 路径 | `sessionRoot` | `baseline.manager.ts:520-522` | `private sessionRoot(sessionId: string): string {` |
| | `manifestPath` | `baseline.manager.ts:524-526` | `private manifestPath(sessionId: string): string {` |
| | `snapshotsRoot` | `baseline.manager.ts:528-530` | `private snapshotsRoot(sessionId: string): string {` |
| | `snapshotPath` | `baseline.manager.ts:532-537` | `private snapshotPath(sessionId: string, snapshot: string): string {` |

**24 个文件级函数**（＋`BaselineError` 类 `baseline.manager.ts:58-63`：`export class BaselineError extends Error {`）：

| 分组 | 函数 | 行号 | 签名（源码原文） |
|---|---|---|---|
| 清单 | `emptyManifest` | `baseline.manager.ts:540-542` | `function emptyManifest(sessionId: string): BaselineManifestV1 {` |
| | `mutableManifest` | `baseline.manager.ts:544-551` | `function mutableManifest(manifest: BaselineManifestV1): MutableManifest {` |
| | `parseManifest` | `baseline.manager.ts:553-610` | `function parseManifest(value: unknown, session: BaselineSession): BaselineManifestV1 {` |
| 路径比较 | `equivalentPath` | `baseline.manager.ts:612-622` | `function equivalentPath(session: BaselineSession, paths: Iterable<string>, candidate: string): string \| undefined {` |
| | `uniquePaths` | `baseline.manager.ts:624-631` | `function uniquePaths(session: BaselineSession, paths: Iterable<string>): string[] {` |
| | `pathComparisonKey` | `baseline.manager.ts:633-635` | `function pathComparisonKey(session: BaselineSession, relativePath: string): string {` |
| | `resolveSessionFile` | `baseline.manager.ts:637-664` | `function resolveSessionFile(session: BaselineSession, filePath: string): ResolvedFile {` |
| | `isWindowsAbsolute` | `baseline.manager.ts:666-668` | `function isWindowsAbsolute(value: string): boolean {` |
| 遗留 | `legacyBaselineRoot` | `baseline.manager.ts:670-678` | `function legacyBaselineRoot(session: BaselineSession): string \| undefined {` |
| | `legacyBaselinePath` | `baseline.manager.ts:680-688` | `function legacyBaselinePath(session: BaselineSession, relativePath: string): string \| undefined {` |
| | `walkLegacyBaselines` | `baseline.manager.ts:690-715` | `async function walkLegacyBaselines(directory: string, relativeDirectory: string, result: string[]): Promise<void> {` |
| 文件 IO | `captureOriginal` | `baseline.manager.ts:717-738` | `function captureOriginal(absolutePath: string): BaselineValue {` |
| | `readCurrentFile` | `baseline.manager.ts:740-747` | `async function readCurrentFile(absolutePath: string): Promise<string \| undefined> {` |
| | `restoreFile` | `baseline.manager.ts:749-774` | `async function restoreFile(workDir: string, absolutePath: string, baseline: BaselineValue): Promise<void> {` |
| | `requireContainedRestorePath` | `baseline.manager.ts:776-789` | `async function requireContainedRestorePath(workDir: string, absolutePath: string): Promise<void> {` |
| | `realExistingPath` | `baseline.manager.ts:791-810` | `async function realExistingPath(candidate: string): Promise<string> {` |
| | `atomicWrite` | `baseline.manager.ts:812-822` | `async function atomicWrite(targetPath: string, content: string): Promise<void> {` |
| 校验 | `requireSession` | `baseline.manager.ts:824-827` | `function requireSession(session: BaselineSession): void {` |
| | `requireSessionId` | `baseline.manager.ts:829-831` | `function requireSessionId(sessionId: string): void {` |
| | `isRecord` | `baseline.manager.ts:837-839` | `function isRecord(value: unknown): value is Record<string, unknown> {` |
| | `isErrorCode` | `baseline.manager.ts:841-843` | `function isErrorCode(error: unknown, code: string): boolean {` |
| 杂项 | `hash` | `baseline.manager.ts:833-835` | `function hash(value: string): string {` |
| | `countLines` | `baseline.manager.ts:845-848` | `function countLines(content: string): number {` |
| | `computeLineDiff` | `baseline.manager.ts:850-864` | `function computeLineDiff(oldContent: string, newContent: string): { additions: number; deletions: number } {` |

## 一、constructor 与两道门槛

```ts
// baseline.manager.ts:69-77
constructor(globalStorageRoot: string, homeNamespace = 'default') {
  if (globalStorageRoot.length === 0) {
    throw new BaselineError('The VSCode global storage path is empty');
  }
  if (homeNamespace.length === 0) {
    throw new BaselineError('The Kimi home namespace is empty');
  }
  this.baselinesRoot = path.join(globalStorageRoot, 'baselines', hash(homeNamespace));
}
```

**实参谁递的**——BridgeHandler 的构造函数（全插件"谁 new 谁、把什么递给谁"集中定在这一处，[02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第一节）bridge-handler.ts:62：`this.baselineManager = new BaselineManager(globalStoragePath, this.runtime.harness.homeDir);`（该篇第一节有完整接线）。第二个参数用引擎的homeDir做**命名空间**（不同 home 的基线目录互相隔离、互不可见）：同名会话 id 在不同 home 下也不会撞目录（外面还套了一层 `hash(sessionId)`，目录名不泄漏会话 id 明文）。两个空串守卫拦的是"上游给了个没初始化的路径"——这时候宁可构造失败也不把数据写进奇怪的地方。

## 二、capture：同步抢读，异步落盘

```ts
// baseline.manager.ts:84-116
async capture(session: BaselineSession, filePath: string): Promise<void> {
  const resolved = resolveSessionFile(session, filePath);       // :85 路径归一＋越界检查
  const captured = captureOriginal(resolved.absolutePath);      // :86 ★同步读，见下

  await this.serialize([session.id], async () => {              // :88 进会话串行队列
    const manifest = await this.readManifest(session);
    const localPath = equivalentPath(session, Object.keys(manifest.entries), resolved.relativePath);
    if (localPath !== undefined) return;                         // :95 跳过①：已有本版基线

    const accepted = new Set(manifest.acceptedLegacyPaths);
    const acceptedPath = equivalentPath(session, accepted, resolved.relativePath);
    if (acceptedPath === undefined) {
      const legacyExists = await this.hasLegacyBaseline(session, resolved.relativePath);
      if (legacyExists) return;                                  // :101 跳过②：用户已接受过遗留基线
    }

    const snapshot = hash(captured.content);                     // :104 内容寻址
    await this.writeSnapshot(session.id, snapshot, captured.content);
    if (acceptedPath !== undefined) accepted.delete(acceptedPath); // :106 改过的文件重新跟踪

    const next = mutableManifest(manifest);
    next.entries[resolved.relativePath] = { snapshot, existedBefore: captured.existedBefore };
    next.acceptedLegacyPaths = uniquePaths(session, accepted);
    await this.writeManifest(next);
  });
}
```

**前两行在 `await` 之前**——这是全类最重要的时序：`captureOriginal`（`baseline.manager.ts:717-738`）用 `statSync`＋`readFileSync` 同步把原文件读进内存。调用链上，SessionRuntime 在引擎发 `tool.call.started` 的瞬间调它（session-runtime.ts:504：`this.captureBaseline(`，完整调用块在 [02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第九节），同步返回；等工具真正写文件时，原内容早就在内存里了。反例：若第一行就用异步 `readFile`，`await` 会让出事件循环，引擎的工具写入可能插进来先落盘——拍到的是改完后的内容，基线失真。文件不存在（Write 要新建的文件）返回 `{ content: '', existedBefore: false }`，同样是一次同步判定：

```ts
// baseline.manager.ts:717-738（节选）
function captureOriginal(absolutePath: string): BaselineValue {
  let info;
  try {
    info = statSync(absolutePath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { content: '', existedBefore: false };
    ...
  }
  ...
  return { content: readFileSync(absolutePath, 'utf-8'), existedBefore: true };
}
```

`serialize` 之后是三重跳过逻辑，目的都是**一个文件在一个会话里只有第一份基线**：①清单 entries 里已有等价路径（Windows 大小写不敏感意义上的等价，见第十一节）→ 直接返回，保住"最早的那份"；②用户对这个文件点过 Keep（进了 acceptedLegacyPaths）或旧版留过遗留基线 → 返回，尊重"我不要跟踪它"的决定。`baseline.manager.ts:106` 的 `accepted.delete` 处理"接受后又改了"：重新保存快照、从接受名单里移除——文件重新进入跟踪。

## 三、getChanges：三态判定

```ts
// baseline.manager.ts:118-164（节选）
async getChanges(session: BaselineSession): Promise<FileChange[]> {
  await this.waitForUpdates([session.id]);                       // :119 等在途写完
  const manifest = await this.readManifest(session);
  const relativePaths = await this.effectivePaths(session, manifest);  // 本版＋未接受的遗留
  const changes: FileChange[] = [];

  for (const relativePath of relativePaths) {
    const baseline = await this.readEffectiveBaseline(session, relativePath, manifest);
    if (baseline === undefined) continue;                         // 已接受的遗留：不跟踪

    const resolved = resolveSessionFile(session, relativePath);
    const currentContent = await readCurrentFile(resolved.absolutePath);
    if (currentContent === undefined) {                           // 现在没了
      if (baseline.existedBefore) {
        changes.push({ path: relativePath, status: 'Deleted', additions: 0, deletions: countLines(baseline.content) });
      }
      continue;
    }
    if (!baseline.existedBefore) {                                // 原来没有、现在有
      changes.push({ path: relativePath, status: 'Added', additions: countLines(currentContent), deletions: 0 });
      continue;
    }
    if (currentContent !== baseline.content) {                    // 都有但不同
      const diff = computeLineDiff(baseline.content, currentContent);
      changes.push({ path: relativePath, status: 'Modified', additions: diff.additions, deletions: diff.deletions });
    }
  }
  return changes;
}
```

`existedBefore`（原来存不存在）× 当前文件存不存在，叉出三态：原来有现在没→**Deleted**（删了多少行＝基线行数）；原来没现在有→**Added**（加了多少行＝当前行数）；都有但内容不同→**Modified**；原来没现在也没→不算事。**调用方**（3 处，源码原文见总地图公开方法表）：file.manager.ts:147（watcher 每次磁盘变动都重算全表）、file.handler.ts:104（UI 主动拉）、session.handler.ts:154（恢复会话时重建面板）。

`computeLineDiff`（`baseline.manager.ts:850-864`）值得看清——它是**集合近似不是真 diff**：把新旧内容各拆成行集合，加数＝新行里旧集合没有的行数，删数反之。同一行出现在多处会被误判。它只服务面板上的 `+N −N` 数字；真 diff（逐行对齐）由 VS Code 原生 diff 视图算，那才是用户点开文件看到的。

`getContent`（`baseline.manager.ts:166-177`）短：waitForUpdates → readEffectiveBaseline → 没有就抛 `No baseline exists for "..." in session "..."`。**唯一调用方** bridge-handler.ts:301（diff 视图左栏——从活会话拿 summary 或从磁盘翻会话元信息，再取基线原文，见 [02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第十一节）。

## 四、undo / undoAll：把文件写回去

```ts
// baseline.manager.ts:179-191
async undo(session: BaselineSession, filePath: string): Promise<void> {
  const resolved = resolveSessionFile(session, filePath);
  await this.serialize([session.id], async () => {
    const manifest = await this.readManifest(session);
    const baseline = await this.readEffectiveBaseline(session, resolved.relativePath, manifest);
    if (baseline === undefined) { throw new BaselineError(`No baseline exists for ...`); }
    await restoreFile(session.workDir, resolved.absolutePath, baseline);
  });
}
```

`undoAll`（`baseline.manager.ts:193-207`）同构，只是对 `effectivePaths` 逐个 restore。落盘的活全在文件级函数 `restoreFile`：

```ts
// baseline.manager.ts:749-774（节选）
async function restoreFile(workDir: string, absolutePath: string, baseline: BaselineValue): Promise<void> {
  await requireContainedRestorePath(workDir, absolutePath);       // :754 写回前的越界闸
  if (!baseline.existedBefore) {
    try { await unlink(absolutePath); } catch (error) {           // 原来没有 → 删掉
      if (!isErrorCode(error, 'ENOENT')) { throw new BaselineError(`Unable to remove newly created file ...`); }
    }
    return;
  }
  try {
    await mkdir(path.dirname(absolutePath), { recursive: true }); // 中间目录可能被工具删了
    await writeFile(absolutePath, baseline.content, 'utf-8');     // 原来有 → 覆盖回基线
  } catch (error) { throw new BaselineError(`Unable to restore file ...`); }
}
```

回滚方向由 `existedBefore` 定：false→unlink（Add 的反操作），true→写回内容（Modify 的反操作）。`requireContainedRestorePath`（`baseline.manager.ts:776-789`）是**写回前的安全闸**：对 workDir 和目标各做 `realpath`（解析符号链接后的真实路径），确认目标真的在 workDir 里——防"基线路径经符号链接指到会话目录外"的写穿。它的搭档 `realExistingPath`（`baseline.manager.ts:791-810`）处理"目标还不存在"的情况：沿父目录向上爬到第一个存在的路径再 realpath，悬空符号链接（指着一个不存在文件的链接）则直接抛——**不能给一个链接当替身**。

## 五、keep / keepAll：接受改动

```ts
// baseline.manager.ts:209-233（节选）
async keep(session: BaselineSession, filePath: string): Promise<void> {
  const resolved = resolveSessionFile(session, filePath);
  await this.serialize([session.id], async () => {
    const manifest = await this.readManifest(session);
    const localPath = equivalentPath(session, Object.keys(manifest.entries), resolved.relativePath);
    const hadLocal = localPath !== undefined;
    const hasLegacy = await this.hasLegacyBaseline(session, resolved.relativePath);
    if (!hadLocal && !hasLegacy) return;                          // 两边都没有：没东西可接受

    const next = mutableManifest(manifest);
    if (localPath !== undefined) delete next.entries[localPath];  // 本版条目删除
    const accepted = new Set(next.acceptedLegacyPaths);
    const acceptedPath = equivalentPath(session, accepted, resolved.relativePath);
    if (acceptedPath !== undefined) accepted.delete(acceptedPath);
    if (hasLegacy) accepted.add(resolved.relativePath);           // 遗留的记名（不能删别人的文件）
    next.acceptedLegacyPaths = uniquePaths(session, accepted);

    await this.writeManifest(next);
    await this.removeUnreferencedSnapshots(session.id, next);     // 顺带清掉没人引用的快照
  });
}
```

`keepAll`（`baseline.manager.ts:235-249`）同构：entries 清空、把所有遗留路径并进接受名单、写清单、清快照。接受的本版文件＝从 entries 删掉；接受的遗留文件＝进 acceptedLegacyPaths 记名——区别在**快照文件是我们自己的可删，遗留文件在用户的旧安装目录里不可删**，只能记住"别再把它当跟踪对象"。

`removeUnreferencedSnapshots`（`baseline.manager.ts:413-435`）：readdir 快照目录，清单 entries 引用不到的文件名全删：

```ts
// baseline.manager.ts:428-434（节选）
const referenced = new Set(Object.values(manifest.entries).map((entry) => entry.snapshot));
await Promise.all(
  names.map(async (name) => {
    if (referenced.has(name)) return;
    await rm(path.join(snapshotsDir, name), { force: true });
  }),
);
```

内容寻址在这显出第三重好处：**"清单没提到"与"没人要"严格等价**（同内容共享文件名，只要还有一条 entry 指向它就在引用集里）。

## 六、materializeToFork：给 fork 会话配齐基线

```ts
// baseline.manager.ts:251-286（节选）
async materializeToFork(source: BaselineSession, target: BaselineSession): Promise<void> {
  if (source.id === target.id) {
    throw new BaselineError('Cannot materialize a baseline fork onto the source session');
  }
  await this.serialize([source.id, target.id], async () => {     // ★双会话队列：两个 id 都排队
    const sourceManifest = await this.readManifest(source);
    const sourcePaths = await this.effectivePaths(source, sourceManifest);
    const values = new Map<string, BaselineValue>();
    for (const relativePath of sourcePaths) {
      const baseline = await this.readEffectiveBaseline(source, relativePath, sourceManifest);
      if (baseline !== undefined) values.set(relativePath, baseline);
    }

    const targetManifest = await this.readManifest(target);
    const next = mutableManifest(targetManifest);
    const accepted = uniquePaths(target, [...next.acceptedLegacyPaths, ...sourceManifest.acceptedLegacyPaths]);

    for (const [relativePath, baseline] of values) {
      const existingPath = equivalentPath(target, Object.keys(next.entries), relativePath);
      if (existingPath !== undefined) continue;                    // fork 自己已有的不覆盖
      const snapshot = hash(baseline.content);
      await this.writeSnapshot(target.id, snapshot, baseline.content);  // 同内容共享同一哈希名
      next.entries[relativePath] = { snapshot, existedBefore: baseline.existedBefore };
    }
    next.acceptedLegacyPaths = accepted;
    await this.writeManifest(next);
  });
}
```

**谁调用**：session.handler.ts:219-222（ForkKimiSession RPC）——用户从历史会话某轮 fork 出新会话时，源会话"到那一轮为止"的基线要跟着过去，否则新会话里 Undo 没有底账（调用代码见总地图公开方法表）。`serialize([source.id, target.id])` 是**双会话队列**：同时锁两个队列，防止复制期间源在拍新快照、target 在被别的写操作改清单。因为快照按内容寻址，源和 target 的同内容文件天然共享磁盘上同一份快照——materialize 只是清单层面的记录搬运，不真复制内容。

## 七、deleteSession 与"清空即删目录"

```ts
// baseline.manager.ts:288-293
async deleteSession(sessionId: string): Promise<void> {
  requireSessionId(sessionId);
  await this.serialize([sessionId], async () => {
    await rm(this.sessionRoot(sessionId), { recursive: true, force: true });
  });
}
```

整个会话目录连根删（清单＋全部快照）。`writeManifest`（`baseline.manager.ts:356-367`）里藏着对称的逻辑：**entries 和 acceptedLegacyPaths 双双为空时，不写空清单，而是把整个会话目录删掉**——keep 完最后一个文件后磁盘上不留空壳目录：

```ts
// baseline.manager.ts:356-367
private async writeManifest(manifest: BaselineManifestV1): Promise<void> {
  if (
    Object.keys(manifest.entries).length === 0 &&
    manifest.acceptedLegacyPaths.length === 0
  ) {
    await rm(this.sessionRoot(manifest.sessionId), { recursive: true, force: true });
    return;
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await atomicWrite(this.manifestPath(manifest.sessionId), text);
}
```

## 八、清单读写：readManifest / parseManifest / writeManifest

`readManifest`（`baseline.manager.ts:333-354`）：readFile，ENOENT → `emptyManifest`（新会话第一张清单是内存里现造的，磁盘还不存在）；其他读错/JSON 解析失败 → 包成 BaselineError 重抛。

`parseManifest`（`baseline.manager.ts:553-610`）是**清单的反序列化兼全面校验**，逐层验证：

- `version !== 1` / `sessionId` 对不上 → 抛（防拿错会话的清单）——`baseline.manager.ts:554-559`：`if (!isRecord(value) || value['version'] !== MANIFEST_VERSION) { throw new BaselineError(...)` ＋ `if (value['sessionId'] !== session.id) { throw ... }`；

- 每条 entry：snapshot 必须匹配 `SNAPSHOT_HASH` 正则（`/^[a-f0-9]{64}$/`，`baseline.manager.ts:21`）、existedBefore 必须是布尔——`baseline.manager.ts:570-574`：`!isRecord(rawEntry) || typeof rawEntry['snapshot'] !== 'string' || !SNAPSHOT_HASH.test(rawEntry['snapshot']) || typeof rawEntry['existedBefore'] !== 'boolean'`；

- 每个路径：`resolveSessionFile` 重新归一后必须与原字符串**一字不差**（`baseline.manager.ts:580`：`if (relativePath !== rawPath || entryKeys.has(comparisonKey)) { throw new BaselineError(\`Unsafe baseline path ...\`)`）——防 `..` 穿越、防 Windows 反斜杠混入、防大小写不同的重复条目；

- acceptedLegacyPaths 同样过一遍归一＋去重。

清单是磁盘上的 JSON，**任何人都能手改**——parseManifest 按"不可信输入"对待它，这是与 bridge 协议手写校验（[01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第 3.4 节）同一个威胁模型的磁盘版。

## 九、快照读写与原子写

```ts
// baseline.manager.ts:369-389（writeSnapshot 节选）
private async writeSnapshot(sessionId: string, snapshot: string, content: string): Promise<void> {
  const snapshotPath = this.snapshotPath(sessionId, snapshot);
  try {
    const existing = await readFile(snapshotPath, 'utf-8');
    if (hash(existing) !== snapshot) {                            // 同名但内容不对＝损坏
      throw new BaselineError(`Baseline snapshot "${snapshot}" for session "${sessionId}" is corrupt`);
    }
    return;                                                       // 已存在且校验通过：不重写
  } catch (error) { /* 非 ENOENT 的错误包装后上抛 */ }
  await atomicWrite(snapshotPath, content);
}
```

写前先读已存在的同名文件并校验内容哈希（内容寻址的必然要求——同名必须同内容，不一致说明磁盘损坏，宁可报错不用坏数据），一致则跳过写入。`readSnapshot`（`baseline.manager.ts:391-411`）读回时同样重算哈希校验：`if (hash(content) !== snapshot) { throw new BaselineError(...corrupt...); }`。`snapshotPath`（`baseline.manager.ts:532-537`）在拼路径前用 `SNAPSHOT_HASH` 正则把关——**哈希值进路径组件前先验形状**，杜绝 `../../x` 伪装成哈希。

```ts
// baseline.manager.ts:812-822
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });   // 目录仅本用户
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf-8', mode: 0o600 }); // 文件仅本用户
    await rename(temporaryPath, targetPath);                                  // 原子替换
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);          // 清理残骸
    throw new BaselineError(`Unable to atomically write "${targetPath}"`, { cause: error });
  }
}
```

原子写三件套：写临时文件（名字带 pid＋UUID，并发互不踩）→ rename（同文件系统上原子）→ 失败清残骸。读者要么看到完整旧文件、要么看到完整新文件，永远没有半个。基线内容可能包含用户代码，`0o600`/`0o700` 权限防同机其他用户偷读。

## 十、遗留基线：旧 kimi-cli 的基线记录

背景：迁移工具把旧 kimi-cli 会话搬进来时，在会话 metadata 写下 `kimi_cli_source_path`（旧安装目录）。旧版的基线就存在 `<那个目录>/baseline/` 下，**文件内容＝原文件内容，空文件＝"原来是新建的"**。

- `legacyBaselineRoot`（`baseline.manager.ts:670-678`）：从 metadata 取路径——`baseline.manager.ts:671`：`const source = session.metadata?.['kimi_cli_source_path'];`；**平台一致性检查**——路径是 Windows 形态但当前不是 win32（或反之）→ 返回 undefined（不跟跨平台的旧目录纠缠）；

- `legacyBaselinePath`（`baseline.manager.ts:680-688`）：相对路径拼到遗留根下——`baseline.manager.ts:687`：`return path.join(root, ...resolved.relativePath.split('/'));`；

- `walkLegacyBaselines`（`baseline.manager.ts:690-715`）：递归遍历目录收集全部文件相对路径（跟符号链接的目录不进，只收 isFile）；

- `readLegacyBaseline`（`baseline.manager.ts:467-495`）：stat＋readFile，返回 `{ content, existedBefore: content.length > 0 }`——**空文件映射为"原来不存在"**，对上旧版"新建文件存空快照"的约定；

- `hasLegacyBaseline`（`baseline.manager.ts:446-465`）：只 stat 判存在。

两个"有效"私有方法是本版与遗留的合流点：`effectivePaths`（`baseline.manager.ts:295-313`）＝本版 entries ＋ 遗留目录里**没被接受**的路径（按比较键去重，字典序）；`readEffectiveBaseline`（`baseline.manager.ts:315-331`）＝本版 entry 优先，没有再看接受名单（在名单里→undefined 不跟踪），否则读遗留。**所有面向 UI 的方法（getChanges/undo/keep）走的都是这两个"有效"入口**——用户视角下新旧两份记录合成一个视图。

## 十一、并发：serialize 与 waitForUpdates

```ts
// baseline.manager.ts:497-514
private async serialize<T>(sessionIds: readonly string[], operation: () => Promise<T>): Promise<T> {
  const ids = [...new Set(sessionIds)].toSorted();               // 去重＋排序：锁顺序固定
  for (const id of ids) requireSessionId(id);

  const previous = ids.map((id) => this.updates.get(id) ?? Promise.resolve());
  const run = Promise.all(previous).then(operation);             // 排在所有前序写后面
  const settled = run.then(() => undefined, () => undefined);     // 吞错的"完成信号"
  for (const id of ids) this.updates.set(id, settled);
  void settled.then(() => {
    for (const id of ids) {
      if (this.updates.get(id) === settled) this.updates.delete(id);  // 队列清尾
    }
  });
  return run;
}
```

每个会话在 `updates` 表里挂着"它最后一次写操作"的 Promise；新写操作 `Promise.all(previous).then(operation)` 排在队尾。三个细节：**去重＋排序**——materializeToFork 锁 [source, target]，两把锁按固定字典序获取，不会出现 A 等 B、B 等 A 的死锁；**settled 吞掉错误**——队列信号只表示"做完了"，错误经 `run` 返回给发起者本人，不传染后续排队者；**清尾前比对身份**（`this.updates.get(id) === settled`）——只有自己还是队尾时才删，防止删掉后来者挂上的新 Promise。

`waitForUpdates`（`baseline.manager.ts:516-518`）是读者版本：

```ts
// baseline.manager.ts:516-518
private async waitForUpdates(sessionIds: readonly string[]): Promise<void> {
  await Promise.all(sessionIds.map((id) => this.updates.get(id) ?? Promise.resolve()));
}
```

等这几个会话的在途写完成，不排队——**读不该被后续写挡住，只需看到已完成的世界**。getChanges/getContent/undo 的第一行都是它。

## 十二、路径归一与 Windows：resolveSessionFile 家族

```ts
// baseline.manager.ts:637-664（节选）
function resolveSessionFile(session: BaselineSession, filePath: string): ResolvedFile {
  requireSession(session);
  if (filePath.length === 0) throw new BaselineError('The baseline file path is empty');

  const windows = isWindowsAbsolute(session.workDir);
  if (!windows && isWindowsAbsolute(filePath)) {
    throw new BaselineError(`File "${filePath}" is outside workspace "${session.workDir}"`);  // Mac/Linux 上的盘符路径＝越界
  }
  const paths = windows ? path.win32 : path;                     // 按会话目录选路径库
  const root = paths.resolve(session.workDir);
  const absolutePath = paths.resolve(root, filePath);
  const relativePath = paths.relative(root, absolutePath);
  const parentPrefix = `..${paths.sep}`;
  if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(parentPrefix)
      || paths.isAbsolute(relativePath)) {
    throw new BaselineError(`File "${filePath}" is outside workspace "${session.workDir}"`);  // .. 穿越＝越界
  }
  return { absolutePath, relativePath: windows ? relativePath.replaceAll('\\', '/') : relativePath };
}
```

**所有进清单/碰磁盘的路径都从这里过**：拼绝对路径→算相对路径→检查相对路径没有逃逸（空、`..` 开头、变回绝对都是越界）→Windows 上把 `\` 统一成 `/`。Windows 支持是"按会话目录判断"而非按当前进程：Mac 上也能正确处理一个 Windows 会话（测试 "accepts the normalized SDK workDir when a Windows session is created"（kimi-runtime.test.ts:321）覆盖这种跨平台场景）。`pathComparisonKey`（`baseline.manager.ts:633-635`）：

```ts
// baseline.manager.ts:633-635
function pathComparisonKey(session: BaselineSession, relativePath: string): string {
  return isWindowsAbsolute(session.workDir) ? relativePath.toLowerCase() : relativePath;
}
```

Windows 会话的路径比较键＝全小写（`A.txt` 与 `a.txt` 等价），其他平台原样——`equivalentPath`/`uniquePaths` 都基于它做等价判断。

杂项四件：`hash`（`baseline.manager.ts:833-835`）＝`return createHash('sha256').update(value, 'utf-8').digest('hex');`；`countLines`（`baseline.manager.ts:845-848`）CRLF 归一后按 `\n` 数（空串＝0 行）；`requireSession`/`requireSessionId`（`baseline.manager.ts:824-831`）空串守卫；`isRecord`/`isErrorCode`（`baseline.manager.ts:837-843`）unknown 收窄工具。`BaselineError`（`baseline.manager.ts:58-63`）给错误贴上稳定的名字（`this.name = 'BaselineError';`），调用方（file.handler）靠 message 前缀区分场景。

## 十三、设计复盘

1. **同步读＋异步写，各干各的时序。** 读取必须快过工具写入（同步），持久化不该卡引擎（异步排队）。反例：全同步——每次 Write/Edit 前阻塞事件循环做两次盘 IO，流式输出卡顿；全异步——读到的是改完后的内容，基线失真，Undo 会把用户文件写坏。

2. **内容寻址＝去重＋自校验＋可清扫三位一体。** 反例：按序号命名快照（`1.snap`、`2.snap`），同内容存 N 份；读回无从验证完整性；清理时无法判断"哪个文件没人引用"。

3. **每会话串行队列而不是全局锁。** 反例：一把全局锁，A 会话保存快照时 B 会话的 Undo 排队等——两个会话操作的是不相干的目录树，白白串行；反例二：完全不锁，两个并发 capture 各读一份清单、各写各的，后写的覆盖先写的，丢一条基线。

4. **清单按不可信输入对待。** parseManifest 逐字段验形状、路径重新归一后要求一字不差。反例：直接 `JSON.parse` 完就信，手改清单里的 `"../../../.ssh/authorized_keys"` 就能在 Undo 时写穿到会话目录外（restoreFile 的 realpath 闸是第二道防线，但第一道就该拦住）。

5. **遗留兼容收在"有效视图"后面。** effectivePaths/readEffectiveBaseline 两个私有方法把新旧两份记录合流，九个公开方法不感知 legacy 细节。反例：每个公开方法里都写 `if (有遗留) ...`，九处复制同一段判断，改一处漏八处。

6. **空了就删目录。** writeManifest 发现清单空了直接 rm 会话目录。反例：keep 完最后一个文件留下空 manifest.json＋空 snapshots/ 目录，globalStorage 里会话越多垃圾目录越多。

## 下一步

- 谁在调 capture/getChanges/getContent：[02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第九、十一节（调用块原文在那里）；面板刷新链在 [01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第 8.5 节。

- 保存快照的触发源头（tool.call.started）：[05-SessionRuntime方法详解.md](05-SessionRuntime方法详解.md) 的事件管线一节。

- 旧数据怎么被搬进来（kimi_cli_source_path 的写入方）：`apps/vscode/src/migration`（LegacyMigrationManager），本篇只消费它写下的路径。
