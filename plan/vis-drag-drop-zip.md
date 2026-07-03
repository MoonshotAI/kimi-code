# vis 支持拖入 zip 调试包

## 1. 背景与目标

`apps/vis` 是 kimi-code 会话的可视化调试工具。服务端已经支持导入他人通过
`/export-debug-zip` 导出的调试 zip（`POST /api/imports`，解压到
`<home>/imported/<id>/` 后按普通 session 展示）。Web 端目前只在 session 列表
左上角提供了一个「⬆ import debug zip」按钮，点击后弹出系统文件选择器。

目标：让 vis 的 Web UI 支持**直接拖入** zip 调试包，省去点按钮、找文件的步骤。

## 2. 现状关键事实

- **服务端已就绪**：`apps/vis/server/src/routes/imports.ts` 的 `POST /`
  接收原始 zip 字节流，调用 `importSessionZip` 解压并校验（必须含
  `agents/main/wire.jsonl`），返回 `{ sessionId, importMeta }`。
- **前端 API 已就绪**：`apps/vis/web/src/api.ts` 的 `api.importZip(file: File)`
  把文件作为 body POST 到 `/api/imports`；`useSession.ts` 的 `useImportZip()`
  在导入成功后 `invalidateQueries(['sessions'])` 刷新列表。
- **唯一缺口**：交互入口只有按钮 + 文件选择器，没有拖放。
- **现有导入入口**：`SessionRail` 的 `handleImport`（`apps/vis/web/src/components/sessions/SessionRail.tsx`）
  负责调用 `useImportZip` + `navigate` 到导入后的 session，失败时 `window.alert`。
  `SessionFilter` 的隐藏 `<input type="file">` 复用这个 handler。

## 3. 设计决策

| 决策点 | 结论 |
|---|---|
| 落区范围 | 整个窗口（`window` 级监听），任何位置拖入都可导入 |
| 拖入反馈 | 拖入文件时显示全屏 overlay：「drop debug zip to import」；上传中显示「importing…」 |
| 文件校验 | 前端按扩展名 / MIME 判断 `.zip`，非 zip 给 alert 提示；服务端仍做完整校验 |
| 成功后行为 | 复用现有逻辑：刷新列表并 `navigate` 到导入后的 session |
| 与按钮的关系 | 并存。拖放与文件选择器各用独立的 `useImportZip()`，互不阻塞 |

## 4. 实现方案

新增 `apps/vis/web/src/components/shared/ZipDropOverlay.tsx`：

- `useEffect` 在 `window` 上注册 `dragenter` / `dragover` / `dragleave` / `drop`。
- 用 `depth` 计数器处理子元素 enter/leave，避免 overlay 闪烁。
- 只在 `dataTransfer.types` 含 `Files` 时响应，避免拦截文本拖拽。
- `dragover` 调 `preventDefault()` 并设 `dropEffect = 'copy'`，否则浏览器不会触发 `drop`。
- `drop` 时取 `dataTransfer.files[0]`，非 zip 给 alert；否则调用
  `useImportZip().mutateAsync`，成功后 `navigate`，失败 alert。
- 通过 `isPending` 在 overlay 上区分「拖入中」与「上传中」。

纯函数 `isZipFile({ name, type })` 单独导出，便于在 node 环境下做单元测试。

在 `AppShell` 末尾渲染 `<ZipDropOverlay />`（`position: fixed`，不挤占布局）。

## 5. 验证

- `pnpm --filter @moonshot-ai/vis-web run typecheck` 通过。
- `pnpm --filter @moonshot-ai/vis-web run test` 通过（含新增 `isZipFile` 单测）。
- `pnpm --filter @moonshot-ai/vis-web run build` 通过。
- 手动：`pnpm run vis` 后，把 `/export-debug-zip` 产物拖进窗口，出现 overlay、
  松开后导入并跳到对应 session；拖入非 zip 文件出现提示且不导入。

## 6. 非目标

- 多文件批量导入（一次只处理第一个文件）。
- 上传进度条（服务端一次性缓冲 zip 字节，没有分块进度）。
- 把按钮与拖放的 `isPending` 状态合并（两者互斥触发，各自维护即可）。
