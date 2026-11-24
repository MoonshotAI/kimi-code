import { addressBar, browserSection, chooseOverlayItem, detailPanel, expect, goTo, pageAt, stubWebSearch, tabLabels, test } from './fixtures/browser';
import { say } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const PROMPT = 'Plan the harbor visit';

test('browser tabs navigate, search, reorder, rename and come back after a relaunch', async ({ app, model, sites }) => {
  const home = sites.harbor.url('/home');
  const tides = sites.harbor.url('/tides');
  const bench = sites.lab.url('/bench');
  const notes = sites.lab.url('/notes');
  const tab = (name: string) => detailPanel(app).getByRole('tab', { name, exact: true });
  const visit = async (): Promise<number> => Number(/\d+/.exec(await (await pageAt(app, tides)).locator('#visit').innerText())![0]);

  await test.step('a session opens an empty Browser tab from the right panel', async () => {
    model.script(say('Opening the harbor pages next.'));
    await app.startTurn(PROMPT);
    await expect(app.window.getByRole('list').first().getByText('Opening the harbor pages next.')).toBeVisible();
    await app.window.getByRole('button', { name: 'Open right panel' }).click();
    await app.window.getByRole('group', { name: 'Quick open' }).getByRole('button', { name: /Browser/ }).click();
    await expect(browserSection(app).getByText('Type an address above, or ask the agent to:')).toBeVisible();
    await expect(browserSection(app).getByRole('button', { name: 'Back' })).toBeDisabled();
    await expect(browserSection(app).getByRole('button', { name: 'Site information' })).toBeDisabled();
    await app.snapshot('empty-browser-tab');
  });

  await test.step('typing an address loads the page and titles the tab', async () => {
    await goTo(app, home);
    await expect(tab('Harbor Home')).toHaveAttribute('aria-selected', 'true');
    await expect(addressBar(app)).toHaveValue(home);
    const page = await pageAt(app, home);
    await expect(page.getByRole('heading', { name: 'Harbor Home' })).toBeVisible();
    expect(sites.harbor.hits('/home')).toBe(1);
    await app.snapshot('harbor-home-loaded');
  });

  await test.step('a link, Back, Forward and Reload move through the history', async () => {
    await (await pageAt(app, home)).getByRole('link', { name: 'Read the tide report' }).click();
    await expect(tab('Tide Report')).toBeVisible();
    await expect(addressBar(app)).toHaveValue(tides);
    await expect(browserSection(app).getByRole('button', { name: 'Back' })).toBeEnabled();
    await expect(browserSection(app).getByRole('button', { name: 'Forward' })).toBeDisabled();

    await browserSection(app).getByRole('button', { name: 'Back' }).click();
    await expect(tab('Harbor Home')).toBeVisible();
    await expect(addressBar(app)).toHaveValue(home);
    await expect(browserSection(app).getByRole('button', { name: 'Forward' })).toBeEnabled();

    await browserSection(app).getByRole('button', { name: 'Forward' }).click();
    await expect(tab('Tide Report')).toBeVisible();
    await expect(addressBar(app)).toHaveValue(tides);
    const before = await visit();
    await browserSection(app).getByRole('button', { name: 'Reload' }).click();
    await expect.poll(visit).toBe(before + 1);
    expect(sites.harbor.hits('/tides')).toBe(before + 1);
    await app.snapshot('tide-report-reloaded');
  });

  await test.step('a target=_blank link opens in a new foreground tab and leaves its page in place', async () => {
    await (await pageAt(app, tides)).getByRole('link', { name: 'Open the lab notes in a new tab' }).click();
    await expect(tab('Lab Notes')).toHaveAttribute('aria-selected', 'true');
    await expect(addressBar(app)).toHaveValue(notes);
    await expect((await pageAt(app, notes)).getByRole('heading', { name: 'Lab Notes' })).toBeVisible();
    await expect.poll(() => tabLabels(app)).toEqual(['Tide Report', 'Lab Notes']);
    await app.snapshot('blank-target-link-new-tab');

    await tab('Tide Report').click();
    await expect(addressBar(app)).toHaveValue(tides);
    await expect((await pageAt(app, tides)).getByRole('heading', { name: 'Tide Report' })).toBeVisible();
    await tab('Lab Notes').click({ button: 'right' });
    await chooseOverlayItem(app, 'Close tab');
    await expect.poll(() => tabLabels(app)).toEqual(['Tide Report']);
  });

  await test.step('a second tab opens a page on another origin and the tabs switch', async () => {
    await detailPanel(app).getByRole('button', { name: 'New tab' }).click();
    await chooseOverlayItem(app, /^Browser/);
    await expect(browserSection(app).getByText('Type an address above, or ask the agent to:')).toBeVisible();
    await goTo(app, bench);
    await expect(tab('Lab Bench')).toHaveAttribute('aria-selected', 'true');
    await expect((await pageAt(app, bench)).getByRole('heading', { name: 'Lab Bench' })).toBeVisible();
    await expect.poll(() => tabLabels(app)).toEqual(['Tide Report', 'Lab Bench']);

    await tab('Tide Report').click();
    await expect(tab('Tide Report')).toHaveAttribute('aria-selected', 'true');
    await expect(addressBar(app)).toHaveValue(tides);
    await tab('Lab Bench').click();
    await expect(addressBar(app)).toHaveValue(bench);
    await app.snapshot('two-tabs-lab-bench');
  });

  await test.step('a bare word in the address bar becomes a web search', async () => {
    await stubWebSearch(app);
    await detailPanel(app).getByRole('button', { name: 'New tab' }).click();
    await chooseOverlayItem(app, /^Browser/);
    await goTo(app, 'spring tides');
    await expect(addressBar(app)).toHaveValue(/^https:\/\/www\.google\.com\/search\?q=spring(\+|%20)tides$/);
    await expect(tab('Search: spring tides')).toHaveAttribute('aria-selected', 'true');
    await goTo(app, `127.0.0.1:${new URL(home).port}/home`);
    await expect(addressBar(app)).toHaveValue(home);
    await expect(tab('Harbor Home')).toBeVisible();
    await expect.poll(() => tabLabels(app)).toEqual(['Tide Report', 'Lab Bench', 'Harbor Home']);
    await app.snapshot('search-tab-back-home');
  });

  await test.step('the tab menu renames and closes tabs, and Alt+Arrow reorders them', async () => {
    await tab('Harbor Home').click({ button: 'right' });
    await chooseOverlayItem(app, 'Close tab');
    await expect.poll(() => tabLabels(app)).toEqual(['Tide Report', 'Lab Bench']);

    await tab('Lab Bench').click({ button: 'right' });
    await chooseOverlayItem(app, 'Rename tab');
    const overlay = await app.overlay();
    const name = overlay.getByRole('textbox');
    await expect(name).toBeVisible();
    await name.fill('Sample desk');
    await overlay.getByRole('button', { name: 'Save' }).click();
    await expect(tab('Sample desk')).toBeVisible();

    await tab('Sample desk').focus();
    await app.window.keyboard.press('Alt+ArrowLeft');
    await expect.poll(() => tabLabels(app)).toEqual(['Sample desk', 'Tide Report']);
    await expect(tab('Sample desk')).toHaveAttribute('aria-selected', 'true');
    await expect(addressBar(app)).toHaveValue(bench);
    await app.snapshot('renamed-and-reordered');
  });

  await test.step('after a relaunch the session brings back both tabs with their pages', async () => {
    await app.relaunch();
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible();
    if (!/\/sessions\//.test(app.window.url())) await sidebar.getByText(PROMPT).click();
    await expect.poll(() => tabLabels(app), { timeout: 30_000 }).toEqual(['Sample desk', 'Tide Report']);
    await tab('Sample desk').click();
    await expect(addressBar(app)).toHaveValue(bench);
    await expect((await pageAt(app, bench)).getByRole('heading', { name: 'Lab Bench' })).toBeVisible();
    await tab('Tide Report').click();
    await expect(addressBar(app)).toHaveValue(tides);
    await expect((await pageAt(app, tides)).getByRole('heading', { name: 'Tide Report' })).toBeVisible();
    await expect(browserSection(app).getByRole('button', { name: 'Back' })).toBeVisible();
    await app.snapshot('tabs-restored-after-relaunch');
  });
});

test('a fresh draft closes self-closed pages and restores earlier history', async ({ app, sites }) => {
  const departures = sites.harbor.url('/departures');
  const closing = sites.harbor.url('/closing');
  const tab = (name: string) => detailPanel(app).getByRole('tab', { name, exact: true });
  const visits = (): number => sites.harbor.hits('/closing');

  await test.step('a fresh draft opens the departures page', async () => {
    await app.window.getByRole('button', { name: 'Open right panel', exact: true }).click();
    await app.window.getByRole('group', { name: 'Quick open' }).getByRole('button', { name: /Browser/ }).click();
    await goTo(app, departures);
    await expect(tab('Departures')).toHaveAttribute('aria-selected', 'true');
  });

  await test.step('a page opened in a new tab closes that tab when it closes itself', async () => {
    await (await pageAt(app, departures)).getByRole('link', { name: 'Open the closing notice in a new tab' }).click();
    await expect(tab('Closing Notice')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => tabLabels(app)).toEqual(['Departures', 'Closing Notice']);
    await (await pageAt(app, closing)).getByRole('button', { name: 'Close this page', exact: true }).click();
    await expect.poll(() => tabLabels(app)).toEqual(['Departures']);
    await expect(tab('Departures')).toHaveAttribute('aria-selected', 'true');
    await expect(addressBar(app)).toHaveValue(departures);
    await app.snapshot('self-closed-tab-removed');
  });

  await test.step('a page with earlier history stays open when it closes itself, and Reload still works', async () => {
    await (await pageAt(app, departures)).getByRole('link', { name: 'Read the closing notice here' }).click();
    await expect(tab('Closing Notice')).toHaveAttribute('aria-selected', 'true');
    await expect(browserSection(app).getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
    const before = visits();
    await (await pageAt(app, closing)).getByRole('button', { name: 'Close this page', exact: true }).click();
    await expect.poll(visits).toBe(before + 1);
    await expect.poll(() => tabLabels(app)).toEqual(['Closing Notice']);
    await expect(addressBar(app)).toHaveValue(closing);
    await expect(browserSection(app).getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
    await (await pageAt(app, closing)).getByRole('button', { name: 'Close this page', exact: true }).click();
    await expect.poll(visits).toBe(before + 2);
    await expect.poll(() => tabLabels(app)).toEqual(['Closing Notice']);
    await expect(addressBar(app)).toHaveValue(closing);
    await expect(browserSection(app).getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
    await browserSection(app).getByRole('button', { name: 'Reload', exact: true }).click();
    await expect.poll(visits).toBe(before + 3);
    await expect((await pageAt(app, closing)).getByRole('heading', { name: 'Closing Notice' })).toBeVisible();
    await browserSection(app).getByRole('button', { name: 'Back', exact: true }).click();
    await expect(addressBar(app)).toHaveValue(departures);
    await expect((await pageAt(app, departures)).getByRole('heading', { name: 'Departures' })).toBeVisible();
    await app.snapshot('self-close-refused-and-reloaded');
  });
});
