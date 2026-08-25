// Kimi Code Canary channel via GitHub Releases + the machine's own `gh` CLI.
//
// Canary（内测版）与正式版是同一套代码的两种构建身份（release-channel.ts），
// 它刻意绕开 CDN / electron-updater（updater.ts 在 canary 下禁用）：canary
// 构建由 desktop-build.yml 的 `canary` 输入产出，以 GitHub *prerelease* 发布
// 在私有仓 MoonshotAI/kimi-code-app；app 内的检查 / 下载 / 触发全部通过
// 本机 `gh` 二进制完成——用内部用户自己的 GitHub 身份，任何 token 都不随包
// 分发（私有仓，嵌 token 等于把源码读权限发给每个拿到安装包的人）。
//
// UX 契约（方案 = 侧栏黄点 + 弹窗，与正式版更新同一套 UX）：
// - 启动后延迟首次检查、之后按周期间隔检查；发现更新的 `-canary.n` 时进入
//   `available`，renderer 点亮侧栏黄 pill（跳过逻辑在 renderer 侧，
//   useCanaryChannel，与 update skip 同款 localStorage 模式）；
// - 「下载」把当平台的 dmg 拉进 ~/Downloads 并挂载（mac）；安装保持手动
//   拖装——canary 不做应用内自动安装；
// - 设置 → 高级另有手动检查（带 gh 状态的行内反馈）与「触发构建」
//  （`gh workflow run desktop-build.yml -f canary=true`）入口；
// - 可见性：canary 构建 + dev 启用；正式版构建整个通道关闭
//  （isCanaryChannelEnabled）。
//
// 与 updater.ts 同构：全部外部调用走 execFile（无 shell 字符串），tag 一律
// 过 CANARY_TAG_RE 才进 argv；依赖注入（CanaryDeps）便于测试；生产装配在
// 文件底部。

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { app, shell } from 'electron';

import { log } from './log';
import { isCanaryChannelEnabled, isCanaryDisplay, isCanaryVersion } from './release-channel';

export const CANARY_REPO = 'MoonshotAI/kimi-code-app';
export const CANARY_WORKFLOW = 'desktop-build.yml';
const ACTIONS_URL = `https://github.com/${CANARY_REPO}/actions/workflows/${CANARY_WORKFLOW}`;

/** Canary tag/release 形如 `v<x>.<y>.<z>-canary.<n>`（CI stamp）。renderer
    传来的 tag 一律先过这个正则。 */
export const CANARY_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-canary\.(\d+)$/;

const GH_TIMEOUT_MS = 20_000;
const GH_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;

const INITIAL_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export type CanaryState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface CanaryStatus {
  state: CanaryState;
  version?: string;
  /** Release tag (`v…-canary.n`), needed by the download action. */
  tag?: string;
  /** ISO date from the GH prerelease. */
  releaseDate?: string;
  /** Downloaded installer path (`downloaded` state). */
  path?: string;
  message?: string;
}

export type CanaryGhState = 'ok' | 'missing' | 'unauthenticated' | 'error';

export interface CanaryInfo {
  /** Whether the canary UI shows at all (canary build or dev). */
  enabled: boolean;
  /** True only on a real canary build (version carries `-canary.`) — drives
      the always-on sidebar badge so dev runs of the stable app stay quiet. */
  isCanaryBuild: boolean;
  gh: CanaryGhState;
  /** Deep link to the workflow page (设置页「查看流水线」). */
  actionsUrl: string;
}

/** Result of the settings-row manual check. */
export type CanaryCheckResult =
  | { outcome: 'available'; version: string }
  | { outcome: 'latest' }
  | { outcome: 'gh-missing' }
  | { outcome: 'gh-unauthenticated' }
  | { outcome: 'error'; message: string };

export type CanaryTriggerResult = { ok: true } | { ok: false; error: string };

export type ExecFileAsync = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface CanaryDeps {
  exec: ExecFileAsync;
  platform: NodeJS.Platform;
  arch: string;
  /** Current app version (`app.getVersion()`). */
  version: string;
  isPackaged: boolean;
  downloadsDir: string;
  exists: (path: string) => boolean;
  openPath: (path: string) => Promise<string>;
  /** Status push (production: sendToRenderer over `kimi:canary-status`). */
  send: (status: CanaryStatus) => void;
  initialDelayMs?: number;
  intervalMs?: number;
}

