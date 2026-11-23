import { writeFile } from 'node:fs/promises';
import type { TestInfo } from '@playwright/test';
import { expect, test, type DesktopApp } from './fixtures/app';

type Platform = 'darwin' | 'linux';
type UpdateState = 'downloaded' | 'downloading';
type Branch = 'release/2026-11-04' | 'main';

const BASE_WIDTHS = [360, 320, 304, 300, 268, 250, 240, 230, 220];
const LONG_BRANCH: Branch = 'release/2026-11-04';

async function setChannel(app: DesktopApp, enabled: boolean): Promise<void> {
  await app.electron.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler('kimi:canary-get-info');
    ipcMain.handle('kimi:canary-get-info', () => ({
      enabled: value,
      isCanaryBuild: value,
      isRealCanaryBuild: false,
    }));
  }, enabled);
}

async function setPlatform(app: DesktopApp, platform: Platform): Promise<void> {
  await app.window.evaluate(value => {
    const url = new URL(window.location.href);
    url.searchParams.set('platform', value);
    if (value === 'linux') url.searchParams.set('kimi_native_titlebar', '1');
    else url.searchParams.delete('kimi_native_titlebar');
    window.history.replaceState(null, '', url);
    window.sessionStorage.setItem('kimi-desktop-platform', value);
    window.sessionStorage.setItem('kimi-native-titlebar', value === 'linux' ? '1' : '0');
  }, platform);
  await app.window.reload();
  await expect(app.window.locator('.side .ch')).toBeVisible();
}

async function setUpdate(app: DesktopApp, state: UpdateState): Promise<void> {
  await app.electron.evaluate(({ webContents }, value) => {
    for (const contents of webContents.getAllWebContents()) {
      contents.send('kimi:update-status', {
        state: value,
        version: '9.9.9-canary.1',
        ...(value === 'downloading' ? { percent: 82 } : {}),
      });
    }
  }, state);
  await expect(app.window.locator('.upd-pill')).toBeVisible();
}

async function setBranch(app: DesktopApp, branch: Branch): Promise<void> {
  await app.window.locator('.dbg-pill').evaluate((button, value) => {
    button.setAttribute('aria-label', value);
    button.setAttribute('title', value);
    const text = button.querySelector('.dbg-pill-text');
    if (text !== null) text.textContent = value;
  }, branch);
}

async function setWidth(app: DesktopApp, width: number): Promise<void> {
  await app.window.locator('.side').evaluate((side, value) => {
    side.classList.add('no-anim');
    side.style.width = `${value}px`;
    const col = side.querySelector<HTMLElement>('.col');
    if (col !== null) col.style.width = `${value}px`;
  }, width);
}

async function capture(app: DesktopApp, testInfo: TestInfo, name: string): Promise<void> {
  await app.window.screenshot({ path: testInfo.outputPath(`${name}-full.png`) });
  const probe = await app.window.evaluate(() => new Promise(resolve => {
    const started = performance.now();
    const rects: string[] = [];
    const header = document.querySelector('.side .ch');
    const report = (timedOut: boolean) => resolve({ timedOut, frames: rects.length, rects, ms: Math.round(performance.now() - started), visibility: document.visibilityState, focus: document.hasFocus(), animations: document.getAnimations().map(animation => `${animation.constructor.name}:${(animation as CSSAnimation).animationName ?? ''}:${animation.playState}:${(animation.effect as KeyframeEffect | null)?.target instanceof Element ? ((animation.effect as KeyframeEffect).target as Element).className : ''}`) });
    const tick = () => {
      const box = header?.getBoundingClientRect();
      rects.push(box === undefined ? 'none' : `${box.x},${box.y},${box.width},${box.height}`);
      if (rects.length < 5) requestAnimationFrame(tick);
      else report(false);
    };
    requestAnimationFrame(tick);
    setTimeout(() => report(true), 3000);
  }));
  const windows = await app.electron.evaluate(({ BaseWindow, webContents }) => ({
    windows: BaseWindow.getAllWindows().map(win => ({ id: win.id, visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), bounds: win.getBounds() })),
    contents: webContents.getAllWebContents().map(contents => ({ type: contents.getType(), throttling: contents.getBackgroundThrottling(), painting: contents.isPainting(), url: contents.getURL().slice(0, 50) })),
  }));
  process.stderr.write(`[diag] ${name} ${JSON.stringify(probe)} ${JSON.stringify(windows)}\n`);
  await app.window.locator('.side .ch').screenshot({ path: testInfo.outputPath(`${name}-topbar.png`), timeout: 10_000 }).catch((error: unknown) => {
    process.stderr.write(`[diag] ${name} topbar screenshot failed: ${String(error).split('\n').slice(0, 6).join(' | ')}\n`);
    throw error;
  });
}

