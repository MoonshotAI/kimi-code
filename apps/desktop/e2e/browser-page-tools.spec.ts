import { join } from 'node:path';

import { browserMenu, browserSection, chooseOverlayItem, detailPanel, expect, goTo, pageAt, recordFindResults, test } from './fixtures/browser';
import { answerNativeDialog } from './fixtures/native-dialog';

test('find, zoom, device emulation and a page screenshot work on a loaded page', async ({ app, sites, scratch }) => {
  const home = sites.harbor.url('/home');
  const browser = () => browserSection(app);
  const findBox = () => browser().getByRole('searchbox', { name: 'Find in page' });
  const pixelRatio = async () => (await pageAt(app, home)).evaluate(() => devicePixelRatio);
  const viewport = async () => (await pageAt(app, home)).evaluate(() => ({ width: innerWidth, height: innerHeight, mobile: /Pixel 8/.test(navigator.userAgent) }));
  let findResults: () => Promise<Array<{ matches: number; active: number }>> = async () => [];

  await test.step('the harbor page loads in a Browser tab', async () => {
    await app.window.getByRole('button', { name: 'Open right panel' }).click();
    await app.window.getByRole('group', { name: 'Quick open' }).getByRole('button', { name: /Browser/ }).click();
    await goTo(app, home);
    await expect(detailPanel(app).getByRole('tab', { name: 'Harbor Home' })).toBeVisible();
    await expect((await pageAt(app, home)).getByRole('heading', { name: 'Harbor Home' })).toBeVisible();
    findResults = await recordFindResults(app, home);
  });

  await test.step('find in page counts the matches and steps through them both ways', async () => {
    await browserMenu(app);
    await chooseOverlayItem(app, 'Find in page');
    await expect(findBox()).toBeVisible();
    await findBox().fill('tide');
    await expect.poll(async () => (await findResults()).at(-1)).toEqual({ matches: 6, active: 1 });
    await findBox().press('Enter');
    await expect.poll(async () => (await findResults()).at(-1)).toEqual({ matches: 6, active: 2 });
    await browser().getByRole('button', { name: 'Next match' }).click();
    await expect.poll(async () => (await findResults()).at(-1)).toEqual({ matches: 6, active: 3 });
    await browser().getByRole('button', { name: 'Next match' }).click();
    await expect.poll(async () => (await findResults()).at(-1)).toEqual({ matches: 6, active: 4 });
    await browser().getByRole('button', { name: 'Previous match' }).click();
    await expect.poll(async () => (await findResults()).at(-1)).toEqual({ matches: 6, active: 3 });
    await findBox().fill('harbor log');
    await findBox().press('Enter');
    await expect.poll(async () => (await findResults()).at(-1)).toEqual({ matches: 1, active: 1 });
    await app.snapshot('find-harbor-log');
    await browser().getByRole('button', { name: 'Close find' }).click();
    await expect(findBox()).toBeHidden();
  });

  await test.step('zoom in, out and reset update the menu value and the page zoom', async () => {
    const overlay = await browserMenu(app);
    const zoom = overlay.getByRole('group', { name: 'Zoom' });
    await expect(zoom).toContainText('100%');
    await expect(zoom.getByRole('button', { name: 'Reset zoom' })).toBeDisabled();
    const baseRatio = await pixelRatio();
    const pageZoom = async () => (await pixelRatio()) / baseRatio;
    await zoom.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom).toContainText('110%');
    await expect.poll(pageZoom).toBeCloseTo(1.1, 2);
    await zoom.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom).toContainText('125%');
    await app.snapshot('zoomed-to-125');
    await zoom.getByRole('button', { name: 'Zoom out' }).click();
    await zoom.getByRole('button', { name: 'Zoom out' }).click();
    await zoom.getByRole('button', { name: 'Zoom out' }).click();
    await expect(zoom).toContainText('90%');
    await expect.poll(pageZoom).toBeCloseTo(0.9, 2);
    await zoom.getByRole('button', { name: 'Reset zoom' }).click();
    await expect(zoom).toContainText('100%');
    await expect.poll(pageZoom).toBeCloseTo(1, 2);
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByRole('menu')).toBeHidden();
  });

  await test.step('the device toolbar emulates a phone preset and rotates it', async () => {
    const desktop = await viewport();
    expect(desktop.mobile).toBe(false);
    await browserMenu(app);
    await chooseOverlayItem(app, 'Show device toolbar', 'menuitemradio');
    const width = browser().getByRole('spinbutton', { name: 'Viewport width' }).or(browser().getByRole('textbox', { name: 'Viewport width' }));
    await expect(width).toHaveValue('393');
    await expect.poll(async () => (await viewport()).width).toBe(393);

    await app.window.getByTestId('browser-device-profile').click();
    await chooseOverlayItem(app, /^Pixel 8/, 'menuitemradio');
    await expect(app.window.getByTestId('browser-device-profile')).toHaveText('Pixel 8');
    await expect.poll(viewport).toEqual({ width: 412, height: 915, mobile: true });
    await app.snapshot('pixel-8-portrait');

    await browser().getByRole('button', { name: 'Rotate device' }).click();
    await expect.poll(viewport).toEqual({ width: 915, height: 412, mobile: true });
    await app.snapshot('pixel-8-landscape');

    await browser().getByRole('button', { name: 'Hide device toolbar' }).click();
    await expect(app.window.getByTestId('browser-device-profile')).toBeHidden();
    await expect.poll(viewport).toEqual(desktop);
  });

  await test.step('a page screenshot is saved where the save dialog points', async () => {
    const target = join(scratch, 'harbor-shot.png');
    await answerNativeDialog(app, 'showSaveDialog', { canceled: false, filePath: target });
    await browserMenu(app);
    await chooseOverlayItem(app, 'Take a screenshot');
    const { width } = await viewport();
    const readShot = () => app.electron.evaluate(({ nativeImage }, path) => {
      const shot = nativeImage.createFromPath(path);
      const { width, height } = shot.getSize();
      const bitmap = shot.toBitmap();
      return { width, height, corner: [bitmap[2], bitmap[1], bitmap[0]] };
    }, target);
    await expect.poll(async () => {
      const shot = await readShot();
      return shot.width >= width && shot.height > 200;
    }).toBe(true);
    const image = await readShot();
    expect(image.width).toBeGreaterThanOrEqual(width);
    expect(image.height).toBeGreaterThan(200);
    expect(image.corner).toEqual([0xfb, 0xfa, 0xf6]);
  });
});

