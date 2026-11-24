import { decode } from '@toon-format/toon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserRunResult } from '../../../src/shared/browser-automation';

const runBrowserAutomation = vi.hoisted(() =>
  vi.fn<(request: { operation: BrowserRunResult['operation'] }) => Promise<BrowserRunResult>>(
    async (request) => ({
      ok: true,
      operation: request.operation,
      browser: { available: true, panelVisible: false, activeTabId: null, visibleTabId: null, tabs: [] },
    }),
  ),
);

vi.mock('../../../src/main/browser/browser-automation', () => ({ runBrowserAutomation, isAgentLocalFileAddress: () => false }));

import { DESKTOP_BROWSER_DISABLED_ERROR, DESKTOP_BROWSER_TOOL, runDesktopBrowserTool, type DesktopBrowserAccess } from '../../../src/main/browser/browser-tool';
import { BROWSER_AUTOMATION_PROTOCOL } from '../../../src/shared/browser-automation';
import type { BrowserSubagentRun } from '../../../src/shared/browser-run';
import { setDesktopTrackImpl } from '../../../src/main/diagnostics/track';

const UNSUPPORTED_KEYWORDS = ['anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'const', '$ref', 'dependentRequired', 'dependentSchemas'];

function walkSchema(node: unknown, path: string, visit: (node: Record<string, unknown>, path: string) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkSchema(item, `${path}/${index}`, visit));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  visit(record, path);
  for (const [key, value] of Object.entries(record)) walkSchema(value, `${path}/${key}`, visit);
}

afterEach(() => {
  vi.clearAllMocks();
  setDesktopTrackImpl(null);
});

function captureTelemetry(): Array<{ event: string; properties?: Record<string, unknown> }> {
  const events: Array<{ event: string; properties?: Record<string, unknown> }> = [];
  setDesktopTrackImpl((event, properties) => events.push({ event, properties }));
  return events;
}

const ALLOW_ALL: DesktopBrowserAccess = { allows: () => true, resolveRun: () => null };

function callRun(args: Record<string, unknown>, access: DesktopBrowserAccess = ALLOW_ALL, run?: BrowserSubagentRun) {
  return runDesktopBrowserTool(access, { sessionId: 'session-test', args, signal: new AbortController().signal, ...(run === undefined ? {} : { run }) });
}

const inputSchema = DESKTOP_BROWSER_TOOL.parameters;

const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content[0]?.text ?? '';

