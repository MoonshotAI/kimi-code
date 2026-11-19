const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await window.loadFile(process.argv[2]);
  const png = await window.webContents.executeJavaScript(`(async () => {
    const image = document.querySelector('img');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas.toDataURL('image/png');
  })()`);
  process.stdout.write(JSON.stringify({ png }));
  app.exit(0);
}).catch((error) => {
  process.stderr.write(String(error));
  app.exit(1);
});