async function assertLayout(app: DesktopApp, canary: boolean, state: UpdateState, branch: Branch = LONG_BRANCH) {
  const layout = await app.window.locator('.side .ch').evaluate(header => {
    const rect = (selector: string) => {
      const element = header.querySelector<HTMLElement>(selector);
      if (element === null || getComputedStyle(element).display === 'none') return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const style = getComputedStyle(header);
    const display = (selector: string) => {
      const element = header.querySelector<HTMLElement>(selector);
      return element === null ? null : getComputedStyle(element).display;
    };
    const box = header.getBoundingClientRect();
    const paddingLeft = Number.parseFloat(style.paddingLeft);
    const paddingRight = Number.parseFloat(style.paddingRight);
    return {
      contentWidth: header.clientWidth - paddingLeft - paddingRight,
      contentLeft: box.left + paddingLeft,
      contentRight: box.right - paddingRight,
      headerWidth: header.clientWidth,
      scrollWidth: header.scrollWidth,
      headerHeight: header.clientHeight,
      scrollHeight: header.scrollHeight,
      tail: rect('.ch-tail'),
      debug: rect('.dbg-pill'),
      update: rect('.upd-pill'),
      debugText: display('.dbg-pill-text'),
      updateFull: display('.upd-pill-text-full'),
      updateShort: display('.upd-pill-text-short'),
      updateFullText: header.querySelector('.upd-pill-text-full')?.textContent?.trim() ?? '',
      updateShortText: header.querySelector('.upd-pill-text-short')?.textContent?.trim() ?? '',
      updateAria: header.querySelector('.upd-pill')?.getAttribute('aria-label') ?? '',
      updateCanary: header.querySelector('.upd')?.classList.contains('upd--canary') ?? false,
      debugAria: header.querySelector('.dbg-pill')?.getAttribute('aria-label') ?? '',
      state: header.querySelector('.upd')?.getAttribute('data-state') ?? '',
    };
  });

  expect(layout.state).toBe(state);
  expect(layout.tail).not.toBeNull();
  expect(layout.update).not.toBeNull();
  expect(layout.tail!.left).toBeGreaterThanOrEqual(layout.contentLeft - 0.5);
  expect(layout.tail!.right).toBeLessThanOrEqual(layout.contentRight + 0.5);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.headerWidth + 1);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.headerHeight + 1);
  expect(layout.updateAria.length).toBeGreaterThan(0);

  if (canary) {
    expect(layout.debug).not.toBeNull();
    expect(layout.debugAria).toBe(branch);
    expect(layout.debug!.right).toBeLessThanOrEqual(layout.update!.left + 0.5);
    expect(layout.debugText === 'none').toBe(layout.contentWidth <= 300);
    const expectedUpdateMode = state === 'downloading'
      ? layout.contentWidth <= 250 ? 'short' : 'full'
      : layout.contentWidth <= 230 ? 'icon' : layout.contentWidth <= 250 ? 'short' : 'full';
    expect(layout.updateFull === 'none').toBe(expectedUpdateMode !== 'full');
    expect(layout.updateShort === 'none').toBe(expectedUpdateMode !== 'short');
  } else {
    expect(layout.debug).toBeNull();
    const expectedUpdateMode = layout.contentWidth <= 190 ? 'icon' : layout.contentWidth <= 210 ? 'short' : 'full';
    expect(layout.updateFull === 'none', JSON.stringify(layout)).toBe(expectedUpdateMode !== 'full');
    expect(layout.updateShort === 'none', JSON.stringify(layout)).toBe(expectedUpdateMode !== 'short');
  }
  return layout;
}

function matrixWidths(platform: Platform, canary: boolean): number[] {
  const padding = platform === 'darwin' ? 92 : 24;
  const thresholds = canary ? [230, 250, 300] : [190, 210];
  return [...new Set([
    ...BASE_WIDTHS,
    ...thresholds.flatMap(threshold => [threshold + padding - 1, threshold + padding, threshold + padding + 1]),
  ])].sort((a, b) => b - a);
}

