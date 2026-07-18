let node_fs = require("node:fs");
let node_path = require("node:path");
let electron = require("electron");
let node_child_process = require("node:child_process");
let node_os = require("node:os");
//#region src/main/ensure-server.ts
/** Overall budget for the bundled `kimi server run` to finish ensuring a daemon. */
const RUN_TIMEOUT_MS = 3e4;
/** How long to keep polling `/healthz` before declaring the daemon unhealthy. */
const HEALTH_TIMEOUT_MS = 2e4;
const HEALTH_POLL_MS = 200;
/** `<KIMI_CODE_HOME>` or `~/.kimi-code` — must match the server's `resolveKimiHome`. */
function kimiHome() {
	const override = process.env["KIMI_CODE_HOME"];
	if (override !== void 0 && override.trim().length > 0) return override;
	return (0, node_path.join)((0, node_os.homedir)(), ".kimi-code");
}
function lockPath() {
	return (0, node_path.join)(kimiHome(), "server", "lock");
}
/** Background daemon log written by the SEA — surfaced in the error screen / menu. */
function serverLogPath() {
	return (0, node_path.join)(kimiHome(), "server", "server.log");
}
function readLock() {
	try {
		const parsed = JSON.parse((0, node_fs.readFileSync)(lockPath(), "utf-8"));
		if (typeof parsed.port === "number" && typeof parsed.pid === "number") return {
			pid: parsed.pid,
			port: parsed.port,
			host: typeof parsed.host === "string" ? parsed.host : void 0
		};
		return null;
	} catch {
		return null;
	}
}
function originFromLock(lock) {
	return `http://${lock.host !== void 0 && lock.host !== "0.0.0.0" ? lock.host : "127.0.0.1"}:${lock.port}`;
}
async function isHealthy(origin, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, timeoutMs);
	try {
		const res = await fetch(`${origin}/api/v1/healthz`, { signal: controller.signal });
		if (!res.ok) return false;
		return (await res.json()).code === 0;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
/**
* Run the bundled SEA's `server run`, which reuses a live shared daemon or
* spawns one and exits once it is healthy. All discovery / port / lock logic
* lives in apps/kimi-code's `ensureDaemon`; we do not reimplement it.
*/
function runServerRun(seaPath) {
	return new Promise((resolve, reject) => {
		(0, node_child_process.execFile)(seaPath, [
			"server",
			"run",
			"--log-level",
			"error"
		], { timeout: RUN_TIMEOUT_MS }, (error, _stdout, stderr) => {
			if (error) {
				reject(new Error(`kimi server run failed: ${error.message}\n${stderr}`.trim()));
				return;
			}
			resolve();
		});
	});
}
/**
* Ensure the shared kimi-code daemon is running and return its origin.
*
* The desktop app participates in the same local-server ecosystem as the CLI,
* the browser and the TUI: it reuses a running daemon or starts one that the
* others can reuse — never a private, app-only server.
*/
async function ensureServer(seaPath) {
	await runServerRun(seaPath);
	const lock = readLock();
	if (lock === null) throw new Error(`Kimi server lock not found at ${lockPath()} after starting the server.`);
	const origin = originFromLock(lock);
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await isHealthy(origin, 500)) return { origin };
		await new Promise((resolve) => {
			setTimeout(resolve, HEALTH_POLL_MS);
		});
	}
	throw new Error(`Kimi server at ${origin} did not become healthy within ${HEALTH_TIMEOUT_MS}ms.`);
}
//#endregion
//#region src/main/sea-path.ts
const SUPPORTED_TARGETS = new Set([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-arm64",
	"win32-x64"
]);
/** `<platform>-<arch>` triple for the current process, validated against the SEA targets. */
function currentTarget() {
	const target = `${process.platform}-${process.arch}`;
	if (!SUPPORTED_TARGETS.has(target)) throw new Error(`No bundled Kimi server for this platform: ${target}`);
	return target;
}
function executableName() {
	return process.platform === "win32" ? "kimi.exe" : "kimi";
}
/**
* Absolute path to the bundled SEA backend executable.
*
* - packaged: `<resources>/bin/<target>/kimi[.exe]` — placed there by
*   electron-builder `extraResources`.
* - dev: `apps/kimi-code/dist-native/bin/<target>/kimi[.exe]` — produced by
*   `pnpm -C apps/kimi-code build:native:sea`. In dev `app.getAppPath()` is
*   `apps/kimi-desktop`, so the sibling app is one level up.
*/
function resolveSeaPath() {
	const target = currentTarget();
	const exe = executableName();
	if (electron.app.isPackaged) return (0, node_path.join)(process.resourcesPath, "bin", target, exe);
	return (0, node_path.join)(electron.app.getAppPath(), "..", "kimi-code", "dist-native", "bin", target, exe);
}
//#endregion
//#region src/main/index.ts
let mainWindow = null;
/** Guard against concurrent connect() calls on the same window. When the user
*  clicks “重试连接” while a previous connect is still in flight (ensureServer
*  can take several seconds), two concurrent connect() flows would race to
*  loadURL, causing visual flicker and a potential mixed-content flash. */
let connecting = false;
const DEFAULT_BOUNDS = {
	width: 1280,
	height: 860
};
function stateFile() {
	return (0, node_path.join)(electron.app.getPath("userData"), "window-state.json");
}
function loadBounds() {
	try {
		const parsed = JSON.parse((0, node_fs.readFileSync)(stateFile(), "utf-8"));
		if (typeof parsed.width === "number" && typeof parsed.height === "number") return {
			width: parsed.width,
			height: parsed.height,
			x: typeof parsed.x === "number" ? parsed.x : void 0,
			y: typeof parsed.y === "number" ? parsed.y : void 0
		};
	} catch {}
	return DEFAULT_BOUNDS;
}
function saveBounds(win) {
	try {
		const bounds = win.getBounds();
		(0, node_fs.mkdirSync)((0, node_path.dirname)(stateFile()), { recursive: true });
		(0, node_fs.writeFileSync)(stateFile(), JSON.stringify({
			width: bounds.width,
			height: bounds.height,
			x: bounds.x,
			y: bounds.y
		}));
	} catch {}
}
function dataUrl(html) {
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
const SCREEN_STYLE = `
  <style>
    html, body { height: 100%; margin: 0; }
    body {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 18px; background: #0b0b0c; color: #e7e7ea; font: 14px/1.5 system-ui, sans-serif;
      -webkit-user-select: none; user-select: none; text-align: center; padding: 0 32px;
    }
    .spinner {
      width: 34px; height: 34px; border-radius: 50%;
      border: 3px solid #2a2a2e; border-top-color: #7c8cff; animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 15px; font-weight: 600; margin: 0; }
    p { margin: 0; color: #9a9aa2; max-width: 560px; }
    code { color: #c8c8d0; word-break: break-all; }
  </style>
`;
function loadingHtml() {
	return `<!doctype html><meta charset="utf-8">${SCREEN_STYLE}
    <div class="spinner"></div>
    <h1>正在启动 Kimi 本地服务…</h1>
    <p>首次启动可能需要几秒。</p>`;
}
function errorHtml(message) {
	return `<!doctype html><meta charset="utf-8">${SCREEN_STYLE}
    <h1>无法启动本地服务</h1>
    <p>${message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>
    <p>查看日志：<code>${serverLogPath().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code></p>
    <p>菜单 → Kimi Code Desktop → 重试连接，或先检查日志。</p>`;
}
/** On-disk filename of the daemon's persistent bearer token (under KIMI_CODE_HOME). */
const SERVER_TOKEN_FILE = "server.token";
/**
* Read the daemon's bearer token so the web UI can authenticate without showing
* the manual token dialog on a fresh launch. Returns undefined when the token
* cannot be read (the web UI then falls back to the dialog).
*/
function readServerToken() {
	try {
		const token = (0, node_fs.readFileSync)((0, node_path.join)(kimiHome(), SERVER_TOKEN_FILE), "utf-8").trim();
		return token.length > 0 ? token : void 0;
	} catch {
		return;
	}
}
async function connect(win) {
	if (connecting) return;
	connecting = true;
	try {
		await win.loadURL(dataUrl(loadingHtml()));
		const { origin } = await ensureServer(resolveSeaPath());
		process.stdout.write(`[kimi-desktop] connected to ${origin}\n`);
		if (!win.isDestroyed()) {
			const token = readServerToken();
			const fragment = token === void 0 ? "" : `#token=${encodeURIComponent(token)}`;
			await win.loadURL(`${origin}/?kimi_desktop=1&platform=${process.platform}${fragment}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[kimi-desktop] ensureServer failed: ${message}\n`);
		if (!win.isDestroyed()) await win.loadURL(dataUrl(errorHtml(message)));
	} finally {
		connecting = false;
	}
}
function createWindow() {
	const win = new electron.BrowserWindow({
		...loadBounds(),
		minWidth: 720,
		minHeight: 480,
		backgroundColor: "#0b0b0c",
		title: "Kimi Code Desktop",
		titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
		trafficLightPosition: {
			x: 16,
			y: 18
		},
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false
		}
	});
	mainWindow = win;
	win.webContents.on("page-title-updated", (event) => {
		event.preventDefault();
	});
	if (process.platform === "darwin") {
		const showTrafficLights = () => {
			if (win.isDestroyed()) return;
			win.setWindowButtonPosition({
				x: 16,
				y: 18
			});
			win.setWindowButtonVisibility(true);
		};
		win.on("enter-full-screen", showTrafficLights);
		win.on("leave-full-screen", showTrafficLights);
		win.on("focus", showTrafficLights);
		const THEME_TAG = "__kimi_desktop_theme__:";
		win.webContents.on("console-message", (_event, _level, message) => {
			if (!message.startsWith(THEME_TAG)) return;
			const scheme = message.slice(23);
			if (scheme === "light" || scheme === "dark" || scheme === "system") electron.nativeTheme.themeSource = scheme;
		});
		win.webContents.on("did-finish-load", () => {
			win.webContents.executeJavaScript(`(() => {
            const report = () => {
              const v = document.documentElement.dataset.colorScheme;
              console.info(${JSON.stringify(THEME_TAG)} + (v === 'light' || v === 'dark' ? v : 'system'));
            };
            new MutationObserver(report).observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['data-color-scheme'],
            });
            report();
          })();`).catch(() => {});
		});
	}
	win.on("close", () => {
		saveBounds(win);
	});
	win.on("closed", () => {
		if (mainWindow === win) mainWindow = null;
	});
	connect(win);
}
function buildMenu() {
	const isMac = process.platform === "darwin";
	const template = [
		{
			label: "Kimi Code Desktop",
			submenu: [
				...isMac ? [{ role: "about" }, { type: "separator" }] : [],
				{
					label: "重试连接",
					click: () => {
						if (mainWindow !== null) connect(mainWindow);
						else createWindow();
					}
				},
				{
					label: "打开服务日志",
					click: () => {
						electron.shell.openPath(serverLogPath());
					}
				},
				{ type: "separator" },
				isMac ? { role: "quit" } : { role: "close" }
			]
		},
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" }
			]
		},
		{ role: "windowMenu" }
	];
	electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
function main() {
	electron.app.on("window-all-closed", () => {
		if (process.platform !== "darwin") electron.app.quit();
	});
	electron.app.whenReady().then(() => {
		buildMenu();
		createWindow();
		electron.app.on("activate", () => {
			if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
		});
	});
}
main();
//#endregion
