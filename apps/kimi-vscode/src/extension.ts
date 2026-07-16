// apps/kimi-vscode/src/extension.ts
// Kimi Code for VS Code — an activity-bar webview that embeds the Kimi web UI.
//
// The extension is a thin shell that mirrors apps/kimi-desktop: it starts the
// local Kimi server, which serves the built kimi-web UI same-origin over REST
// + WS under /api/v1, and iframes that origin in the sidebar webview. The
// bearer token rides in the `#token=` URL fragment exactly like `kimi web`
// does when it opens a browser; `?workspace=<root>` plus the repeatable
// `&folder=<root>` params (kimi-web's workspace hint) pin the UI's initial
// selection to the primary VS Code folder and focus all workspace listings on
// exactly the VS Code folders, in folder order.
//
// Server launch, two modes:
//  - packaged vsix: the CLI's self-contained JS bundle (server/main.cjs) runs
//    under VS Code's own Electron Node (`ELECTRON_RUN_AS_NODE=1` on
//    process.execPath). The bundle is staged into global storage with the
//    embedded web UI plus node-pty's native binaries taken from VS Code's own
//    install (no platform binaries ship in the extension → one universal vsix).
//  - dev (monorepo): the apps/kimi-code sources via tsx, serving
//    apps/kimi-code/dist-web.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';

const VIEW_ID = 'kimi-vscode.sidebar';
const READY_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 20_000;
// stdout line printed by `kimi server run --foreground --log-level error`
// (formatReadyLine → buildOpenableUrl), carrying the actually-bound port (the
// kap-server port+1 walk resolves conflicts at runtime):
//   Kimi server: http://127.0.0.1:58627/#token=<token>
const READY_LINE = /Kimi server: (https?:\/\/[\w.-]+:\d+)\/#token=(\S+)/;

interface ServerHandle {
  readonly origin: string;
  readonly token: string;
}

interface ServerCommand {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly shell: boolean;
  /** Extra env merged into the child environment (e.g. ELECTRON_RUN_AS_NODE). */
  readonly extraEnv?: Record<string, string>;
}

const SERVER_FOREGROUND_ARGS = [
  'server',
  'run',
  '--foreground',
  '--port',
  '58627',
  '--log-level',
  'error',
] as const;

// ---------------------------------------------------------------------------
// Server process lifecycle
// ---------------------------------------------------------------------------

