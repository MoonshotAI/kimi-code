import { addressBar, browse, detailPanel, expect, fromLastResult, lastToolResult, pageAt, test, toolResults, type BrowserToolResult } from './fixtures/browser';
import { held, say, type ModelRequest } from './fixtures/model';

test.use({ permissionMode: 'yolo' });

const SAMPLE = 'Kelp-07';

function tabIdIn(request: ModelRequest): string {
  const tabId = toolResults(request).find(result => result.tab?.tabId !== undefined)?.tab?.tabId;
  if (tabId === undefined) throw new Error(`Request ${request.index} has no tab in its tool results`);
  return tabId;
}

function refFor(result: BrowserToolResult | undefined, role: string, name: string): { snapshotId: string; ref: string } {
  const element = result?.elements?.elements.find(entry => entry.role === role && entry.name === name);
  if (result?.elements === undefined || element === undefined) throw new Error(`No ${role} "${name}" in ${JSON.stringify(result).slice(0, 800)}`);
  return { snapshotId: result.elements.snapshotId, ref: element.ref };
}

test('the agent browses, reads, clicks and types while in control, then stops when the user takes over', async ({ app, model, sites }) => {
  const home = sites.harbor.url('/home');
  const bench = sites.lab.url('/bench');
  const tab = (name: string) => detailPanel(app).getByRole('tab', { name, exact: true });
  const controlled = () => detailPanel(app).getByRole('img', { name: 'Agent is controlling this tab' });
  const transcript = () => app.window.getByRole('list').first();
  let first = 0;
  let tabId = '';

  await test.step('the agent opens the harbor page and reads its text', async () => {
    model.script(
      browse('browser.create_tab', { url: home }, 'Opening the harbor page.'),
      browse('browser.activate_panel'),
      fromLastResult(model, (_previous, request) => browse('page.text.snapshot', { tabId: tabIdIn(request), scope: { kind: 'document' } })),
      fromLastResult(model, (_previous, request) => browse('page.elements.snapshot', { tabId: tabIdIn(request), filter: { role: 'link' } })),
      fromLastResult(model, (previous, request) => browse('page.element.click', { tabId: tabIdIn(request), ...refFor(previous, 'link', 'Visit the lab bench') })),
      fromLastResult(model, (_previous, request) => browse('page.wait_for', { tabId: tabIdIn(request), condition: { kind: 'element', locator: { role: 'textbox', name: 'Sample name' }, state: 'visible' } })),
      fromLastResult(model, (_previous, request) => browse('page.elements.snapshot', { tabId: tabIdIn(request) }), 'in-control'),
      fromLastResult(model, (previous, request) => browse('page.element.fill', { tabId: tabIdIn(request), ...refFor(previous, 'textbox', 'Sample name'), text: SAMPLE })),
      fromLastResult(model, (_previous, request) => browse('page.element.click', { tabId: tabIdIn(request), ...refFor(toolResults(request).findLast(result => result.elements !== undefined), 'button', 'Save sample') })),
      fromLastResult(model, (_previous, request) => browse('page.text.snapshot', { tabId: tabIdIn(request) })),
      say(`Saved ${SAMPLE} on the lab bench.`),
    );
    const hold = model.hold('in-control');
    first = model.requests().length;
    await app.startTurn('Log the kelp sample on the lab bench');
    const reached = await hold.reached();
    tabId = tabIdIn(reached);
    const reading = toolResults(model.request(first + 3)).at(-1);
    expect(reading?.ok).toBe(true);
    expect(JSON.stringify(reading)).toContain('The harbor log records every tide');
    expect(sites.harbor.hits('/home')).toBe(1);
    expect(sites.lab.hits('/bench')).toBe(1);
  });

  await test.step('while the agent holds the tab the control marker and toolbar are shown', async () => {
    await expect(tab('Lab Bench')).toBeVisible();
    await expect(controlled()).toBeVisible();
    await expect(addressBar(app)).toHaveValue(bench);
    const surface = await app.controlSurface();
    await expect(surface.getByRole('toolbar', { name: 'Agent is in control' })).toBeVisible();
    await expect(surface.getByRole('button', { name: 'Take over' })).toBeVisible();
    await app.snapshot('agent-in-control');
    model.hold('in-control').release();
  });

  await test.step('the agent fills the form, the page saves it and the turn ends', async () => {
    await expect(transcript().getByText(`Saved ${SAMPLE} on the lab bench.`)).toBeVisible();
    await expect((await pageAt(app, bench)).locator('#saved')).toHaveText(`Saved sample: ${SAMPLE}`);
    await expect((await pageAt(app, bench)).getByRole('textbox', { name: 'Sample name' })).toHaveValue(SAMPLE);
    const finalRead = lastToolResult(model.requests().at(-1)!);
    expect(finalRead.ok).toBe(true);
    expect(JSON.stringify(finalRead)).toContain(`Saved sample: ${SAMPLE}`);
    const operations = model.requests().slice(first + 1).map(request => lastToolResult(request).operation);
    expect(operations).toEqual(['browser.create_tab', 'browser.activate_panel', 'page.text.snapshot', 'page.elements.snapshot', 'page.element.click', 'page.wait_for', 'page.elements.snapshot', 'page.element.fill', 'page.element.click', 'page.text.snapshot']);
    await expect(controlled()).toBeHidden();
    await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await app.snapshot('sample-saved-control-released');
  });

  await test.step('a second turn takes control again and the user takes over mid-turn', async () => {
    model.script(
      browse('page.text.snapshot', { tabId }, 'Checking the bench again.'),
      browse('browser.activate_tab', { tabId }),
      browse('page.visual.press_key', { tabId, keys: ['End'] }),
      held('before-takeover', browse('page.text.snapshot', { tabId })),
      say('Understood, the browser is yours.'),
    );
    const second = model.requests().length;
    await app.startTurn('Double-check the saved sample');
    await model.hold('before-takeover').reached();
    expect(JSON.stringify(lastToolResult(model.request(second + 1)))).toContain(`Saved sample: ${SAMPLE}`);
    expect(lastToolResult(model.request(second + 2))).toMatchObject({ ok: true, operation: 'browser.activate_tab' });
    expect(lastToolResult(model.request(second + 3))).toMatchObject({ ok: true, operation: 'page.visual.press_key' });
    await expect(controlled()).toBeVisible();
    const surface = await app.controlSurface();
    await surface.getByRole('button', { name: 'Take over' }).click();
    await expect(controlled()).toBeHidden();
    await expect(surface.getByRole('toolbar', { name: 'Agent is in control' })).toBeHidden();
    await app.snapshot('user-took-over');
    model.hold('before-takeover').release();
  });

  await test.step('the agent action after the takeover is refused and the model is told so', async () => {
    await expect(transcript().getByText('Understood, the browser is yours.')).toBeVisible();
    const refused = lastToolResult(model.requests().at(-1)!);
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('BROWSER_USER_TAKEOVER');
    await transcript().getByRole('button', { name: /Read 1 page · 1 key press · 1 more failed/, expanded: false }).click();
    const failedRead = transcript().getByRole('listitem').filter({ hasText: /Couldn’t read page text\s*Lab Bench/ }).last();
    await expect(failedRead.getByRole('status')).toBeVisible();
    await expect(transcript().getByRole('listitem').filter({ hasText: /Took control of tab\s*Lab Bench/ }).last()).toBeVisible();
    await expect(transcript().getByRole('listitem').filter({ hasText: /Pressed\s*End/ }).last()).toBeVisible();
    await failedRead.getByRole('button', { name: 'Expand details' }).click();
    await expect(failedRead.getByText('You took over the browser, so automation stopped for this turn.')).toBeVisible();
    await expect(controlled()).toBeHidden();
    await expect(tab('Lab Bench')).toBeVisible();
    await app.snapshot('takeover-reported');
  });
});
