const quiet = process.argv.includes('--quiet');
const inactive = process.argv.includes('--inactive');
if (quiet) {
  process.env.KIMI_DESKTOP_E2E = 'quiet';
  require('../fixtures/main-shim.cjs');
}
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const open = () => new BrowserWindow({ width: 320, height: 200, show: false });
  if (quiet || inactive) open().showInactive();
  if (quiet || !inactive) {
    const win = open();
    win.once('show', () => {
      app.focus({ steal: true });
      win.focus();
    });
    win.show();
  }
  setTimeout(() => app.quit(), 3000);
});
