// Release channel detection for the desktop build.
//
// Kimi Code Canary（内测版）与正式版同一份代码，唯一构建期差异是版本号：
// canary 构建的版本号恒为 `x.y.z-canary.n`（desktop-build.yml 打包前临时
// stamp，不回填仓库）。运行时据此分叉行为：
//   - index.ts 在启动最早期 `app.setName('Kimi Code Canary')`——userData 随
//     名字分离，canary 与正式版可双开（独立单实例锁与 app 级状态）；
//   - canary.ts 的内测检查/下载/触发只在 canary（或 dev）下启用；
//   - updater.ts 的 CDN 自动更新在 canary 下禁用——stable 的 latest-mac.yml
//     版本（如 0.0.17）在 semver 上大于 0.0.17-canary.n，不禁用会把 canary
//     「更新」回正式版，甚至退出时静默替换掉自己。
// 纯函数、不依赖 electron，便于各进程与测试直接引用。

/** Canary 构建的版本号标记（`0.0.17-canary.42`）。 */
export function isCanaryVersion(version: string): boolean {
  return version.includes('-canary.');
}

/** Dev-only identity override: `KIMI_DESKTOP_CANARY=true pnpm dev:desktop`
    simulates canary identity (badge / canary-gated display) without packaging
    or stamping a version. Packaged behavior is always version-driven — this
    never fires there. Deliberately NOT wired into app.setName: dev keeps
    sharing userData with the installed app (app.ts's design). */
export function isDevCanaryOverride(isPackaged: boolean): boolean {
  return !isPackaged && process.env['KIMI_DESKTOP_CANARY'] === 'true';
}

/** Runtime canary identity for renderer-facing display (侧栏 Canary 徽章)：
    真 canary 构建，或 dev 的 KIMI_DESKTOP_CANARY 模拟。 */
export function isCanaryDisplay(version: string, isPackaged: boolean): boolean {
  return isCanaryVersion(version) || isDevCanaryOverride(isPackaged);
}

/** canary 功能（内测面板/检查循环）是否启用：canary 构建，或 dev
    （unpackaged——开发面板与调试 gh 流程不需要先打包）。 */
export function isCanaryChannelEnabled(version: string, isPackaged: boolean): boolean {
  return !isPackaged || isCanaryVersion(version);
}
