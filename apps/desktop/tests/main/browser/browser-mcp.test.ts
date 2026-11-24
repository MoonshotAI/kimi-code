import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { decode } from '@toon-format/toon';
import { request as httpRequest } from 'node:http';
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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DESKTOP_BROWSER_DISABLED_ERROR, DESKTOP_BROWSER_RESTRICTED_GUIDANCE, startDesktopBrowserMcp, type DesktopBrowserAccess, type DesktopBrowserMcpHandle } from '../../../src/main/browser/browser-mcp';
import { BROWSER_AUTOMATION_PROTOCOL } from '../../../src/shared/browser-automation';
import { DESKTOP_BROWSER_SUBAGENT_RUN } from '../../../src/main/browser/browser-subagent-control';
import { setDesktopTrackImpl } from '../../../src/main/diagnostics/track';

let handle: DesktopBrowserMcpHandle | undefined;
let client: Client | undefined;

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

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await handle?.close();
  client = undefined;
  handle = undefined;
  vi.clearAllMocks();
  setDesktopTrackImpl(null);
});

function captureTelemetry(): Array<{ event: string; properties?: Record<string, unknown> }> {
  const events: Array<{ event: string; properties?: Record<string, unknown> }> = [];
  setDesktopTrackImpl((event, properties) => events.push({ event, properties }));
  return events;
}

