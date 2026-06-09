import { AsyncLocalStorage } from 'node:async_hooks';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export type ReportEventKind = 'log' | 'http' | 'ws' | 'test-result';
export type WsDirection = 'in' | 'out' | 'lifecycle';

export interface ReportEventBase {
  kind: ReportEventKind;
  caseName?: string;
  at?: string;
}

export interface LogReportEvent extends ReportEventBase {
  kind: 'log';
  label: string;
  value?: unknown;
}

export interface HttpReportEvent extends ReportEventBase {
  kind: 'http';
  method: string;
  path: string;
  url?: string;
  status?: number;
  durationMs?: number;
  request?: unknown;
  response?: unknown;
  error?: unknown;
}

export interface WsReportEvent extends ReportEventBase {
  kind: 'ws';
  direction: WsDirection;
  url?: string;
  frame?: unknown;
  message?: string;
  error?: unknown;
}

export interface TestResultReportEvent extends ReportEventBase {
  kind: 'test-result';
  state: 'passed' | 'failed' | 'skipped';
  durationMs?: number;
  error?: unknown;
}

export type ReportEvent =
  | LogReportEvent
  | HttpReportEvent
  | WsReportEvent
  | TestResultReportEvent;

export interface StoredReportEvent extends ReportEventBase {
  kind: ReportEventKind;
  pid: number;
  ordinal: number;
  label?: string;
  value?: unknown;
  method?: string;
  path?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  request?: unknown;
  response?: unknown;
  direction?: WsDirection;
  frame?: unknown;
  message?: string;
  state?: 'passed' | 'failed' | 'skipped';
  error?: unknown;
}

export interface ReportOptions {
  reportDir?: string;
}

export interface HtmlReportOptions extends ReportOptions {
  title?: string;
}

export interface FetchWithReportOptions extends ReportOptions {
  fetchImpl?: typeof fetch;
  path?: string;
}

let activeCaseName: string | undefined;
const activeCaseStorage = new AsyncLocalStorage<string>();
let ordinal = 0;

export function setActiveReportCase(caseName: string): void {
  activeCaseName = caseName;
  activeCaseStorage.enterWith(caseName);
}

export function getActiveReportCase(): string | undefined {
  return activeCaseStorage.getStore() ?? activeCaseName;
}

export function resetReportDir(reportDir = defaultReportDir()): void {
  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, '.gitignore'), '*\n!.gitignore\n');
}

export function recordReportEvent(event: ReportEvent, options?: ReportOptions): void {
  const reportDir = options?.reportDir ?? defaultReportDir();
  mkdirSync(reportDir, { recursive: true });
  const stored = normalizeEvent(event);
  appendFileSync(reportEventsPath(reportDir), `${JSON.stringify(stored)}\n`);
}

export function readReportEvents(reportDir = defaultReportDir()): StoredReportEvent[] {
  if (!existsSync(reportDir)) return [];
  const files = readdirSync(reportDir)
    .filter((file) => file.startsWith('events-') && file.endsWith('.jsonl'))
    .toSorted();
  const events: StoredReportEvent[] = [];
  for (const file of files) {
    const text = readFileSync(join(reportDir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      events.push(JSON.parse(line) as StoredReportEvent);
    }
  }
  return events.toSorted((a, b) => {
    const byTime = Date.parse(a.at ?? '') - Date.parse(b.at ?? '');
    if (byTime !== 0) return byTime;
    if (a.pid !== b.pid) return a.pid - b.pid;
    return a.ordinal - b.ordinal;
  });
}

export function writeHtmlReport(options?: HtmlReportOptions): string {
  const reportDir = options?.reportDir ?? defaultReportDir();
  mkdirSync(reportDir, { recursive: true });
  const title = options?.title ?? 'daemon-e2e report';
  const events = readReportEvents(reportDir);
  const htmlPath = join(reportDir, 'index.html');
  writeFileSync(htmlPath, renderHtml(title, events));
  return htmlPath;
}

export async function fetchWithReport(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  options?: FetchWithReportOptions,
): Promise<Response> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const method = fetchMethod(input, init);
  const url = fetchUrl(input);
  const path = options?.path ?? pathFromUrl(url);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(input, init);
  } catch (error) {
    recordReportEvent(
      {
        kind: 'http',
        method,
        path,
        url,
        durationMs: Date.now() - startedAt,
        request: requestForFetchReport(input, init),
        error: errorForReport(error),
      },
      { reportDir: options?.reportDir },
    );
    throw error;
  }

  const text = await response.clone().text();
  recordReportEvent(
    {
      kind: 'http',
      method,
      path,
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      request: requestForFetchReport(input, init),
      response: responseForReport(text),
    },
    { reportDir: options?.reportDir },
  );
  return response;
}