describe('Desktop browser tool', () => {
  it('is named like the MCP tool it replaces and requires a protocol and an operation', () => {
    expect(DESKTOP_BROWSER_TOOL.name).toBe('mcp__desktop_browser__run');
    expect(inputSchema).toMatchObject({ type: 'object', required: ['protocol', 'operation'] });
  });

  it('advertises an input schema every function-calling provider can consume', () => {
    expect(inputSchema).toMatchObject({ type: 'object', required: ['protocol', 'operation'], additionalProperties: false });
    const violations: string[] = [];
    walkSchema(inputSchema, '', (node, path) => {
      for (const keyword of UNSUPPORTED_KEYWORDS) {
        if (Object.hasOwn(node, keyword)) violations.push(`${path}: ${keyword}`);
      }
      const typed = typeof node['type'] === 'string';
      if (Object.hasOwn(node, 'enum') && !typed) violations.push(`${path}: enum without type`);
      if (/\/(properties\/[^/]+|items)$/.test(path) && !typed) violations.push(`${path}: property without type`);
    });
    expect(violations).toEqual([]);
    const properties = (inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(properties['operation']).toMatchObject({ type: 'string', enum: expect.arrayContaining(['browser.get_state']) });
    for (const [field, schema] of Object.entries(properties)) {
      if (field === 'protocol' || field === 'operation') continue;
      expect(schema.description, field).toEqual(expect.stringMatching(/\w/));
    }
  });

  it('advertises only patterns whose meaning survives full-match constrained decoding', () => {
    walkSchema(inputSchema, '', (node, path) => {
      const pattern = node['pattern'];
      if (pattern === undefined) return;
      expect(typeof pattern, path).toBe('string');
      expect(pattern as string, path).toMatch(/^\^.*\$$/);
    });
    const properties = (inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    const accepts = (field: string, value: string): boolean => {
      const schema = properties[field]!;
      const pattern = schema['pattern'];
      if (typeof pattern === 'string' && !new RegExp(`^(?:${pattern})$`, 'u').test(value)) return false;
      if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) return false;
      if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) return false;
      return true;
    };
    const url = `https://www.google.com/search?q=biomap+company&hl=en&sca_esv=${'a1b2c3'.repeat(40)}#results`;
    expect(properties['url']).not.toHaveProperty('pattern');
    expect(accepts('url', url)).toBe(true);
    expect(accepts('url', 'h')).toBe(true);
    expect(properties['query']).not.toHaveProperty('pattern');
    expect(accepts('query', 'biomap company & partners #1?')).toBe(true);
    expect(accepts('query', '北京 天气')).toBe(true);
    expect(accepts('tabId', 'panel-tab-66')).toBe(true);
    expect(accepts('snapshotId', 'visual:1a2b_3c')).toBe(true);
    expect(accepts('ref', 'e12')).toBe(true);
  });

  it('tells the agent to show pages the user asked to see, and only those', () => {
    const description = DESKTOP_BROWSER_TOOL.description;
    expect(description).toContain('When the user asks to open, visit, or see a page or search results, show it');
    expect(description).toContain('if browser.create_tab, tab.navigate, or tab.search returns the tab with visible=false, call browser.switch_tab with its tabId, which also reveals the panel');
    expect(description).toContain('Do not show tabs for background work the user did not ask to watch');
  });

  it('documents page dialogs and notices', () => {
    const description = DESKTOP_BROWSER_TOOL.description;
    expect(description).toContain('Dialogs:');
    expect(description).toContain('Every result, including browser.get_state and tab operations, carries pendingDialogs');
    expect(description).toContain('A dialog is repeated on every call until it is answered');
    expect(description).toContain('Dialogs can open asynchronously');
    expect(description).toContain('page.dialog.get lists the pending dialogs as pendingDialogs');
    expect(description).toContain('page.dialog.respond answers one');
    expect(description).toContain('other page operations fail with DIALOG_OPEN');
    expect(description).toContain('handledDialogs lists dialogs and blocked actions');
    expect(description).toContain('Blocked actions: external app links');
    expect(description).toContain('WAITING_FOR_USER means only the user can continue');
  });

  it('validates and dispatches kimi.browser/1.0.0 requests', async () => {
    const result = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' });
    expect(result.isError).toBe(false);
    expect(runBrowserAutomation).toHaveBeenCalledWith(
      { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' },
      expect.any(AbortSignal),
      'session-test',
    );
    expect(result.content[0]?.type).toBe('text');
    expect(() => JSON.parse(text(result))).toThrow();
    expect(decode(text(result))).toEqual({
      ok: true,
      operation: 'browser.get_state',
      browser: { available: true, panelVisible: false, activeTabId: null, visibleTabId: null, tabs: [] },
    });

    const invalid = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state', extra: true });
    expect(invalid.isError).toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledOnce();
  });

  it('dispatches registry metadata for a trusted run and refuses a run the registry does not know', async () => {
    const identity = { agentId: 'agent-1', generation: 2, turnId: 7 };
    const controller = { run: identity, profile: 'coder', description: 'Inspect docs', assertActive: vi.fn() };
    const resolveRun = vi.fn((_sessionId: string, run: BrowserSubagentRun) => run.turnId === identity.turnId ? controller : null);
    const access: DesktopBrowserAccess = { allows: () => true, resolveRun };
    const result = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' }, access, identity);
    expect(result.isError).toBe(false);
    expect(resolveRun).toHaveBeenCalledExactlyOnceWith('session-test', identity);
    expect(runBrowserAutomation).toHaveBeenCalledExactlyOnceWith(
      { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' },
      expect.any(AbortSignal),
      'session-test',
      controller,
    );

    const stale = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' }, access, { ...identity, turnId: 8 });
    expect(stale.isError).toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledOnce();
    expect(text(stale)).toContain('not currently running with built-in browser control enabled');
    expect(text(stale)).toContain('Use WebSearch, FetchURL, or other available tools if they fit the task.');
    expect(text(stale)).not.toContain('workaround');
    expect(text(stale)).not.toContain('computer use');
  });

  it('rejects a run identity smuggled in the model arguments', async () => {
    const result = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state', __kimiDesktopSubagentRun: { agentId: 'agent-1', generation: 2, turnId: 7 } });
    expect(result.isError).toBe(true);
    expect(runBrowserAutomation).not.toHaveBeenCalled();
  });

  it('refuses calls while agent control is off with a reason and allows other available tools', async () => {
    const result = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' }, { allows: () => false, resolveRun: () => null });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('turned off in Kimi Code Settings > Browser');
    expect(text(result)).toContain('Use WebSearch, FetchURL, or other available tools if they fit the task.');
    expect(text(result)).toContain('tell the user (or your parent agent) that the built-in browser is unavailable and why.');
    expect(text(result)).not.toContain('workaround');
    expect(text(result)).not.toContain('computer use');
    expect(text(result)).not.toContain('Otherwise, stop');
    expect(runBrowserAutomation).not.toHaveBeenCalled();
  });

  it('explains missing tab IDs and never dispatches invalid calls', async () => {
    const result = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.scroll', deltaY: 500 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Missing required parameters: tabId, snapshotId, x, y, deltaX');
    expect(text(result)).toContain('browser.get_state');
    expect(runBrowserAutomation).not.toHaveBeenCalled();
  });

  it('tells the agent that url must be a full URL and how to search', () => {
    expect(DESKTOP_BROWSER_TOOL.description).toContain('url must be a full URL');
    expect(DESKTOP_BROWSER_TOOL.description).toContain("tab.search or browser.create_tab with query; both use the user's configured search engine");
    const query = (inputSchema as { properties: Record<string, { description?: string }> }).properties['query'];
    expect(query?.description).toContain('Required for tab.search.');
    expect(query?.description).toContain('Optional for browser.create_tab.');
  });

  it.each([
    { operation: 'tab.search', tabId: 'tab-1', query: '   ' },
    { operation: 'browser.create_tab', query: '   ' },
    { operation: 'browser.create_tab', url: 'https://example.com/', query: 'biomap' },
  ])('rejects %j before opening or navigating a tab', async request => {
    const result = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, ...request });
    expect(result.isError).toBe(true);
    expect(runBrowserAutomation).not.toHaveBeenCalled();
  });

  it.each(['h', '[    '])('rejects the truncated url %j before opening a tab', async url => {
    const result = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.create_tab', url });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`/url: ${JSON.stringify(url)} is not an http(s) URL or host name`);
    expect(runBrowserAutomation).not.toHaveBeenCalled();
  });

  it('returns visual snapshots as image content without duplicating base64 in text', async () => {
    runBrowserAutomation.mockResolvedValueOnce({
      ok: true,
      operation: 'page.visual.snapshot',
      visual: {
        snapshotId: 'visual-1',
        mimeType: 'image/png',
        data: 'cG5n',
        width: 100,
        height: 80,
        deviceScaleFactor: 2,
        viewport: { width: 50, height: 40 },
      },
    });
    const result = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.snapshot', tabId: 'tab-1' });
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.not.stringContaining('cG5n') }),
      { type: 'image', data: 'cG5n', mimeType: 'image/png' },
    ]);
    expect(decode(text(result))).toMatchObject({ operation: 'page.visual.snapshot', visual: { snapshotId: 'visual-1', width: 100 } });
  });
});