class ServerManager implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private starting: Promise<ServerHandle> | undefined;
  readonly output = vscode.window.createOutputChannel('Kimi Code');
  private readonly restartEmitter = new vscode.EventEmitter<void>();
  readonly onDidRestart = this.restartEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Repo root: the extension lives at <root>/apps/kimi-vscode. */
  private get repoRoot(): string {
    return resolve(this.context.extensionUri.fsPath, '..', '..');
  }

  /** Start the server if needed and resolve once it is ready (memoized). */
  ensure(): Promise<ServerHandle> {
    this.starting ??= this.spawnAndWaitReady().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  /** Kill the running server and ask the view to re-render (respawn). */
  async restart(): Promise<void> {
    this.output.appendLine('[kimi-vscode] restarting server');
    this.kill();
    this.starting = undefined;
    this.restartEmitter.fire();
  }

  async registerWorkspace(handle: ServerHandle, root: string): Promise<void> {
    try {
      const res = await fetch(`${handle.origin}/api/v1/workspaces`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${handle.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ root }),
      });
      const body = (await res.json()) as { code?: number; msg?: string };
      if (body.code !== 0) {
        this.output.appendLine(`[kimi-vscode] register workspace failed: ${body.msg ?? res.status}`);
      }
    } catch (error) {
      this.output.appendLine(`[kimi-vscode] register workspace error: ${String(error)}`);
    }
  }

  /**
   * How to launch the Kimi server:
   *  1. monorepo dev: the extension lives at <repo>/apps/kimi-vscode, so the
   *     apps/kimi-code CLI sources are right there — run them via tsx (the
   *     root `pnpm dev:kap-server` spawn line), serving apps/kimi-code/dist-web.
   *     Web / CLI edits take effect after a plain rebuild + server restart.
   *  2. packaged extension (marketplace vsix, no repo around): stage the
   *     self-contained CLI bundle (`server/main.cjs`) into global storage and
   *     run it under VS Code's own Electron Node (`ELECTRON_RUN_AS_NODE=1`).
   * Dev sources win whenever present — a packaged install has no repo
   * checkout next to it and always lands in the packaged branch.
   */
  private async resolveServerCommand(): Promise<ServerCommand> {
    const repoRoot = this.repoRoot;
    const isWin = process.platform === 'win32';
    const tsx = join(repoRoot, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
    const cliMain = join(repoRoot, 'apps', 'kimi-code', 'src', 'main.ts');
    if (existsSync(tsx) && existsSync(cliMain)) {
      return {
        command: tsx,
        args: [
          '--tsconfig',
          join(repoRoot, 'apps', 'kimi-code', 'tsconfig.dev.json'),
          '--import',
          join(repoRoot, 'build', 'register-raw-text-loader.mjs'),
          cliMain,
          ...SERVER_FOREGROUND_ARGS,
        ],
        cwd: repoRoot,
        shell: isWin,
      };
    }
    const bundledMain = join(this.context.extensionUri.fsPath, 'server', 'main.cjs');
    if (existsSync(bundledMain)) {
      const mainCjs = await this.stagePackagedRuntime();
      return {
        command: process.execPath,
        args: [mainCjs, ...SERVER_FOREGROUND_ARGS],
        cwd: homedir(),
        shell: false,
        // Run the Electron binary as plain Node.js (VS Code's own `code`
        // launcher uses the same switch).
        extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
      };
    }
    throw new Error(
      `no Kimi server runtime found: neither a dev checkout (${cliMain}) nor the bundled server (${bundledMain}) exists`,
    );
  }

  /**
   * Stage the packaged runtime into global storage (the extension dir must
   * stay untouched or VS Code flags the install as corrupted):
   *   <globalStorage>/kimi-server/main.cjs      — self-contained CLI bundle
   *   <globalStorage>/kimi-server/package.json  — host-root + version marker
   *   <globalStorage>/kimi-server/dist-web/     — the embedded web UI
   *   <globalStorage>/kimi-server/build/Release — node-pty natives lifted from
   *     VS Code's own install (the same copy the integrated terminal uses, so
   *     its ABI always matches the Electron we spawn).
   * Re-copies when the marker misses OR the staged content is stale (extension
   * version + file stats of main.cjs and dist-web/index.html). Returns the
   * staged main.cjs.
   */
  private async stagePackagedRuntime(): Promise<string> {
    const extServerDir = join(this.context.extensionUri.fsPath, 'server');
    const runDir = join(this.context.globalStorageUri.fsPath, 'kimi-server');
    const marker = join(runDir, '.version');
    const staged = await readFile(marker, 'utf8').catch(() => null);
    if (staged?.trim() !== (await this.stageMarkerValue(extServerDir))) {
      await rm(runDir, { recursive: true, force: true });
      await mkdir(runDir, { recursive: true });
      await cp(join(extServerDir, 'main.cjs'), join(runDir, 'main.cjs'));
      await cp(join(extServerDir, 'package.json'), join(runDir, 'package.json'));
      await cp(join(extServerDir, 'dist-web'), join(runDir, 'dist-web'), { recursive: true });
      await writeFile(marker, await this.stageMarkerValue(extServerDir), 'utf-8');
    }
    await this.stagePtyNatives(runDir);
    return join(runDir, 'main.cjs');
  }

  /** Marker identifying the staged content: extension version plus file stats
   *  of the payload, so re-packaging the same version (dev iteration) still
   *  triggers a re-stage. */
  private async stageMarkerValue(extServerDir: string): Promise<string> {
    const version = String(this.context.extension.packageJSON.version ?? '0.0.0');
    const mainStat = await stat(join(extServerDir, 'main.cjs'));
    const webStat = await stat(join(extServerDir, 'dist-web', 'index.html'));
    const statSuffix = (s: { size: number; mtimeMs: number }): string =>
      `${s.size}:${Math.round(s.mtimeMs)}`;
    return `${version}:${statSuffix(mainStat)}:${statSuffix(webStat)}`;
  }

  /** Copy node-pty's native payloads out of the local VS Code install. The
   *  server still starts when they are missing — its terminal feature just
   *  degrades (node-pty is loaded lazily), so failures are warnings only. */
  private async stagePtyNatives(runDir: string): Promise<void> {
    try {
      const targetDir = join(runDir, 'build', 'Release');
      if (existsSync(join(targetDir, 'pty.node'))) return;
      const srcDir = findVscodePtyNativesDir();
      if (srcDir === null) {
        this.output.appendLine(
          '[kimi-vscode] warning: node-pty not found in this VS Code install; terminal features will be unavailable',
        );
        return;
      }
      await mkdir(targetDir, { recursive: true });
      for (const file of await readdir(srcDir)) {
        await copyFile(join(srcDir, file), join(targetDir, file));
      }
      await chmod(join(targetDir, 'spawn-helper'), 0o755).catch(() => {
        // no spawn-helper on this platform (Windows ships console agents instead)
      });
      this.output.appendLine(`[kimi-vscode] staged node-pty natives from ${srcDir}`);
    } catch (error) {
      this.output.appendLine(`[kimi-vscode] warning: staging node-pty natives failed: ${String(error)}`);
    }
  }

  private async spawnAndWaitReady(): Promise<ServerHandle> {
    const { command, args, cwd, shell, extraEnv } = await this.resolveServerCommand();
    this.output.appendLine(`[kimi-vscode] starting server: ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      cwd,
      shell,
      env: {
        ...process.env,
        ...extraEnv,
        // Run as an additional instance: never collide with the user's own
        // daemon's single-instance lock; port clashes fall to the port+1 walk.
        KIMI_CODE_EXPERIMENTAL_MULTI_SERVER: '1',
      },
    });
    this.child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.output.append(chunk);
    });

    return new Promise<ServerHandle>((resolvePromise, rejectPromise) => {
      let settled = false;
      let buffer = '';
      const timer = setTimeout(() => {
        fail(new Error(`timed out after ${READY_TIMEOUT_MS}ms waiting for the Kimi server`));
      }, READY_TIMEOUT_MS);

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.kill();
        rejectPromise(error);
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        this.output.append(chunk);
        if (settled) return;
        buffer += chunk;
        const match = READY_LINE.exec(buffer);
        const origin = match?.[1];
        let token = match?.[2];
        if (origin === undefined) return;
        settled = true;
        clearTimeout(timer);
        void (async () => {
          token ??= await readServerToken();
          if (token === undefined) {
            rejectPromise(new Error('server started but its bearer token could not be resolved'));
            return;
          }
          await waitForHealthy(origin);
          resolvePromise({ origin, token });
        })().catch((error: unknown) => {
          rejectPromise(error instanceof Error ? error : new Error(String(error)));
        });
      });
      child.on('error', (error) => {
        fail(error);
      });
      child.on('exit', (code, signal) => {
        if (!settled) {
          fail(new Error(`server exited before ready (code ${code ?? 'null'}, signal ${signal ?? 'null'})`));
          return;
        }
        // The server died after it had become ready: forget it so the next
        // render spawns a fresh one (webview iframe shows its own error until
        // then; the "Kimi Code: Restart Server" command reconnects).
        this.output.appendLine(`[kimi-vscode] server exited (code ${code ?? 'null'})`);
        if (this.child === child) this.child = undefined;
        this.starting = undefined;
      });
    });
  }

  private kill(): void {
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    child.kill('SIGTERM');
    // Escalate if SIGTERM is ignored (e.g. wedged during bootstrap).
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
    });
  }

  dispose(): void {
    this.kill();
    this.restartEmitter.dispose();
    this.output.dispose();
  }
}

/**
 * Locate node-pty's native payload inside the local VS Code install (the same
 * copy the integrated terminal uses). Mirrors node-pty's own search order
 * (`build/Release`, `build/Debug`, `prebuilds/<platform>-<arch>`), plus the
 * `node_modules.asar.unpacked` layout used by some VS Code builds. Returns the
 * directory containing `pty.node`, or null when unavailable.
 */
function findVscodePtyNativesDir(): string | null {
  const packageRoots = [
    join(vscode.env.appRoot, 'node_modules', 'node-pty'),
    join(vscode.env.appRoot, 'node_modules.asar.unpacked', 'node_modules', 'node-pty'),
  ];
  const nativeDirs = [
    join('build', 'Release'),
    join('build', 'Debug'),
    join('prebuilds', `${process.platform}-${process.arch}`),
  ];
  for (const root of packageRoots) {
    for (const rel of nativeDirs) {
      const dir = join(root, rel);
      if (existsSync(join(dir, 'pty.node'))) return dir;
    }
  }
  return null;
}

/** Read `<KIMI_CODE_HOME>/server.token` (0600), as `kimi server run` does. */
async function readServerToken(): Promise<string | undefined> {
  try {
    const override = process.env['KIMI_CODE_HOME'];
    const home = override !== undefined && override.trim() !== '' ? override : join(homedir(), '.kimi-code');
    const token = await readFile(join(home, 'server.token'), 'utf8');
    return token.trim() === '' ? undefined : token.trim();
  } catch {
    return undefined;
  }
}

async function waitForHealthy(origin: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${origin}/api/v1/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`Kimi server at ${origin} did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
    }
    await new Promise((r) => {
      setTimeout(r, 200);
    });
  }
}

