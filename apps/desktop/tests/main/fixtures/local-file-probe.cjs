const path = require('node:path');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, session } = require('electron');

const [probeDir, guardModule] = process.argv.slice(2);
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'local-file-probe-')));
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('local file probe timed out'); app.exit(1); }, 60_000);

async function probe(browserSession) {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.LOCAL_FILE_PROBE_CONSOLE) win.webContents.on('console-message', (event) => console.error(`console: ${event.message}`));
  await win.loadURL(pathToFileURL(path.join(probeDir, 'site', 'index.html')).href);
  const report = await win.webContents.executeJavaScript('window.__probe');
  win.destroy();
  return report;
}

function guarded(partition, extraPrivileges) {
  const browserSession = session.fromPartition(partition);
  if (guardModule) require(guardModule).installFileReadFallbackGuard(browserSession, () => extraPrivileges);
  return browserSession;
}

app.whenReady().then(async () => {
  const browser = await probe(guarded('probe-browser', true));
  const unprivileged = await probe(guarded('probe-unprivileged', false));
  const other = await probe(session.fromPartition('probe-other'));
  process.stdout.write(`${JSON.stringify({ browser, unprivileged, other: { fetch: other.channels.fetch } })}\n`);
  clearTimeout(timeout);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
