# kimi-code-rust-bin

npm 分发薄壳（阶段 F 前置）：`bin/kimi.js` 按平台 spawn Rust 二进制。

- CI 将 `cargo build --release -p kimi-cli` 的产物复制为 `bin/kimi-win32-x64.exe`（或通用 `kimi(.exe)`）
- 开发/测试：`KIMI_RUST_BIN=target/debug/kimi.exe npx kimi --help`
- 二进制缺失时给出清晰的构建提示

## 验证

```bash
KIMI_RUST_BIN=../../target/debug/kimi.exe node bin/kimi.js --help
KIMI_RUST_BIN=../../target/debug/kimi.exe node bin/kimi.js health
```