// ---------------------------------------------------------------------------
// Sidebar webview
// ---------------------------------------------------------------------------

const SHELL_STYLE = `<style>
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  .frame { border: none; width: 100%; height: 100%; display: block; }
  .msg { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-descriptionForeground); padding: 12px; line-height: 1.5; }
  .msg code { color: var(--vscode-textLink-foreground); }
</style>`;

function shellHtml(csp: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  ${SHELL_STYLE}
</head>
<body>${body}</body>
</html>`;
}

function messageHtml(text: string): string {
  return shellHtml(`default-src 'none'; style-src 'unsafe-inline'`, `<div class="msg">${text}</div>`);
}

function iframeHtml(handle: ServerHandle, folderRoots: string[]): string {
  // `?workspace=` pins the initial selection to the primary folder; the
  // repeatable `&folder=` params carry the full VS Code folder list in
  // workspace order — kimi-web's workspace hint (lib/workspaceHint.ts) then
  // focuses the UI on exactly those folders, in that order.
  const primary = folderRoots[0] ?? '';
  const folders = folderRoots.map((root) => `&folder=${encodeURIComponent(root)}`).join('');
  const src =
    `${handle.origin}/?workspace=${encodeURIComponent(primary)}${folders}` +
    `#token=${encodeURIComponent(handle.token)}`;
  // Color-theme bridge: VS Code theming does not propagate
  // `prefers-color-scheme` into the cross-origin iframe, so the extension
  // pushes its active theme kind as a postMessage and the shell forwards it
  // (into the iframe on receipt and on each iframe load). The web UI's
  // 'system' mode resolves against this host scheme.
  const originJson = JSON.stringify(handle.origin);
  const bridge = `<script>
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById('kimi-frame');
    let scheme = null;
    function forward() {
      if (scheme !== null && frame.contentWindow !== null) {
        frame.contentWindow.postMessage({ type: 'kimi-host-color-scheme', scheme }, ${originJson});
      }
    }
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data && data.type === 'kimi-host-color-scheme' && (data.scheme === 'dark' || data.scheme === 'light')) {
        scheme = data.scheme;
        forward();
      }
    });
    frame.addEventListener('load', forward);
    vscode.postMessage({ type: 'kimi-host-ready' });
  </script>`;
  return shellHtml(
    `default-src 'none'; frame-src ${handle.origin}; style-src 'unsafe-inline'; script-src 'unsafe-inline'`,
    `<iframe id="kimi-frame" class="frame" src="${escapeHtml(src)}" allow="clipboard-read; clipboard-write"></iframe>${bridge}`,
  );
}