async function openFindBar(app: Parameters<typeof browserSection>[0], home: string) {
  await app.window.getByRole('button', { name: 'Open right panel' }).click();
  await app.window.getByRole('group', { name: 'Quick open' }).getByRole('button', { name: /Browser/ }).click();
  await goTo(app, home);
  await expect((await pageAt(app, home)).getByRole('heading', { name: 'Harbor Home' })).toBeVisible();
  const findResults = await recordFindResults(app, home);
  await browserMenu(app);
  await chooseOverlayItem(app, 'Find in page');
  return { findResults, findBox: browserSection(app).getByRole('searchbox', { name: 'Find in page' }) };
}

test('typing in the find bar searches live', async ({ app, sites }) => {
  const { findResults, findBox } = await openFindBar(app, sites.harbor.url('/home'));
  await findBox.pressSequentially('tide');
  await expect.poll(async () => (await findResults()).at(-1)).toEqual({ matches: 6, active: 1 });
});

test('Previous moves back to the earlier match', async ({ app, sites }) => {
  const { findResults, findBox } = await openFindBar(app, sites.harbor.url('/home'));
  await findBox.fill('tide');
  await expect.poll(async () => (await findResults()).at(-1)).toEqual({ matches: 6, active: 1 });
  await findBox.press('Enter');
  await expect.poll(async () => (await findResults()).at(-1)).toEqual({ matches: 6, active: 2 });
  await browserSection(app).getByRole('button', { name: 'Previous match' }).click();
  await expect.poll(async () => (await findResults()).at(-1)).toEqual({ matches: 6, active: 1 });
});