test.describe('Canary sidebar top bar', () => {
  test.use({ appEnv: { KIMI_DESKTOP_CANARY: 'true' } });

  test('qer Mac long-branch scenarios keep both pills inside the usable header', async ({ app }, testInfo) => {
    await setChannel(app, true);
    await setPlatform(app, 'darwin');
    let failure: unknown;
    for (const state of ['downloaded', 'downloading'] as const) {
      await setUpdate(app, state);
      await setBranch(app, LONG_BRANCH);
      await setWidth(app, 304);
      await capture(app, testInfo, `qer-mac-canary-${state}-304`);
      try {
        const layout = await assertLayout(app, true, state);
        if (state === 'downloading') {
          expect(layout.debugText).toBe('none');
          expect(layout.updateShort).not.toBe('none');
          expect(layout.updateShortText).toBe('82%');
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  });

  test('long and short branches fit every content-width breakpoint and remain clickable', async ({ app }, testInfo) => {
    await setChannel(app, true);
    const rows: Array<Record<string, unknown>> = [];
    for (const platform of ['darwin', 'linux'] as const) {
      await setPlatform(app, platform);
      for (const state of ['downloaded', 'downloading'] as const) {
        await setUpdate(app, state);
        const branches: Branch[] = [LONG_BRANCH, 'main'];
        for (const branch of branches) {
          await setBranch(app, branch);
          for (const width of matrixWidths(platform, true)) {
            await setWidth(app, width);
            const layout = await assertLayout(app, true, state, branch);
            rows.push({ ...layout, platform, state, branch, width });
            if ((branch === LONG_BRANCH && (width === 304 || width === 220 || (width === 360 && state === 'downloaded')))
              || (branch === 'main' && width === 360 && state === 'downloaded')) {
              await capture(app, testInfo, `${platform}-canary-${state}-${branch}-${width}`);
            }
          }
        }
      }
    }

    await setPlatform(app, 'darwin');
    await setUpdate(app, 'downloaded');
    await setBranch(app, LONG_BRANCH);
    await setWidth(app, 220);
    await app.window.locator('.dbg-pill').click();
    await expect(app.window.locator('.dbg-menu')).toBeVisible();
    await capture(app, testInfo, 'darwin-canary-downloaded-220-debug-menu');
    await app.window.locator('.dbg-pill').click();
    await expect(app.window.locator('.dbg-menu')).toHaveCount(0);
    await app.window.locator('.upd-pill').click();
    await expect(app.window.locator('.ui-dialog')).toBeVisible();
    await capture(app, testInfo, 'darwin-canary-downloaded-220-update-dialog');
    await app.window.getByRole('button', { name: 'Later', exact: true }).click();
    await expect(app.window.locator('.ui-dialog')).toHaveCount(0);
    const updateLabel = await app.window.locator('.upd-pill').getAttribute('aria-label');
    await app.window.locator('.upd-pill').hover();
    await expect(app.window.getByRole('tooltip')).toHaveText(updateLabel!);
    await writeFile(testInfo.outputPath('canary-matrix.json'), JSON.stringify({
      scenarios: rows,
      interactions: { debugMenuAt220: true, updateDialogAt220: true, updateTooltip: true },
    }, null, 2));
  });
});

test('stable sidebar top bar preserves the yellow pill at every native layout breakpoint', async ({ app }, testInfo) => {
  await setChannel(app, false);
  const rows: Array<Record<string, unknown>> = [];
  for (const platform of ['darwin', 'linux'] as const) {
    await setPlatform(app, platform);
    for (const state of ['downloaded', 'downloading'] as const) {
      await setUpdate(app, state);
      for (const width of matrixWidths(platform, false)) {
        await setWidth(app, width);
        const layout = await assertLayout(app, false, state);
        rows.push({ ...layout, platform, state, width });
        if (width === 304 || width === 220 || (width === 360 && state === 'downloaded')) {
          await capture(app, testInfo, `${platform}-stable-${state}-${width}`);
        }
      }
    }
  }

  await setPlatform(app, 'linux');
  await setUpdate(app, 'downloaded');
  await setWidth(app, 220);
  await app.window.locator('.upd-pill').click();
  await expect(app.window.locator('.ui-dialog')).toBeVisible();
  await app.window.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(app.window.locator('.ui-dialog')).toHaveCount(0);
  await writeFile(testInfo.outputPath('stable-matrix.json'), JSON.stringify({
    scenarios: rows,
    interactions: { updateDialogAt220: true },
  }, null, 2));
});
