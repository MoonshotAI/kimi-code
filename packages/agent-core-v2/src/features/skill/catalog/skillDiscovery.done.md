# ISkillDiscovery（skillDiscovery）

- v2: `packages/agent-core-v2/src/features/skill/catalog/skillDiscovery.ts`（约 17 行，读 interface 与实现得出；实现为同目录 fileSkillDiscovery.ts）
- 新架构: `packages/harness-core/src/features/skill/catalog/discovery.ts`

## 能力对照

- [x] discover(roots) 扫描技能根，返回 skills/skipped/scannedRoots/scannedDirectories（结果结构同名保留） → `packages/harness-core/src/features/skill/catalog/discovery.ts`（discoverSkills）
- [x] 扫描深度上限（MAX_SKILL_SCAN_DEPTH=8）、排除 node_modules 与点开头目录 → 同文件
- [x] root-skill-only 扫描模式、子技能（sub-skill）命名与插件技能命名空间去重 → 同文件（byDiscoveryKey、qualifySubSkillName）
- [x] 解析失败与不支持类型的 skipped 记录及告警 → 同文件（SkillParseError/UnsupportedSkillTypeError 分支；warn 回调取代 ILogService）
- [x] 文件系统访问 → 由宿主注入端口 `packages/harness-core/src/features/os/host/index`（OsFsPort）承载，取代 v2 直接 node:fs

## 结论

全部对齐；DI 服务变为纯函数 + OsFsPort 宿主端口注入。