/** Map VS Code's active color theme onto the web UI's light/dark scheme. */
function hostColorScheme(): 'dark' | 'light' {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
    ? 'dark'
    : 'light';
}

/** Push the current VS Code theme scheme down to the webview shell (it
 *  forwards it into the iframe that hosts the web UI). */
function postHostColorScheme(webview: vscode.Webview): void {
  // VS Code's Webview.postMessage takes no target origin (not a DOM postMessage).
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  void webview.postMessage({ type: 'kimi-host-color-scheme', scheme: hostColorScheme() });
}

class KimiViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly manager: ServerManager) {
    manager.onDidRestart(() => {
      if (this.view !== undefined) void this.render(this.view);
    });
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.view !== undefined) void this.render(this.view);
    });
    vscode.window.onDidChangeActiveColorTheme(() => {
      if (this.view !== undefined) postHostColorScheme(this.view.webview);
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    // The shell asks for the current scheme once loaded (covers reloads where
    // an earlier push would have landed before its listener existed).
    view.webview.onDidReceiveMessage((message: { type?: unknown }) => {
      if (message.type === 'kimi-host-ready') postHostColorScheme(view.webview);
    });
    void this.render(view);
  }

  /** Render the view: start the server, register the workspace, iframe the UI. */
  private async render(view: vscode.WebviewView): Promise<void> {
    // All folders of the (possibly multi-root) workspace, in VS Code order;
    // the first folder is the primary one.
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === 'file',
    );
    if (folders.length === 0) {
      view.webview.html = messageHtml('Open a folder to use Kimi Code.');
      return;
    }
    view.webview.html = messageHtml('Starting the Kimi server…');
    try {
      const handle = await this.manager.ensure();
      // Idempotent on root — makes the VS Code folders the web UI's
      // workspaces before the SPA first paints.
      const roots = folders.map((folder) => folder.uri.fsPath);
      for (const root of roots) {
        await this.manager.registerWorkspace(handle, root);
      }
      view.webview.html = iframeHtml(handle, roots);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.manager.output.appendLine(`[kimi-vscode] render failed: ${text}`);
      view.webview.html = messageHtml(
        `Failed to start the Kimi server: ${escapeHtml(text)}<br>` +
          `Run <code>Kimi Code: Restart Server</code> to retry.`,
      );
      const choice = await vscode.window.showErrorMessage(`Kimi Code: ${text}`, 'Retry');
      if (choice === 'Retry') await vscode.commands.executeCommand('kimi-vscode.restart');
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

let manager: ServerManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  manager = new ServerManager(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, new KimiViewProvider(manager), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('kimi-vscode.restart', () => manager?.restart()),
    manager,
  );
}

export function deactivate(): void {
  manager?.dispose();
  manager = undefined;
}