export interface CanaryController {
  getStatus(): CanaryStatus;
  /** Settings-row manual check: resolves with the outcome (unlike the
      fire-and-forget scheduled checks, which only move the state machine). */
  check(): Promise<CanaryCheckResult>;
  /** User-initiated download of the available version (no-op otherwise). */
  download(): void;
  /** Re-open the downloaded dmg (dialog's「打开安装包」after `downloaded`). */
  openDownloaded(): void;
  triggerBuild(): Promise<CanaryTriggerResult>;
  stop(): void;
}

// --- pure helpers --------------------------------------------------------------

interface ParsedVersion {
  core: [number, number, number];
  canary: number | null;
}

/** Parse `x.y.z` / `x.y.z-canary.n`（可带前导 `v`）。其他形态返回 null。 */
export function parseCanaryVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-canary\.(\d+))?$/.exec(version.trim());
  if (match === null) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    canary: match[4] === undefined ? null : Number(match[4]),
  };
}

/** semver-ish compare：先比 core，同 core 时 stable > canary，再比 canary
    序号。返回负数 / 0 / 正数。 */
export function compareCanaryVersions(a: string, b: string): number {
  const pa = parseCanaryVersion(a);
  const pb = parseCanaryVersion(b);
  if (pa === null || pb === null) {
    return 0;
  }
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) {
      return pa.core[i]! - pb.core[i]!;
    }
  }
  if (pa.canary === null && pb.canary === null) return 0;
  if (pa.canary === null) return 1;
  if (pb.canary === null) return -1;
  return pa.canary - pb.canary;
}

/** `gh release download --pattern` 的资产通配（命名规则见
    electron-builder.config.cjs 的 artifactName）。canary 只有 mac 包。 */
export function canaryAssetPattern(arch: string): string | null {
  return arch === 'arm64' || arch === 'x64' ? `KimiCodeCanary-*-mac-${arch}.dmg` : null;
}

/** 指定 canary 版本的确切资产文件名。 */
export function canaryAssetFileName(version: string, arch: string): string | null {
  return arch === 'arm64' || arch === 'x64' ? `KimiCodeCanary-${version}-mac-${arch}.dmg` : null;
}

/** `gh` 查找：GUI 应用的 PATH 不含 Homebrew，先探常见绝对路径再兜底裸 `gh`。 */
export function resolveGhBinary(deps: Pick<CanaryDeps, 'exists' | 'platform'>): string {
  const candidates: string[] =
    deps.platform === 'darwin'
      ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']
      : deps.platform === 'win32'
        ? ['C:\\Program Files\\GitHub CLI\\gh.exe']
        : ['/usr/local/bin/gh', '/usr/bin/gh', '/snap/bin/gh'];
  for (const candidate of candidates) {
    if (deps.exists(candidate)) {
      return candidate;
    }
  }
  return 'gh';
}

interface GhRelease {
  tag_name?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  published_at?: unknown;
}

/** 从 releases API 载荷里挑最新的 canary prerelease。 */
export function pickLatestCanaryRelease(
  payload: unknown,
): { version: string; tag: string; releaseDate?: string } | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  let best: { version: string; tag: string; releaseDate?: string } | null = null;
  for (const entry of payload as GhRelease[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (entry.prerelease !== true || entry.draft === true) continue;
    if (typeof entry.tag_name !== 'string' || !CANARY_TAG_RE.test(entry.tag_name)) continue;
    const version = entry.tag_name.slice(1);
    if (best === null || compareCanaryVersions(version, best.version) > 0) {
      best = {
        version,
        tag: entry.tag_name,
        ...(typeof entry.published_at === 'string' ? { releaseDate: entry.published_at } : {}),
      };
    }
  }
  return best;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') {
      return stderr.trim().split('\n')[0]!;
    }
    return error.message;
  }
  return String(error);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'ENOENT';
}

type GhProbe = Pick<CanaryDeps, 'exec' | 'exists' | 'platform'>;

