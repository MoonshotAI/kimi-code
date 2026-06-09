import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';

import {
  fetchWithReport,
  readReportEvents,
  recordReportEvent,
  resetReportDir,
  setActiveReportCase,
  writeHtmlReport,
} from '../src/report';
import { DaemonClient } from '../src/client';
import { HttpClient } from '../src/http';
import { WsClient } from '../src/ws';
import { createCaseLogger } from './log';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpReportDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-e2e-report-'));
  tmpDirs.push(dir);
  return dir;
}

describe('daemon-e2e report', () => {
  it('renders HTTP and WS trace events into a readable HTML timeline', () => {
    const reportDir = tmpReportDir();
    resetReportDir(reportDir);

    recordReportEvent(
      {
        kind: 'http',
        caseName: 'refresh: replay from zero',
        method: 'POST',
        path: '/sessions',
        status: 200,
        durationMs: 14,
        request: { body: { metadata: { cwd: '/tmp/workspace' } } },
        response: {
          envelope: {
            code: 0,
            msg: 'success',
            request_id: 'req_1',
            data: { id: 'session_1' },
          },
        },
      },
      { reportDir },
    );
    recordReportEvent(
      {
        kind: 'ws',
        caseName: 'refresh: replay from zero',
        direction: 'lifecycle',
        message: 'open',
        url: 'ws://daemon.example.test/api/v1/ws',
      },
      { reportDir },
    );
    recordReportEvent(
      {
        kind: 'ws',
        caseName: 'refresh: replay from zero',
        direction: 'in',
        frame: {
          type: 'prompt.completed',
          seq: 3,
          session_id: 'session_1',
          payload: { promptId: 'prompt_1' },
        },
      },
      { reportDir },
    );
    recordReportEvent(
      {
        kind: 'log',
        caseName: 'refresh: replay from zero',
        label: 'fresh listSessions snapshot',
        value: {
          count: 20,
          sessions: [{ id: 'session_1', title: 'New Session' }],
        },
      },
      { reportDir },
    );

    const htmlPath = writeHtmlReport({ reportDir, title: 'Daemon E2E Report' });
    const html = readFileSync(htmlPath, 'utf8');

    expect(html).toContain('Daemon E2E Report');
    expect(html).toContain('refresh: replay from zero');
    expect(html).toContain('class="case-nav"');
    expect(html).toContain('class="case-link"');
    expect(html).toContain('Client -&gt; Server');
    expect(html).toContain('Server -&gt; Client');
    expect(html).toContain('class="detail-pane"');
    expect(html).toContain('id="event-scroll"');
    expect(html).toContain('id="detail-scroll"');
    expect(html).toContain('data-event-id="event-0"');
    expect(html).toContain('<span>Step</span>');
    expect(html).toContain('<div class="time">#1</div>');
    expect(html).toContain('<div class="time">#2</div>');
    expect(html).not.toContain('<div class="time">06:');
    expect(html).toContain('.report { display: grid; grid-template-columns: minmax(680px, 1fr) minmax(320px, 34vw);');
    expect(html).toContain('.lane-head { display: grid; grid-template-columns: 38px minmax(0, 1fr) 22px minmax(0, 1fr);');
    expect(html).toContain('.swim-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) 22px minmax(0, 1fr); align-items: start; min-height: 30px; }');
    expect(html).toContain('border-radius: 0');
    expect(html).toContain('<li class="swim-row ws lifecycle"');
    expect(html).toContain('class="event-card ws life-event"');
    expect(html).toContain('POST /sessions');
    expect(html).toContain('HTTP 200');
    expect(html).toContain('WS open');
    expect(html).toContain('WS &lt;- prompt.completed');
    expect(html).toContain('<span class="event-title">fresh listSessions snapshot</span>');
    expect(html).not.toContain('<span class="event-meta">');
    expect(html).toContain('session_1');
    expect(html).toContain('scrollIntoView');
    expect(html).toContain('function setActiveEvent(eventId, options = {})');
    expect(html).toContain('if (!options.scrollPeer) return;');
    expect(html).toContain("setActiveEvent(nearest(rows, eventScroll)?.dataset.eventId, { scrollPeer: false });");
    expect(html).toContain("setActiveEvent(nearest(details, detailScroll)?.dataset.eventId, { scrollPeer: false });");
    expect(html).toContain("row.addEventListener('click', () => setActiveEvent(row.dataset.eventId, { scrollPeer: true, peer: 'detail' }));");
    expect(html).toContain("detail.addEventListener('click', () => setActiveEvent(detail.dataset.eventId, { scrollPeer: true, peer: 'timeline' }));");
    expect(html).not.toContain('syncing');
    expect(html).not.toContain("if (source === 'timeline')");
    expect(html).not.toContain("if (source === 'detail')");
    expect(html).not.toContain('WS -- open');
    expect(html).not.toMatch(/<div class="lane lane-right"><button class="event-card ws" type="button">\s*<span class="event-title">WS open<\/span>/);
    expect(html).not.toContain('<details');
  });

  it('escapes HTML in trace labels and JSON payloads', () => {
    const reportDir = tmpReportDir();
    resetReportDir(reportDir);

    recordReportEvent(
      {
        kind: 'log',
        caseName: '<script>case</script>',
        label: 'value <b>raw</b>',
        value: { text: '<img src=x onerror=alert(1)>' },
      },
      { reportDir },
    );

    const htmlPath = writeHtmlReport({ reportDir, title: '<Unsafe>' });
    const html = readFileSync(htmlPath, 'utf8');

    expect(html).toContain('&lt;Unsafe&gt;');
    expect(html).toContain('&lt;script&gt;case&lt;/script&gt;');
    expect(html).toContain('value &lt;b&gt;raw&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>case</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('records HttpClient request and response envelopes', async () => {
    const reportDir = tmpReportDir();
    resetReportDir(reportDir);
    setActiveReportCase('client helper: create session');

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          request_id: 'req_http',
          data: {
            id: 'session_1',
            workspace_id: 'wd_example_0123456789ab',
            title: 'New Session',
            created_at: '2026-06-09T00:00:00.000Z',
            updated_at: '2026-06-09T00:00:00.000Z',
            status: 'idle',
            metadata: { cwd: '/tmp/workspace' },
            agent_config: { model: '' },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
              total_cost_usd: 0,
              context_tokens: 0,
              context_limit: 0,
              turn_count: 0,
            },
            permission_rules: [],
            message_count: 0,
            last_seq: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const client = new HttpClient({
      baseUrl: 'http://daemon.example.test',
      apiPrefix: '/api/v1',
      fetchImpl,
      reportDir,
    });

    await client.createSession({ metadata: { cwd: '/tmp/workspace' } });

    const httpEvent = readReportEvents(reportDir).find((event) => event.kind === 'http');
    expect(httpEvent).toMatchObject({
      kind: 'http',
      caseName: 'client helper: create session',
      method: 'POST',
      path: '/sessions',
      status: 200,
    });
    expect(httpEvent?.request).toEqual({
      body: { metadata: { cwd: '/tmp/workspace' } },
    });
    expect(httpEvent?.response).toMatchObject({
      envelope: {
        code: 0,
        msg: 'success',
        request_id: 'req_http',
        data: { id: 'session_1' },
      },
    });
  });

  it('records WsClient inbound and outbound frames', async () => {
    const reportDir = tmpReportDir();
    resetReportDir(reportDir);
    setActiveReportCase('client: ws handshake');
    FakeWebSocket.instances = [];

    const ws = new WsClient({
      url: 'ws://daemon.example.test/api/v1/ws',
      wsImpl: FakeWebSocket as unknown as typeof WsWebSocket,
      logger: () => {},
      reportDir,
    });

    await ws.open();
    ws.send({ type: 'client_hello', id: 'hello_1', payload: { client_id: 'test' } });
    FakeWebSocket.instances[0]?.emit(
      'message',
      JSON.stringify({ type: 'server_hello', payload: { heartbeat_ms: 30_000 } }),
    );

    const events = readReportEvents(reportDir).filter((event) => event.kind === 'ws');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseName: 'client: ws handshake',
          direction: 'lifecycle',
          message: 'open',
        }),
        expect.objectContaining({
          caseName: 'client: ws handshake',
          direction: 'out',
          frame: { type: 'client_hello', id: 'hello_1', payload: { client_id: 'test' } },
        }),
        expect.objectContaining({
          caseName: 'client: ws handshake',
          direction: 'in',
          frame: { type: 'server_hello', payload: { heartbeat_ms: 30_000 } },
        }),
      ]),
    );
  });

  it('records createCaseLogger entries under the active case', () => {
    const reportDir = tmpReportDir();
    resetReportDir(reportDir);
    const previousReportDir = process.env['DAEMON_E2E_REPORT_DIR'];
    process.env['DAEMON_E2E_REPORT_DIR'] = reportDir;
    try {
      const log = createCaseLogger('refresh: auth');
      log('http envelope', { method: 'GET', path: '/auth', code: 0 });

      const event = readReportEvents(reportDir).find((entry) => entry.kind === 'log');
      expect(event).toMatchObject({
        kind: 'log',
        caseName: 'refresh: auth',
        label: 'http envelope',
        value: { method: 'GET', path: '/auth', code: 0 },
      });
    } finally {
      if (previousReportDir === undefined) {
        delete process.env['DAEMON_E2E_REPORT_DIR'];
      } else {
        process.env['DAEMON_E2E_REPORT_DIR'] = previousReportDir;
      }
    }
  });

  it('keeps active report cases isolated across overlapping async flows', async () => {
    const reportDir = tmpReportDir();
    resetReportDir(reportDir);

    await Promise.all([
      recordLater(reportDir, 'case A', 20),
      recordLater(reportDir, 'case B', 0),
    ]);

    const events = readReportEvents(reportDir).filter((event) => event.kind === 'log');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ caseName: 'case A', label: 'later' }),
        expect.objectContaining({ caseName: 'case B', label: 'later' }),
      ]),
    );
  });

  it('records direct fetch calls without consuming the response body', async () => {
    const reportDir = tmpReportDir();
    resetReportDir(reportDir);
    setActiveReportCase('refresh: meta');

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          request_id: 'req_meta',
          data: { daemon_id: 'daemon_1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const response = await fetchWithReport(
      'http://daemon.example.test/api/v1/meta',
      { headers: { accept: 'application/json' } },
      { reportDir, fetchImpl },
    );
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: { daemon_id: 'daemon_1' },
    });

    const event = readReportEvents(reportDir).find((entry) => entry.kind === 'http');
    expect(event).toMatchObject({
      kind: 'http',
      caseName: 'refresh: meta',
      method: 'GET',
      path: '/api/v1/meta',
      status: 200,
      response: {
        envelope: {
          code: 0,
          msg: 'success',
          request_id: 'req_meta',
          data: { daemon_id: 'daemon_1' },
        },
      },
    });
  });

  it('propagates DaemonClient reportDir to HTTP and WS traces', async () => {
    const reportDir = tmpReportDir();
    resetReportDir(reportDir);
    setActiveReportCase('daemon client: custom report dir');
    FakeWebSocket.instances = [];

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          request_id: 'req_http',
          data: {
            id: 'session_1',
            workspace_id: 'wd_example_0123456789ab',
            title: 'New Session',
            created_at: '2026-06-09T00:00:00.000Z',
            updated_at: '2026-06-09T00:00:00.000Z',
            status: 'idle',
            metadata: { cwd: '/tmp/workspace' },
            agent_config: { model: '' },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
              total_cost_usd: 0,
              context_tokens: 0,
              context_limit: 0,
              turn_count: 0,
            },
            permission_rules: [],
            message_count: 0,
            last_seq: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const client = new DaemonClient({
      baseUrl: 'http://daemon.example.test',
      fetchImpl,
      wsImpl: FakeWebSocket as unknown as typeof WsWebSocket,
      logger: () => {},
      reportDir,
    });

    await client.createSession({ metadata: { cwd: '/tmp/workspace' } });
    const connect = client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws?.emit(
      'message',
      JSON.stringify({
        type: 'server_hello',
        payload: { heartbeat_ms: 30_000, ws_connection_id: 'ws_1' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const hello = ws?.sent.map((raw) => JSON.parse(raw) as { type: string; id?: string })
      .find((frame) => frame.type === 'client_hello');
    expect(hello?.id).toBeDefined();
    ws?.emit(
      'message',
      JSON.stringify({ type: 'ack', id: hello?.id, code: 0, payload: {} }),
    );
    await connect;
    await client.close();

    const events = readReportEvents(reportDir);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'http',
          path: '/sessions',
          caseName: 'daemon client: custom report dir',
        }),
        expect.objectContaining({
          kind: 'ws',
          direction: 'in',
          frame: expect.objectContaining({ type: 'server_hello' }),
          caseName: 'daemon client: custom report dir',
        }),
        expect.objectContaining({
          kind: 'ws',
          direction: 'out',
          frame: expect.objectContaining({ type: 'client_hello' }),
          caseName: 'daemon client: custom report dir',
        }),
      ]),
    );
  });
});

async function recordLater(reportDir: string, caseName: string, delayMs: number): Promise<void> {
  setActiveReportCase(caseName);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  recordReportEvent({ kind: 'log', label: 'later' }, { reportDir });
}

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close', 1000, '');
  }
}