async function connect(access?: DesktopBrowserAccess): Promise<Client> {
  handle = await startDesktopBrowserMcp({ access });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit: { headers: { Authorization: `Bearer ${handle.token}`, 'X-Kimi-Session-Id': 'session-test' } },
  });
  client = new Client({ name: 'browser-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('Desktop Browser MCP', () => {
  it('requires the per-launch bearer token and exposes only run', async () => {
    handle = await startDesktopBrowserMcp({ token: 'fixed-test-token' });
    expect(handle.token).toBe('fixed-test-token');
    const unauthorized = await fetch(handle.url, { method: 'POST' });
    expect(unauthorized.status).toBe(401);
    await handle.close();
    handle = undefined;

    const connected = await connect();
    const tools = await connected.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]).toMatchObject({
      name: 'run',
      inputSchema: {
        type: 'object',
        required: ['protocol', 'operation'],
      },
    });
  });

  it('advertises an input schema every function-calling provider can consume', async () => {
    const connected = await connect();
    const tools = (await connected.listTools()).tools;
    expect(tools).toHaveLength(1);
    const inputSchema = tools[0]!.inputSchema;
    expect(inputSchema).toMatchObject({ type: 'object', required: ['protocol', 'operation'], additionalProperties: false });
    walkSchema(inputSchema, '', (node, path) => {
      for (const keyword of UNSUPPORTED_KEYWORDS) {
        expect(Object.hasOwn(node, keyword), `${path}: ${keyword}`).toBe(false);
      }
      if (Object.hasOwn(node, 'enum')) expect(typeof node['type'], `${path}: enum without type`).toBe('string');
      if (/\/(properties\/[^/]+|items)$/.test(path)) expect(typeof node['type'], `${path}: property without type`).toBe('string');
    });
    const properties = (inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(properties['operation']).toMatchObject({ type: 'string', enum: expect.arrayContaining(['browser.get_state']) });
    for (const [field, schema] of Object.entries(properties)) {
      if (field === 'protocol' || field === 'operation') continue;
      expect(schema.description, field).toEqual(expect.stringMatching(/\w/));
    }
  });

  it('advertises only patterns whose meaning survives full-match constrained decoding', async () => {
    const connected = await connect();
    const inputSchema = (await connected.listTools()).tools[0]!.inputSchema;
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

  it('tells the agent to show pages the user asked to see, and only those', async () => {
    const connected = await connect();
    const description = (await connected.listTools()).tools[0]!.description ?? '';
    expect(description).toContain('When the user asks to open, visit, or see a page or search results, show it');
    expect(description).toContain('if browser.create_tab, tab.navigate, or tab.search returns the tab with visible=false, call browser.switch_tab with its tabId, which also reveals the panel');
    expect(description).toContain('Do not show tabs for background work the user did not ask to watch');
  });

  it('documents page dialogs and notices', async () => {
    const connected = await connect();
    const description = (await connected.listTools()).tools[0]!.description ?? '';
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

  it('ends failed established requests and retires their session', async () => {
    const connected = await connect();
    const spy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockRejectedValueOnce(new Error('request interrupted'));
    try {
      await expect(connected.listTools()).rejects.toThrow();
      await expect(connected.listTools()).rejects.toThrow();
      expect(spy).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });

  it('validates and dispatches kimi.browser/1.0.0 requests', async () => {
    const connected = await connect();
    const result = await connected.callTool({
      name: 'run',
      arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' },
    });
    expect(result.isError).not.toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledWith(
      { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' },
      expect.any(AbortSignal),
      'session-test',
    );
    const [text] = result.content as Array<{ type: string; text: string }>;
    expect(text?.type).toBe('text');
    expect(() => JSON.parse(text?.text ?? '')).toThrow();
    expect(decode(text?.text ?? '')).toEqual({
      ok: true,
      operation: 'browser.get_state',
      browser: { available: true, panelVisible: false, activeTabId: null, visibleTabId: null, tabs: [] },
    });

    const invalid = await connected.callTool({
      name: 'run',
      arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state', extra: true },
    });
    expect(invalid.isError).toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledOnce();
  });

  it('strips trusted run identity before parsing and dispatches registry metadata only', async () => {
    const identity = { agentId: 'agent-1', generation: 2, turnId: 7 };
    const controller = { run: identity, profile: 'coder', description: 'Inspect docs', assertActive: vi.fn() };
    const resolveRun = vi.fn(() => controller);
    const connected = await connect({ allows: () => true, resolveRun });
    const result = await connected.callTool({
      name: 'run',
      arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state', [DESKTOP_BROWSER_SUBAGENT_RUN]: identity },
    });
    expect(result.isError).not.toBe(true);
    expect(resolveRun).toHaveBeenCalledExactlyOnceWith('session-test', identity);
    expect(runBrowserAutomation).toHaveBeenCalledExactlyOnceWith(
      { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' },
      expect.any(AbortSignal),
      'session-test',
      controller,
    );

    const forged = await connected.callTool({
      name: 'run',
      arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state', [DESKTOP_BROWSER_SUBAGENT_RUN]: { ...identity, profile: 'spoofed' } },
    });
    expect(forged.isError).toBe(true);
    expect(runBrowserAutomation).toHaveBeenCalledOnce();
    const forgedText = JSON.stringify(forged.content);
    expect(forgedText).toContain('not currently running with built-in browser control enabled');
    expect(forgedText).toContain(DESKTOP_BROWSER_RESTRICTED_GUIDANCE);
    expect(forgedText).not.toContain('To view or operate a page, use WebBridge');
    expect(forgedText).not.toContain('then tell the user and use CU');
    expect(forgedText).not.toContain('workaround');
  });

  it('refuses calls while agent control is off with a reason and allows other available tools', async () => {
    const connected = await connect({ allows: () => false });
    const result = await connected.callTool({
      name: 'run',
      arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('turned off in Kimi Code Settings > Browser');
    expect(text).toContain('For a one-off lookup of public information, prefer WebSearch or FetchURL');
    expect(text).toContain('To view or operate a page, use WebBridge');
    expect(text).toContain("verify that CU's browser extension and local service are connected");
    expect(text).toContain('tell the user (or your parent agent) that the built-in browser is unavailable and why.');
    expect(text).not.toContain('workaround');
    expect(text).not.toContain('Otherwise, stop');
    expect(runBrowserAutomation).not.toHaveBeenCalled();
  });

  it('explains missing tab IDs and never dispatches invalid calls', async () => {
    const connected = await connect();
    const result = await connected.callTool({
      name: 'run',
      arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.scroll', deltaY: 500 },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain('Missing required parameters: tabId, snapshotId, x, y, deltaX');
    expect(content[0]?.text).toContain('browser.get_state');
    expect(runBrowserAutomation).not.toHaveBeenCalled();
  });

  it('tells the agent that url must be a full URL and how to search', async () => {
    const connected = await connect();
    const tool = (await connected.listTools()).tools[0]!;
    expect(tool.description).toContain('url must be a full URL');
    expect(tool.description).toContain("tab.search or browser.create_tab with query; both use the user's configured search engine");
    const query = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties['query'];
    expect(query?.description).toContain('Required for tab.search.');
    expect(query?.description).toContain('Optional for browser.create_tab.');
  });

  it.each([
    { operation: 'tab.search', tabId: 'tab-1', query: '   ' },
    { operation: 'browser.create_tab', query: '   ' },
    { operation: 'browser.create_tab', url: 'https://example.com/', query: 'biomap' },
  ])('rejects %j before opening or navigating a tab', async request => {
    const connected = await connect();
    const result = await connected.callTool({ name: 'run', arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, ...request } });
    expect(result.isError).toBe(true);
    expect(runBrowserAutomation).not.toHaveBeenCalled();
  });

  it.each(['h', '[    '])('rejects the truncated url %j before opening a tab', async url => {
    const connected = await connect();
    const result = await connected.callTool({
      name: 'run',
      arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.create_tab', url },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain(`/url: ${JSON.stringify(url)} is not an http(s) URL or host name`);
    expect(runBrowserAutomation).not.toHaveBeenCalled();
  });

  it('accepts a fresh MCP client after an earlier session closes', async () => {
    handle = await startDesktopBrowserMcp({ token: 'reconnect-token' });
    const makeClient = async (): Promise<Client> => {
      const next = new Client({ name: 'browser-mcp-reconnect', version: '1.0.0' });
      await next.connect(new StreamableHTTPClientTransport(new URL(handle!.url), {
        requestInit: { headers: { Authorization: 'Bearer reconnect-token' } },
      }));
      return next;
    };
    const first = await makeClient();
    expect((await first.listTools()).tools).toHaveLength(1);
    await first.close();
    const second = await makeClient();
    expect((await second.listTools()).tools[0]?.name).toBe('run');
    await second.close();
  });

  it('returns visual snapshots as MCP image content without duplicating base64 in text', async () => {
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
    const connected = await connect();
    const result = await connected.callTool({
      name: 'run',
      arguments: {
        protocol: BROWSER_AUTOMATION_PROTOCOL,
        operation: 'page.visual.snapshot',
        tabId: 'tab-1',
      },
    });
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.not.stringContaining('cG5n') }),
      { type: 'image', data: 'cG5n', mimeType: 'image/png' },
    ]);
    const [text] = result.content as Array<{ type: string; text: string }>;
    expect(decode(text?.text ?? '')).toMatchObject({ operation: 'page.visual.snapshot', visual: { snapshotId: 'visual-1', width: 100 } });
  });
});

it('rejects malformed unauthenticated request targets and keeps serving valid clients', async () => {
  const connected = await connect();
  const url = new URL(handle!.url);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: '//[', method: 'GET' }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('Request timed out')));
    request.end();
  });
  expect(status).toBe(400);
  expect((await connected.listTools()).tools[0]?.name).toBe('run');
});

it('reports a failed operation once with its error code and no free text', async () => {
  const events = captureTelemetry();
  runBrowserAutomation.mockResolvedValueOnce({ ok: false, operation: 'tab.navigate', error: { code: 'NAVIGATION_FAILED', message: 'Failed to load https://example.com' } });
  const connected = await connect();
  const result = await connected.callTool({
    name: 'run',
    arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'tab.navigate', tabId: 'tab-1', url: 'https://example.com' },
  });
  expect(result.isError).toBe(true);
  const reported = events.filter(item => item.event === 'browser_operation_result');
  expect(reported).toEqual([{
    event: 'browser_operation_result',
    properties: { operation: 'tab.navigate', ok: false, error_code: 'NAVIGATION_FAILED', duration_ms: expect.any(Number), caller: 'main', session_id: 'session-test' },
  }]);
});

it('reports a refused call with its telemetry code without changing the agent-facing text', async () => {
  const events = captureTelemetry();
  const connected = await connect({ allows: () => false });
  const result = await connected.callTool({
    name: 'run',
    arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'browser.get_state' },
  });
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: DESKTOP_BROWSER_DISABLED_ERROR }] });
  expect(events.filter(item => item.event === 'browser_operation_result').map(item => item.properties)).toEqual([
    { operation: 'browser.get_state', ok: false, error_code: 'CONTROL_DISABLED', duration_ms: expect.any(Number), caller: 'main', session_id: 'session-test' },
  ]);
});
