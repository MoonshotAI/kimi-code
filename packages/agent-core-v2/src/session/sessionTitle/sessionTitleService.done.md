# ISessionTitleService（sessionTitleService）

- v2: `packages/agent-core-v2/src/session/sessionTitle/sessionTitle.ts`（约 15 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/kimi/sessionTitle/feature.ts`

## 能力对照

- [x] generateTitle（force/source 选项，生成并写回标题）→ `packages/harness-core/src/features/kimi/sessionTitle/feature.ts`（`SessionTitleFace.generateTitle`，OAuth 通道取标题、custom 不覆盖、非 force 时共享在飞请求；纯被动 facade）
- [x] 标题写回与 titleKind 守护（generated 不覆盖 custom）→ 同文件（`generateAndApply` 经 `app.update` 写 `title` + `metadata.titleKind`，`titleKindOf` 判定）
- [x] 外部触发入口（REST）→ `packages/harness-core/src/feature-http/route-features/sessionTitle.ts`（`POST /sessions/:id/title/generate`，校验 source 三枚举）
- [x] 鉴权失败自愈（401 强制刷新 token 重试一次）→ `packages/harness-core/src/features/kimi/sessionTitle/feature.ts`（`generateAndApply` 的 OAuthError/401 分支）

## 结论

全部对齐。