it('reports a failed operation once with its error code and no free text', async () => {
  const events = captureTelemetry();
  runBrowserAutomation.mockResolvedValueOnce({ ok: false, operation: 'tab.navigate', error: { code: 'NAVIGATION_FAILED', message: 'Failed to load https://example.com' } });
  const result = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'tab.navigate', tabId: 'tab-1', url: 'https://example.com' });
  expect(result.isError).toBe(true);
  const reported = events.filter(item => item.event === 'browser_operation_result');
  expect(reported).toEqual([{
    event: 'browser_operation_result',
    properties: { operation: 'tab.navigate', ok: false, error_code: 'NAVIGATION_FAILED', duration_ms: expect.any(Number), caller: 'main', session_id: 'session-test' },
  }]);
});

it('reports a refused call with its telemetry code without changing the agent-facing text', async () => {
  const events = captureTelemetry();
  const result = await callRun({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' }, { allows: () => false, resolveRun: () => null });
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: DESKTOP_BROWSER_DISABLED_ERROR }] });
  expect(events.filter(item => item.event === 'browser_operation_result').map(item => item.properties)).toEqual([
    { operation: 'browser.get_state', ok: false, error_code: 'CONTROL_DISABLED', duration_ms: expect.any(Number), caller: 'main', session_id: 'session-test' },
  ]);
});