export function defaultReportDir(): string {
  return resolve(process.env['DAEMON_E2E_REPORT_DIR'] ?? join(process.cwd(), 'reports', 'latest'));
}

function normalizeEvent(event: ReportEvent): StoredReportEvent {
  const stored = event as StoredReportEvent;
  return {
    ...stored,
    at: event.at ?? new Date().toISOString(),
    caseName: event.caseName ?? getActiveReportCase() ?? process.env['DAEMON_E2E_CASE_NAME'] ?? 'unassigned',
    pid: process.pid,
    ordinal: ordinal++,
  };
}

function reportEventsPath(reportDir: string): string {
  return join(reportDir, `events-${process.pid}.jsonl`);
}

function renderHtml(title: string, events: StoredReportEvent[]): string {
  const cases = renderCases(groupByCase(events));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; background: #f4f6f8; color: #151922; overflow: hidden; }
    .app { display: grid; grid-template-columns: 260px minmax(0, 1fr); height: 100vh; min-height: 0; }
    .case-nav { background: #ffffff; border-right: 1px solid #d9dee7; display: flex; flex-direction: column; min-height: 0; }
    .nav-header { padding: 20px 18px 14px; border-bottom: 1px solid #e6eaf0; }
    h1 { margin: 0 0 8px; font-size: 20px; line-height: 1.2; }
    .summary { color: #596273; font-size: 13px; line-height: 1.45; }
    .case-list { padding: 10px; overflow: auto; }
    .case-link { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 7px 9px; border-radius: 0; color: #2d3543; text-decoration: none; border: 1px solid transparent; }
    .case-link:hover { background: #f4f7fa; }
    .case-link.active { background: #e9f4ef; border-color: #b8d9c9; color: #165f3a; }
    .case-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .case-count { color: #6d7685; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .report { display: grid; grid-template-columns: minmax(680px, 1fr) minmax(320px, 34vw); min-width: 0; min-height: 0; }
    .timeline-pane, .detail-pane { min-width: 0; min-height: 0; background: #ffffff; }
    .timeline-pane { display: grid; grid-template-rows: auto 1fr; border-right: 1px solid #d9dee7; }
    .detail-pane { display: grid; grid-template-rows: auto 1fr; }
    .lane-head { display: grid; grid-template-columns: 38px minmax(0, 1fr) 22px minmax(0, 1fr); gap: 0; align-items: center; height: 34px; padding: 0 10px; border-bottom: 1px solid #e6eaf0; background: #fbfcfd; color: #5a6371; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
    .lane-head-spine { height: 100%; border-left: 1px solid #d7dde5; justify-self: center; }
    .event-scroll, .detail-scroll { overflow: auto; min-height: 0; scroll-behavior: smooth; }
    .case-section { padding: 10px 10px 4px; }
    .case-section + .case-section { border-top: 1px solid #eef1f5; }
    .case-title { margin: 0 0 7px; font-size: 14px; line-height: 1.25; color: #202633; }
    .swimlanes { list-style: none; margin: 0; padding: 0; }
    .swim-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) 22px minmax(0, 1fr); align-items: start; min-height: 30px; }
    .swim-row.lifecycle { min-height: 30px; }
    .time { padding-top: 5px; color: #707a89; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .spine { position: relative; min-height: 30px; }
    .spine::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; border-left: 1px solid #d7dde5; }
    .dot { position: absolute; top: 8px; left: calc(50% - 4px); width: 8px; height: 8px; border-radius: 999px; background: #8792a2; box-shadow: 0 0 0 3px #ffffff; }
    .swim-row.active .dot { background: #0d7f4f; box-shadow: 0 0 0 3px #dff2e9; }
    .lane { padding: 2px 0 3px; min-width: 0; }
    .lane-left { padding-right: 6px; }
    .lane-right { padding-left: 6px; }
    .event-card { width: 100%; min-height: 26px; border: 1px solid #dfe5ec; border-radius: 0; background: #ffffff; color: #1f2633; display: flex; align-items: center; padding: 3px 7px; text-align: left; cursor: pointer; font: inherit; }
    .event-card:hover { border-color: #b8c4d2; background: #fbfcfd; }
    .swim-row.active .event-card { border-color: #2f9f68; background: #f4fbf7; }
    .event-card.http { border-left: 2px solid #1f8f55; }
    .event-card.ws { border-left: 2px solid #b56b00; }
    .event-card.log { border-left: 2px solid #607086; }
    .event-card.test-result { border-left: 2px solid #6c4acb; }
    .event-card.life-event { grid-column: 2 / 5; grid-row: 1; justify-self: center; align-self: start; width: min(320px, 60%); margin-top: 2px; z-index: 1; border-left: 2px solid #8792a2; }
    .event-title { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 700; line-height: 1.25; }
    .detail-head { height: 34px; padding: 9px 12px 0; border-bottom: 1px solid #e6eaf0; background: #fbfcfd; font-size: 13px; font-weight: 700; color: #303746; }
    .detail-case { padding: 10px 12px 0; }
    .detail-case-title { margin: 0 0 8px; font-size: 13px; color: #202633; }
    .detail-card { border: 1px solid #dfe5ec; border-radius: 0; margin: 0 0 8px; background: #ffffff; overflow: hidden; }
    .detail-card.active { border-color: #2f9f68; box-shadow: 0 0 0 2px #dff2e9; }
    .detail-title { display: flex; gap: 8px; align-items: center; padding: 9px 11px; border-bottom: 1px solid #eef1f5; font-size: 13px; font-weight: 700; }
    .kind { border-radius: 999px; padding: 2px 7px; font-size: 11px; font-weight: 700; background: #eef2ff; color: #2f4cb3; }
    .kind.http { background: #e9f7ef; color: #1b7240; }
    .kind.ws { background: #fff3df; color: #905300; }
    .kind.log { background: #eef2f6; color: #485262; }
    .kind.test-result { background: #f1ecff; color: #5b3bb3; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #111723; color: #e6edf3; padding: 12px; font-size: 12px; line-height: 1.45; }
    @media (max-width: 1100px) {
      body { overflow: auto; }
      .app { grid-template-columns: 1fr; height: auto; min-height: 100vh; }
      .case-nav { position: sticky; top: 0; z-index: 3; border-right: 0; border-bottom: 1px solid #d9dee7; }
      .case-list { display: flex; gap: 6px; overflow-x: auto; padding: 8px 10px; }
      .case-link { min-width: 190px; }
      .report { grid-template-columns: 1fr; min-height: 0; }
      .timeline-pane, .detail-pane { min-height: 65vh; border-right: 0; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="case-nav" aria-label="Cases">
      <div class="nav-header">
        <h1>${escapeHtml(title)}</h1>
        <div class="summary">${events.length} event(s), ${cases.length} case(s)<br>generated ${escapeHtml(new Date().toISOString())}</div>
      </div>
      <nav class="case-list">
        ${cases.map(renderCaseLink).join('\n')}
      </nav>
    </aside>
    <main class="report">
      <section class="timeline-pane" aria-label="Swimlane timeline">
        <div class="lane-head">
          <span>Step</span>
          <span>Client -&gt; Server</span>
          <span class="lane-head-spine"></span>
          <span>Server -&gt; Client</span>
        </div>
        <div class="event-scroll" id="event-scroll">
          ${cases.map(renderCase).join('\n')}
        </div>
      </section>
      <aside class="detail-pane" aria-label="Event details">
        <div class="detail-head">Details</div>
        <div class="detail-scroll" id="detail-scroll">
          ${cases.map(renderDetailCase).join('\n')}
        </div>
      </aside>
    </main>
  </div>
  <script>
    (() => {
      const eventScroll = document.getElementById('event-scroll');
      const detailScroll = document.getElementById('detail-scroll');
      const rows = [...document.querySelectorAll('[data-event-id].swim-row')];
      const details = [...document.querySelectorAll('[data-event-id].detail-card')];
      const links = [...document.querySelectorAll('[data-case-id].case-link')];
      if (!eventScroll || !detailScroll || rows.length === 0) return;

      let activeEventId = '';
      let eventRaf = 0;
      let detailRaf = 0;

      function setActiveCase(caseId) {
        for (const link of links) {
          link.classList.toggle('active', link.dataset.caseId === caseId);
        }
      }

      function setActiveEvent(eventId, options = {}) {
        if (!eventId) return;
        const activeRow = rows.find((row) => row.dataset.eventId === eventId);
        const activeDetail = details.find((detail) => detail.dataset.eventId === eventId);
        if (eventId !== activeEventId) {
          activeEventId = eventId;
          for (const row of rows) row.classList.toggle('active', row === activeRow);
          for (const detail of details) detail.classList.toggle('active', detail === activeDetail);
        }
        if (activeRow?.dataset.caseId) setActiveCase(activeRow.dataset.caseId);
        if (!options.scrollPeer) return;
        if (options.peer === 'detail') activeDetail?.scrollIntoView({ block: 'nearest' });
        if (options.peer === 'timeline') activeRow?.scrollIntoView({ block: 'nearest' });
      }

      function nearest(elements, container) {
        const top = container.getBoundingClientRect().top + 56;
        let best = elements[0];
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const element of elements) {
          const distance = Math.abs(element.getBoundingClientRect().top - top);
          if (distance < bestDistance) {
            best = element;
            bestDistance = distance;
          }
        }
        return best;
      }

      function scheduleTimelineSync() {
        window.cancelAnimationFrame(eventRaf);
        eventRaf = window.requestAnimationFrame(() => {
          setActiveEvent(nearest(rows, eventScroll)?.dataset.eventId, { scrollPeer: false });
        });
      }

      function scheduleDetailSync() {
        window.cancelAnimationFrame(detailRaf);
        detailRaf = window.requestAnimationFrame(() => {
          setActiveEvent(nearest(details, detailScroll)?.dataset.eventId, { scrollPeer: false });
        });
      }

      eventScroll.addEventListener('scroll', scheduleTimelineSync, { passive: true });
      detailScroll.addEventListener('scroll', scheduleDetailSync, { passive: true });
      for (const row of rows) {
        row.addEventListener('click', () => setActiveEvent(row.dataset.eventId, { scrollPeer: true, peer: 'detail' }));
      }
      for (const detail of details) {
        detail.addEventListener('click', () => setActiveEvent(detail.dataset.eventId, { scrollPeer: true, peer: 'timeline' }));
      }
      for (const link of links) {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          const section = document.getElementById(link.dataset.caseId);
          const firstRow = rows.find((row) => row.dataset.caseId === link.dataset.caseId);
          section?.scrollIntoView({ block: 'start' });
          setActiveCase(link.dataset.caseId);
          setActiveEvent(firstRow?.dataset.eventId, { scrollPeer: true, peer: 'detail' });
        });
      }
      setActiveEvent(rows[0]?.dataset.eventId, { scrollPeer: false });
    })();
  </script>
</body>
</html>
`;
}

interface RenderCase {
  id: string;
  name: string;
  events: RenderEvent[];
}

interface RenderEvent {
  id: string;
  caseId: string;
  stepIndex: number;
  event: StoredReportEvent;
}

function groupByCase(events: StoredReportEvent[]): Map<string, StoredReportEvent[]> {
  const cases = new Map<string, StoredReportEvent[]>();
  for (const event of events) {
    const caseName = event.caseName ?? 'unassigned';
    const group = cases.get(caseName);
    if (group) {
      group.push(event);
    } else {
      cases.set(caseName, [event]);
    }
  }
  return cases;
}

function renderCases(cases: Map<string, StoredReportEvent[]>): RenderCase[] {
  let eventIndex = 0;
  return [...cases.entries()].map(([name, events], caseIndex) => {
    const id = `case-${caseIndex}`;
    return {
      id,
      name,
      events: events.map((event, stepIndex) => ({
        id: `event-${eventIndex++}`,
        caseId: id,
        stepIndex: stepIndex + 1,
        event,
      })),
    };
  });
}

function renderCaseLink(testCase: RenderCase): string {
  return `<a class="case-link" data-case-id="${escapeHtml(testCase.id)}" href="#${escapeHtml(testCase.id)}">
  <span class="case-name">${escapeHtml(testCase.name)}</span>
  <span class="case-count">${testCase.events.length}</span>
</a>`;
}

function renderCase(testCase: RenderCase): string {
  return `<section class="case-section" id="${escapeHtml(testCase.id)}" data-case-section="${escapeHtml(testCase.id)}">
  <h2 class="case-title">${escapeHtml(testCase.name)}</h2>
  <ol class="swimlanes">
    ${testCase.events.map(renderEvent).join('\n')}
  </ol>
</section>`;
}

function renderEvent(rendered: RenderEvent): string {
  const left = eventLaneContent(rendered.event, 'left');
  const right = eventLaneContent(rendered.event, 'right');
  const center = lifecycleLaneContent(rendered.event);
  const rowClass = rendered.event.kind === 'ws' && rendered.event.direction === 'lifecycle'
    ? `${rendered.event.kind} lifecycle`
    : rendered.event.kind;
  return `<li class="swim-row ${escapeHtml(rowClass)}" data-event-id="${escapeHtml(rendered.id)}" data-case-id="${escapeHtml(rendered.caseId)}">
  <div class="time">#${rendered.stepIndex}</div>
  <div class="lane lane-left">${left}</div>
  <div class="spine"><span class="dot"></span></div>
  <div class="lane lane-right">${right}</div>
  ${center}
</li>`;
}

function renderDetailCase(testCase: RenderCase): string {
  return `<section class="detail-case" data-case-details="${escapeHtml(testCase.id)}">
  <h2 class="detail-case-title">${escapeHtml(testCase.name)}</h2>
  ${testCase.events.map(renderDetailCard).join('\n')}
</section>`;
}

function renderDetailCard(rendered: RenderEvent): string {
  const detail = eventDetail(rendered.event);
  return `<article class="detail-card" data-event-id="${escapeHtml(rendered.id)}" data-case-id="${escapeHtml(rendered.caseId)}" tabindex="0">
  <div class="detail-title">
    <span class="kind ${escapeHtml(rendered.event.kind)}">${escapeHtml(rendered.event.kind)}</span>
    <span>${escapeHtml(eventSummary(rendered.event))}</span>
  </div>
  <pre>${escapeHtml(JSON.stringify(detail, null, 2))}</pre>
</article>`;
}

function eventLaneContent(event: StoredReportEvent, lane: 'left' | 'right'): string {
  const content = lane === 'left' ? leftLaneSummary(event) : rightLaneSummary(event);
  if (!content) return '';
  return `<button class="event-card ${escapeHtml(event.kind)}" type="button">
  <span class="event-title">${escapeHtml(content.title)}</span>
</button>`;
}

function lifecycleLaneContent(event: StoredReportEvent): string {
  if (event.kind !== 'ws' || event.direction !== 'lifecycle') return '';
  return `<button class="event-card ${escapeHtml(event.kind)} life-event" type="button">
  <span class="event-title">${escapeHtml(eventSummary(event))}</span>
</button>`;
}

function leftLaneSummary(event: StoredReportEvent): { title: string } | undefined {
  if (event.kind === 'http') {
    return {
      title: `${event.method ?? 'HTTP'} ${event.path ?? event.url ?? ''}`.trim(),
    };
  }
  if (event.kind === 'ws' && event.direction === 'out') {
    return { title: eventSummary(event) };
  }
  if (event.kind === 'log') {
    return { title: event.label ?? 'log' };
  }
  return undefined;
}

function rightLaneSummary(event: StoredReportEvent): { title: string } | undefined {
  if (event.kind === 'http') {
    return {
      title: event.status === undefined ? 'HTTP response' : `HTTP ${event.status}`,
    };
  }
  if (event.kind === 'ws' && event.direction === 'in') {
    return { title: eventSummary(event) };
  }
  if (event.kind === 'test-result') {
    return { title: eventSummary(event) };
  }
  return undefined;
}

function eventSummary(event: StoredReportEvent): string {
  if (event.kind === 'http') {
    return `${event.method ?? 'HTTP'} ${event.path ?? event.url ?? ''}`.trim();
  }
  if (event.kind === 'ws') {
    const label = frameType(event.frame) ?? event.message ?? 'frame';
    if (event.direction === 'lifecycle') return `WS ${label}`;
    const arrow = event.direction === 'out' ? '->' : '<-';
    return `WS ${arrow} ${label}`;
  }
  if (event.kind === 'test-result') {
    return `test ${event.state ?? 'unknown'}`;
  }
  return event.label ?? 'log';
}

function eventDetail(event: StoredReportEvent): Record<string, unknown> {
  const { pid: _pid, ordinal: _ordinal, ...detail } = event;
  return detail;
}

function frameType(frame: unknown): string | undefined {
  if (!frame || typeof frame !== 'object') return undefined;
  const value = (frame as { type?: unknown }).type;
  return typeof value === 'string' ? value : undefined;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fetchMethod(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function pathFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function requestForFetchReport(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): { body?: unknown } {
  if (init?.body !== undefined && init.body !== null) {
    return { body: parseBodyForReport(init.body) };
  }
  if (input instanceof Request) return {};
  return {};
}

function parseBodyForReport(body: NonNullable<RequestInit['body']>): unknown {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof FormData) {
    return '[FormData]';
  }
  if (body instanceof Blob) {
    return `[Blob ${body.type || 'application/octet-stream'} ${body.size} bytes]`;
  }
  if (body instanceof ArrayBuffer) {
    return `[ArrayBuffer ${body.byteLength} bytes]`;
  }
  if (ArrayBuffer.isView(body)) {
    return `[${body.constructor.name} ${body.byteLength} bytes]`;
  }
  return '[ReadableStream]';
}

function responseForReport(text: string): { envelope?: unknown; raw?: string } {
  try {
    return { envelope: JSON.parse(text) as unknown };
  } catch {
    return { raw: text.slice(0, 2_000) };
  }
}

function errorForReport(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return error;
}
