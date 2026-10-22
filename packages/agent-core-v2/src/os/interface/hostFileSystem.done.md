# IHostFileSystem（hostFileSystem）

- v2: `packages/agent-core-v2/src/os/interface/hostFileSystem.ts`（约 45 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/os/host/types.ts`（OsFsPort）

## 能力对照

- [x] 文本读写（readText / writeText / appendText / readLines，含编码与解码错误策略）→ `packages/harness-core/src/features/os/host/types.ts` 的 OsFsPort 同名方法
- [x] 字节读写（readBytes 带 n/offset、writeBytes、createExclusive 排他创建）→ 同上同名方法
- [x] 元数据与目录（stat / lstat / readdir / mkdir / remove / realpath）→ 同上同名方法；另增补 rename
- [x] errno 到错误域的映射（v2 由实现侧承担）→ types.ts 的 HostFsError/toHostFsError（os.fs.* 错误码 + retryable 标记）
- [x] Node 实现与宿主注入 → `packages/harness-core/src/features/os/host/node.ts` 的 createNodeOsHost，经 os feature props.host 注入

## 结论

全部对齐：文件系统端口逐方法平移（并增补 rename），错误域映射由 HostFsError 承载。
