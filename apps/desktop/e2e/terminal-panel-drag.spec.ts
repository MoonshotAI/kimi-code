import type { Locator, Page } from '@playwright/test';

import { expect } from './fixtures/app';
import {
  expectTerminalSize,
  expectTerminalText,
  readTerminalSize,
  runInTerminal,
  screenText,
  shellCommands as sh,
  shellEnv,
  terminalInput,
  terminalPanel,
  terminalTabs,
  terminalText,
  test,
  waitForPrompt,
} from './fixtures/terminal';

test.use({ appEnv: shellEnv });

async function drag(window: Page, from: Locator, to: () => Promise<{ x: number; y: number }>, finish: 'drop' | 'escape'): Promise<void> {
  const start = (await from.boundingBox())!;
  await window.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await window.mouse.down();
  const target = await to();
  await window.mouse.move(target.x, target.y, { steps: 12 });
  await window.waitForTimeout(60);
  if (finish === 'escape') await window.keyboard.press('Escape');
  await window.mouse.up();
}

async function settle(window: Page, selector: string): Promise<void> {
  await expect.poll(() => window.evaluate(target => document.querySelector(target)?.getAnimations().length ?? 0, selector)).toBe(0);
}

async function openRightPanel(window: Page): Promise<void> {
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+B' : 'Control+Shift+B');
  await expect(window.getByRole('complementary', { name: 'Detail panel' })).toBeVisible();
  await settle(window, '.global-preview');
}