async function probeGh(deps: GhProbe): Promise<CanaryGhState> {
  const bin = resolveGhBinary(deps);
  try {
    await deps.exec(bin, ['--version'], { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  } catch (error) {
    return isEnoent(error) ? 'missing' : 'error';
  }
  try {
    await deps.exec(bin, ['auth', 'status'], { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    return 'ok';
  } catch {
    // `gh auth status` 在没有登录任何 host 时非零退出。
    return 'unauthenticated';
  }
}

type LatestCanary = { version: string; tag: string; releaseDate?: string };

/** 查询远端最新 canary：gh 状态原样上抛，API/解析失败抛异常（调用方按
    手动 / 后台检查分别落到 error 结果或静默日志）。 */
async function fetchLatestCanary(deps: GhProbe): Promise<{ gh: 'ok'; latest: LatestCanary | null } | { gh: Exclude<CanaryGhState, 'ok'> }> {
  const gh = await probeGh(deps);
  if (gh !== 'ok') {
    return { gh };
  }
  const bin = resolveGhBinary(deps);
  const { stdout } = await deps.exec(
    bin,
    ['api', `repos/${CANARY_REPO}/releases?per_page=50`],
    { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
  );
  return { gh: 'ok', latest: pickLatestCanaryRelease(JSON.parse(stdout)) };
}

// --- controller -----------------------------------------------------------------

/** Start the canary channel (scheduled checks + actions). Returns null when
    the channel is disabled (stable packaged build — see release-channel.ts). */
export function startCanaryChannel(deps: CanaryDeps): CanaryController | null {
  if (!isCanaryChannelEnabled(deps.version, deps.isPackaged)) {
    return null;
  }
  const { send } = deps;

  let current: CanaryStatus = { state: 'idle' };
  const setStatus = (next: CanaryStatus): void => {
    current = next;
    send(current);
  };

  const offer = (latest: LatestCanary): void => {
    // A scheduled re-check can re-announce the version the user already has
    // in flight; never regress downloading/downloaded back to available.
    if (
      (current.state === 'downloading' || current.state === 'downloaded') &&
      current.version === latest.version
    ) {
      return;
    }
    setStatus({
      state: 'available',
      version: latest.version,
      tag: latest.tag,
      ...(latest.releaseDate !== undefined ? { releaseDate: latest.releaseDate } : {}),
    });
    log.info(`[kimi-desktop] canary update available: ${latest.version}`);
  };

  const runCheck = async (): Promise<CanaryCheckResult> => {
    let result: Awaited<ReturnType<typeof fetchLatestCanary>>;
    try {
      result = await fetchLatestCanary(deps);
    } catch (error) {
      return { outcome: 'error', message: errorMessage(error) };
    }
    if (result.gh !== 'ok') {
      if (result.gh === 'missing') return { outcome: 'gh-missing' };
      if (result.gh === 'unauthenticated') return { outcome: 'gh-unauthenticated' };
      return { outcome: 'error', message: 'gh probe failed' };
    }
    const { latest } = result;
    if (latest !== null && compareCanaryVersions(latest.version, deps.version) > 0) {
      offer(latest);
      return { outcome: 'available', version: latest.version };
    }
    // The feed no longer offers anything newer: drop stale available/error
    // states (in-flight downloads finish on their own events).
    if (current.state === 'available' || current.state === 'error') {
      setStatus({ state: 'idle' });
    }
    return { outcome: 'latest' };
  };

  // Scheduled checks are fire-and-forget: gh/network failures are logged and
  // swallowed — a laptop on a flaky network must not grow an error pill.
  const check = (): void => {
    void runCheck().then((outcome) => {
      if (outcome.outcome === 'error') {
        log.warn(`[kimi-desktop] background canary check failed: ${outcome.message}`);
      }
    });
  };
  const initialTimer = setTimeout(check, deps.initialDelayMs ?? INITIAL_DELAY_MS);
  const intervalTimer = setInterval(check, deps.intervalMs ?? CHECK_INTERVAL_MS);
  initialTimer.unref();
  intervalTimer.unref();

  const download = (): void => {
    if (current.state !== 'available' && current.state !== 'error') {
      return;
    }
    const { version, tag, releaseDate } = current;
    if (version === undefined || tag === undefined || !CANARY_TAG_RE.test(tag)) {
      return;
    }
    const pattern = canaryAssetPattern(deps.arch);
    const fileName = canaryAssetFileName(version, deps.arch);
    if (pattern === null || fileName === null) {
      setStatus({ state: 'error', version, tag, message: `unsupported arch: ${deps.arch}` });
      return;
    }
    setStatus({ state: 'downloading', version, tag, ...(releaseDate !== undefined ? { releaseDate } : {}) });
    log.info(`[kimi-desktop] canary download started: ${version}`);
    const bin = resolveGhBinary(deps);
    void deps
      .exec(
        bin,
        ['release', 'download', tag, '--repo', CANARY_REPO, '--pattern', pattern, '--dir', deps.downloadsDir, '--clobber'],
        { timeout: GH_DOWNLOAD_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      )
      .then(async () => {
        const path = join(deps.downloadsDir, fileName);
        if (!deps.exists(path)) {
          throw new Error('download finished but the installer is missing');
        }
        const openError = await deps.openPath(path);
        if (openError !== '') {
          throw new Error(openError);
        }
        setStatus({ state: 'downloaded', version, tag, ...(releaseDate !== undefined ? { releaseDate } : {}), path });
        log.info(`[kimi-desktop] canary update downloaded: ${version} -> ${path}`);
      })
      .catch((error: unknown) => {
        log.error('[kimi-desktop] canary download failed', error);
        // A failed download may have left the state at `downloading`; only
        // regress the state for the version we were fetching.
        if (current.state === 'downloading' && current.version === version) {
          setStatus({ state: 'error', version, tag, message: errorMessage(error) });
        }
      });
  };

  return {
    getStatus: () => current,
    check: runCheck,
    download,
    openDownloaded: () => {
      if (current.state !== 'downloaded' || current.path === undefined) {
        return;
      }
      void deps.openPath(current.path).then((openError) => {
        if (openError !== '') {
          log.warn(`[kimi-desktop] canary re-open failed: ${openError}`);
        }
      });
    },
    triggerBuild: async () => {
      const gh = await probeGh(deps);
      if (gh !== 'ok') {
        return { ok: false as const, error: `gh not ready: ${gh}` };
      }
      const bin = resolveGhBinary(deps);
      try {
        await deps.exec(
          bin,
          ['workflow', 'run', CANARY_WORKFLOW, '--repo', CANARY_REPO, '--ref', 'main', '-f', 'canary=true'],
          { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        );
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error: errorMessage(error) };
      }
    },
    stop: () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}

// --- production singleton -----------------------------------------------------

const execFileAsync = promisify(execFile) as ExecFileAsync;

function productionDeps(send: (status: CanaryStatus) => void): CanaryDeps {
  return {
    exec: execFileAsync,
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    downloadsDir: app.getPath('downloads'),
    exists: existsSync,
    openPath: (path) => shell.openPath(path),
    send,
  };
}

let controller: CanaryController | null = null;

/** Production wiring (called with the renderer push function, mirroring
    initAutoUpdater). No-op on stable packaged builds — the enabled check runs
    BEFORE building deps so disabled channels never touch app paths. */
export function initCanaryChannel(send: (status: CanaryStatus) => void): void {
  if (!isCanaryChannelEnabled(app.getVersion(), app.isPackaged)) {
    return;
  }
  controller = startCanaryChannel(productionDeps(send));
}

function productionProbe(): GhProbe {
  return {
    exec: execFileAsync,
    exists: existsSync,
    platform: process.platform,
  };
}

// IPC entry points (see ipc.ts). All safe to call with no controller (stable
// build / before init): they degrade to idle / disabled outcomes.
export function getCanaryStatus(): CanaryStatus {
  return controller?.getStatus() ?? { state: 'idle' };
}

export async function getCanaryInfo(): Promise<CanaryInfo> {
  return {
    enabled: isCanaryChannelEnabled(app.getVersion(), app.isPackaged),
    isCanaryBuild: isCanaryDisplay(app.getVersion(), app.isPackaged),
    gh: await probeGh(productionProbe()),
    actionsUrl: ACTIONS_URL,
  };
}

export function requestCanaryCheck(): Promise<CanaryCheckResult> {
  return controller?.check() ?? Promise.resolve({ outcome: 'error', message: 'canary channel disabled' });
}

export function requestCanaryDownload(): void {
  controller?.download();
}

export function requestCanaryOpen(): void {
  controller?.openDownloaded();
}

export function requestCanaryTrigger(): Promise<CanaryTriggerResult> {
  return (
    controller?.triggerBuild() ?? Promise.resolve({ ok: false as const, error: 'canary channel disabled' })
  );
}

/** isCanaryVersion re-export for the updater/deep-link guards' callers that
    already import this module. */
export { isCanaryVersion };
