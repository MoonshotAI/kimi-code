# IProjectLocalConfigService（projectLocalConfigService）

- v2: `packages/agent-core-v2/src/app/projectLocalConfig/projectLocalConfig.ts`（约 21 行 interface）
- 新架构: `packages/harness-core/src/features/workspaces/feature.ts`

## 能力对照

- [x] readAdditionalDirs（定位 git 项目根、读 `.kimi-code/local.toml` 的 additional_dirs）→ feature.ts 的 findProjectRoot + readLocalToml/readAdditionalDirs
- [x] resolveAdditionalDirs（相对路径解析为绝对、过滤不存在目录）→ feature.ts 的 resolveExistingDirs
- [x] appendAdditionalDir（追加并持久化到 local.toml）→ feature.ts 的 appendAdditionalDir + WorkspacesFace.addDir（persist=false 时走临时目录）
- [x] HTTP 暴露（project_root/config_path/additional_dirs 响应）→ `packages/harness-core/src/feature-http/route-features/workspaces.ts` 的 additional-dir 路由

## 结论

全部对齐——项目本地配置的附加目录读写由 workspaces feature 承载并经 feature-http 暴露。