test('bottom terminal tabs reorder by drag and move live to the right panel', async ({ app }) => {
  const window = app.window;
  const bottom = terminalPanel(window);
  const tabs = terminalTabs(window);
  const right = window.getByRole('complementary', { name: 'Detail panel' });
  const ids = () => bottom.locator('[data-panel-tab-id]').evaluateAll(items => items.map(item => (item as HTMLElement).dataset['panelTabId']));

  await window.getByRole('combobox', { name: 'Message input' }).click();
  await window.keyboard.press('Control+Backquote');
  await waitForPrompt(window);
  await runInTerminal(window, sh.shellPid('first'));
  await expectTerminalText(window, /first-pid-\d+/);
  await bottom.getByRole('button', { name: 'New terminal' }).click();
  await expect(tabs).toHaveCount(2);
  await waitForPrompt(window);
  await runInTerminal(window, sh.shellPid('moved'));
  await expectTerminalText(window, /moved-pid-\d+/);
  const pid = /moved-pid-(\d+)/.exec(await terminalText(window))![1]!;
  const bottomHost = bottom.locator('.terminal-host:visible');
  const before = { ...(await readTerminalSize(bottomHost)), width: (await bottomHost.boundingBox())!.width };

  const centerOf = async (locator: Locator) => {
    const box = (await locator.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const pastEnd = async () => {
    const box = (await tabs.first().boundingBox())!;
    return { x: box.x - 2, y: box.y + box.height / 2 };
  };

  await test.step('dragging reorders, Escape cancels', async () => {
    const [first, second] = await ids();
    await drag(window, tabs.nth(1), pastEnd, 'escape');
    expect(await ids()).toEqual([first, second]);
    await drag(window, tabs.nth(1), pastEnd, 'drop');
    expect(await ids()).toEqual([second, first]);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  });

  await openRightPanel(window);
  const bar = right.locator('.panel-tab-bar');
  await expect(bar).toBeVisible();

  await test.step('dropping elsewhere leaves the terminal in place', async () => {
    const count = await tabs.count();
    await drag(window, tabs.first(), async () => ({ x: 300, y: 300 }), 'drop');
    await expect(tabs).toHaveCount(count);
    await expect(right.locator('.terminal-host')).toHaveCount(0);
    await expect(bar.locator('.ptb-drop-indicator')).toHaveCount(0);
  });

  await test.step('a hovering drag shows the indicator; Escape keeps the tab', async () => {
    const start = await centerOf(tabs.first());
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    const target = await centerOf(bar);
    await window.mouse.move(target.x, target.y, { steps: 12 });
    await expect(bar.locator('.ptb-drop-indicator')).toHaveCount(1);
    await window.keyboard.press('Escape');
    await window.mouse.up();
    await expect(bar.locator('.ptb-drop-indicator')).toHaveCount(0);
    await expect(tabs).toHaveCount(2);
  });

  await test.step('dropping on the tab bar moves the same live terminal with its scrollback', async () => {
    await runInTerminal(window, `${sh.sleep(3)}; ${sh.echo('finished-after-move')}`);
    await drag(window, tabs.first(), () => centerOf(bar), 'drop');
    await expect(tabs).toHaveCount(1);
    const host = right.locator('.terminal-host:visible');
    await expect(host).toHaveCount(1);
    await expect(terminalInput(host)).toBeFocused();
    await expect.poll(() => screenText(host)).toContain(`moved-pid-${pid}`);
    await expect.poll(() => screenText(host), { timeout: 15_000 }).toMatch(/^finished-after-move$/m);
    await window.keyboard.type(sh.shellPid('still'));
    await window.keyboard.press('Enter');
    await expect.poll(() => screenText(host), { timeout: 15_000 }).toContain(`still-pid-${pid}`);
    await expectTerminalSize(host, async ({ cols }) => cols !== before.cols || (await host.boundingBox())!.width === before.width);
  });

  await test.step('moving the last terminal closes the bottom panel', async () => {
    await drag(window, tabs.first(), () => centerOf(bar), 'drop');
    await expect(right.locator('.terminal-host')).toHaveCount(2);
    await expect(bottom.getByRole('tab')).toHaveCount(0);
    await expect(bottom).toBeHidden();
    await expect(right.locator('.terminal-host:visible')).toHaveCount(1);
    await expect.poll(() => screenText(right.locator('.terminal-host:visible'))).toMatch(/first-pid-\d+/);
  });

  await test.step('the right panel still reorders its own tabs by drag', async () => {
    const rightTabs = bar.locator('[data-panel-tab-id]');
    const order = () => rightTabs.evaluateAll(items => items.map(item => (item as HTMLElement).dataset['panelTabId']));
    const [first, second] = await order();
    await drag(window, rightTabs.nth(1).locator('.ptb-tab-main'), async () => {
      const box = (await rightTabs.first().boundingBox())!;
      return { x: box.x + 2, y: box.y + box.height / 2 };
    }, 'drop');
    expect(await order()).toEqual([second, first]);
  });

  await test.step('leaving the tab bar restores the order and a ghost follows the pointer', async () => {
    const rightTabs = bar.locator('[data-panel-tab-id]');
    const order = () => rightTabs.evaluateAll(items => items.map(item => (item as HTMLElement).dataset['panelTabId']));
    const initial = await order();
    const firstBox = (await rightTabs.first().boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    const start = await centerOf(rightTabs.nth(1).locator('.ptb-tab-main'));
    const sourceBox = (await rightTabs.nth(1).boundingBox())!;
    const grab = { x: start.x - sourceBox.x, y: start.y - sourceBox.y };
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(firstBox.x + 2, start.y, { steps: 12 });
    await expect.poll(async () => (await rightTabs.first().boundingBox())!.x).toBeGreaterThan(firstBox.x + 1);
    const below = { x: firstBox.x + 2, y: barBox.y + barBox.height + 160 };
    await window.mouse.move(below.x, below.y, { steps: 12 });
    await expect.poll(async () => Math.round((await rightTabs.first().boundingBox())!.x)).toBe(Math.round(firstBox.x));
    const ghost = window.locator('.ptb-tab.is-drag-ghost');
    await expect(ghost).toBeVisible();
    const grabbedAt = async (point: { x: number; y: number }) => {
      const box = (await ghost.boundingBox())!;
      return Math.max(Math.abs(point.x - box.x - grab.x), Math.abs(point.y - box.y - grab.y));
    };
    await expect.poll(() => grabbedAt(below)).toBeLessThanOrEqual(1);
    await window.mouse.move(below.x, below.y + 80, { steps: 6 });
    await expect.poll(() => grabbedAt({ x: below.x, y: below.y + 80 })).toBeLessThanOrEqual(1);
    await window.mouse.up();
    await expect(ghost).toHaveCount(0);
    expect(await order()).toEqual(initial);
  });
});

test('right panel terminals move live to the bottom panel, opening it when closed', async ({ app }) => {
  const window = app.window;
  const bottom = terminalPanel(window);
  const tabs = terminalTabs(window);
  const bar = window.locator('.panel-tab-bar');
  const rightTabs = bar.locator('[data-panel-tab-id]');
  const zone = window.locator('.terminal-drop-zone');
  const toolbar = bottom.locator('.tp-toolbar');
  const centerOf = async (locator: Locator) => {
    const box = (await locator.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const hoverOver = async (from: Locator, target: Locator) => {
    const start = await centerOf(from);
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    const midway = await centerOf(window.getByRole('combobox', { name: 'Message input' }));
    await window.mouse.move(midway.x, midway.y, { steps: 6 });
    await expect(target).toBeVisible();
    const end = await centerOf(target);
    await window.mouse.move(end.x, end.y, { steps: 6 });
  };

  await window.getByRole('combobox', { name: 'Message input' }).click();
  await window.keyboard.press('Control+Backquote');
  await waitForPrompt(window);
  await runInTerminal(window, sh.shellPid('first'));
  await expectTerminalText(window, /first-pid-\d+/);
  await bottom.getByRole('button', { name: 'New terminal' }).click();
  await expect(tabs).toHaveCount(2);
  await waitForPrompt(window);
  await runInTerminal(window, sh.shellPid('second'));
  await expectTerminalText(window, /second-pid-\d+/);
  const pid = /second-pid-(\d+)/.exec(await terminalText(window))![1]!;

  await openRightPanel(window);
  await expect(bar).toBeVisible();
  const before = await rightTabs.count();
  await drag(window, tabs.nth(1), () => centerOf(bar), 'drop');
  await expect(rightTabs).toHaveCount(before + 1);
  await drag(window, tabs.first(), () => centerOf(bar), 'drop');
  await expect(rightTabs).toHaveCount(before + 2);
  await expect(bottom).toBeHidden();
  await settle(window, '.terminal-panel');
  const secondTab = rightTabs.nth(before);

  await test.step('Escape hides the drop zone and leaves the terminal in place', async () => {
    const handle = await centerOf(secondTab.locator('.ptb-tab-main'));
    const sourceBox = (await secondTab.boundingBox())!;
    const grab = { x: handle.x - sourceBox.x, y: handle.y - sourceBox.y };
    await hoverOver(secondTab.locator('.ptb-tab-main'), zone);
    await expect(zone).toHaveClass(/over/);
    const pointer = await centerOf(zone);
    const ghost = window.locator('.ptb-tab.is-drag-ghost');
    await expect(ghost).toBeVisible();
    await expect.poll(async () => {
      const box = (await ghost.boundingBox())!;
      return Math.max(Math.abs(pointer.x - box.x - grab.x), Math.abs(pointer.y - box.y - grab.y));
    }).toBeLessThanOrEqual(1);
    await window.keyboard.press('Escape');
    await window.mouse.up();
    await expect(zone).toHaveCount(0);
    await expect(ghost).toHaveCount(0);
    await expect(rightTabs).toHaveCount(before + 2);
    await expect(bottom).toBeHidden();
  });

  await test.step('dropping on the zone opens the panel with the same live terminal', async () => {
    await hoverOver(secondTab.locator('.ptb-tab-main'), zone);
    await window.mouse.up();
    await expect(zone).toHaveCount(0);
    await expect(bottom).toBeVisible();
    await settle(window, '.terminal-panel');
    await expect(tabs).toHaveCount(1);
    await expect(rightTabs).toHaveCount(before + 1);
    const host = bottom.locator('.terminal-host:visible');
    await expect(terminalInput(host)).toBeFocused();
    await expect.poll(() => screenText(host)).toContain(`second-pid-${pid}`);
    await window.keyboard.type(sh.shellPid('still'));
    await window.keyboard.press('Enter');
    await expect.poll(() => screenText(host), { timeout: 15_000 }).toContain(`still-pid-${pid}`);
    await expectTerminalSize(host, ({ rows }) => rows > 5);
  });

  await test.step('a non-terminal tab cannot drop on the bottom panel', async () => {
    await window.getByRole('combobox', { name: 'Message input' }).click();
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+E' : 'Control+Shift+E');
    await expect(rightTabs).toHaveCount(before + 2);
    const filesTab = rightTabs.nth(before + 1);
    await hoverOver(filesTab.locator('.ptb-tab-main'), toolbar);
    await expect(toolbar.locator('.tp-drop-indicator')).toHaveCount(0);
    await window.mouse.up();
    await expect(tabs).toHaveCount(1);
    await expect(rightTabs).toHaveCount(before + 2);
    await filesTab.hover();
    await filesTab.getByRole('button', { name: 'Close tab' }).click();
    await expect(rightTabs).toHaveCount(before + 1);
  });

  await test.step('dropping on the open tab bar inserts at the indicator and refits', async () => {
    const right = window.getByRole('complementary', { name: 'Detail panel' });
    await rightTabs.nth(before).locator('.ptb-tab-main').click();
    const previous = await readTerminalSize(right.locator('.terminal-host:visible'));
    await hoverOver(rightTabs.nth(before).locator('.ptb-tab-main'), toolbar);
    await expect(toolbar.locator('.tp-drop-indicator')).toHaveCount(1);
    await window.mouse.up();
    await expect(tabs).toHaveCount(2);
    await expect(toolbar.locator('.tp-drop-indicator')).toHaveCount(0);
    const host = bottom.locator('.terminal-host:visible');
    await expect(terminalInput(host)).toBeFocused();
    await expect.poll(() => screenText(host)).toMatch(/first-pid-\d+/);
    await expect(rightTabs).toHaveCount(0);
    await expect(terminalInput(host)).toBeFocused();
    await expectTerminalSize(host, ({ rows, cols }) => rows !== previous.rows || cols !== previous.cols);
    await expect(right).toBeVisible();
    await expect(right.getByRole('group', { name: 'Quick open' }).getByRole('button', { name: /^Terminal/ })).toBeVisible();
  });
});
