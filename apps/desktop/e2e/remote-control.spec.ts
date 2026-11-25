import { expect, test } from './fixtures/app';
import { closeSettings, openSettings } from './fixtures/settings';

test('Remote Control restore preference is independent and survives a relaunch', async ({ app }) => {
  let dialog = await openSettings(app.window, 'Devices');
  const remoteControl = dialog.getByRole('switch', { name: 'Turn on Remote Control', exact: true });
  const restore = dialog.getByRole('switch', { name: 'Keep on after restart', exact: true });

  await expect(remoteControl).toHaveAttribute('aria-checked', 'false');
  await expect(restore).toHaveAttribute('aria-checked', 'false');
  await restore.click();
  await expect(restore).toHaveAttribute('aria-checked', 'true');
  await expect(remoteControl).toHaveAttribute('aria-checked', 'false');
  await app.snapshot('remote-control-restore-en');

  const defaultDialogWidth = (await dialog.boundingBox())!.width;
  await app.electron.evaluate(({ BaseWindow }) => {
    const main = BaseWindow.getAllWindows().find(win =>
      /^app:\/\/renderer\/(?!(browser-overlay|browser-control|screenshot|pin)\b)/.test(
        (win as Electron.BrowserWindow).webContents?.getURL() ?? '',
      ),
    );
    main?.setSize(900, 900);
  });
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBeLessThan(defaultDialogWidth);
  const minimumDialogWidth = (await dialog.boundingBox())!.width;
  const expectedDialogWidth = await app.window.evaluate(() => Math.round(window.innerWidth * 0.96));
  expect(Math.round(minimumDialogWidth)).toBeLessThanOrEqual(expectedDialogWidth);
  await app.snapshot('remote-control-restore-minimum-en');

  await closeSettings(app.window);
  await app.relaunch();
  dialog = await openSettings(app.window, 'Devices');
  await expect(
    dialog.getByRole('switch', { name: 'Keep on after restart', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(
    dialog.getByRole('switch', { name: 'Turn on Remote Control', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');

  await dialog.getByRole('tab', { name: 'General', exact: true }).click();
  await dialog.getByRole('tab', { name: '简体中文', exact: true }).click();
  await dialog.getByRole('tab', { name: '设备', exact: true }).click();
  await expect(
    dialog.getByRole('switch', { name: '重启后保持开启', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(
    dialog.getByRole('switch', { name: '开启远程控制', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  await app.snapshot('remote-control-restore-zh');
});
