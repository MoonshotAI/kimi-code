import { formatBrowserToolResult } from './browser-tool-output';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  BROWSER_AUTOMATION_PROTOCOL,
  describeInvalidBrowserRunRequest,
  asBrowserRunRequest,
  BROWSER_OPERATIONS,
} from '../../shared/browser-automation';
import { isAgentLocalFileAddress, runBrowserAutomation } from './browser-automation';
import type { BrowserOperationErrorCode, BrowserOperationResultEvent } from '../diagnostics/telemetry-events';
import { trySendDesktopEvent } from '../diagnostics/track';
import { BROWSER_RUN_TOOL_SCHEMA } from './browser-tool-schema';
import { browserValidators } from '../../shared/browser-control';
import type { BrowserSubagentRun } from '../../shared/browser-run';
import { DESKTOP_BROWSER_SUBAGENT_RUN, DESKTOP_BROWSER_SUBAGENT_RUN_REASON, type DesktopBrowserSubagentRun } from './browser-subagent-control';

function rejectRequest(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(500, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}

const TOOL_NAME = 'run';

const TOOL_DESCRIPTION = `Browse and interact with web pages in Kimi Code Desktop, using screenshots or element references.

Getting started:
- Send protocol="${BROWSER_AUTOMATION_PROTOCOL}" and an operation. The schema lists every parameter as optional; each parameter description names the operations that require it, and calls with missing or conflicting parameters are rejected with the exact requirements.
- Use browser.get_state to discover existing tabs or browser.create_tab to open one. Use returned tab IDs for subsequent calls.
- url must be a full URL. To search the web, use tab.search or browser.create_tab with query; both use the user's configured search engine.

Tabs and control:
- browser.get_state returns activeTabId (control target) and visibleTabId (the page the user is viewing).
- browser.create_tab creates a background tab and selects it for control. browser.activate_tab selects an existing tab for control. Navigation, input, and device changes require control; reading a loaded page does not.
- browser.switch_tab shows a tab in the currently viewed conversation. browser.activate_panel reveals the existing panel. Background operations can continue while the user views another tab or hides the panel.
- When the user asks to open, visit, or see a page or search results, show it: if browser.create_tab, tab.navigate, or tab.search returns the tab with visible=false, call browser.switch_tab with its tabId, which also reveals the panel. Do not show tabs for background work the user did not ask to watch, such as research, scraping, or checks.
- browser.release_tab releases control; browser.close_tab closes the tab. Control expires at the end of the turn. On BROWSER_USER_TAKEOVER, stop browser calls for this turn; control becomes available in a new user turn.

Page interaction:
- page.wait_for waits for a condition: element {kind:"element",locator:{role,name?,exact?},state:"visible"|"hidden"|"enabled"}; text {kind:"text",text,match?:"exact"|"contains",state:"present"|"absent"}; URL {kind:"url",value,match:"exact"|"prefix"}. timeoutMs defaults to 10000 (max 30000). stableForMs means the condition remains true (0–5000), not layout stability. Positive element waits match any rendered target; hidden requires no rendered matches. Re-snapshot before input. WAIT_TIMEOUT includes lastObserved evidence.
- page.text.snapshot reads rendered DOM text as bounded TOON blocks, including noninteractive text. scope={kind:"viewport"} is the default; use {kind:"document"} for loaded content or {kind:"element",snapshotId,ref} to read a subtree. maxChars defaults to 12000 (2048–24000). Continue with cursor=nextCursor only. Text block IDs cannot be used as element refs; part/continued split long blocks. Reading never scrolls or loads more content.
- page.elements.snapshot returns bounded TOON rows (column names appear once in the header). Defaults: viewport, limit=100, maxChars=8000. Use scope={kind:"document"} for loaded offscreen elements, filter={role,text} to narrow results, and cursor=nextCursor to continue the same snapshot. scanTruncated means narrow the scope or filter; another page cannot recover unscanned content.
- Use page.elements.snapshot for element refs, then page.element operations for clicks, text entry, selections, and other control interactions.
- page.visual.crop reads a region from the original image behind a visual snapshot. Supply snapshotId and region={x,y,width,height} in returned screenshot pixels. The response has sourceSnapshotId, region and image dimensions, but no new clickable snapshotId. For local crop coordinates, sourceX=region.x+localX*region.width/width (same for Y). Cache expires after 60 seconds; SNAPSHOT_EXPIRED requires a fresh snapshot. A crop shows the original capture time, not the current page.
- Use page.visual.snapshot for an image and snapshotId, then page.visual operations for coordinate-based interaction. Coordinates refer to pixels in the returned image. Scroll x/y specifies the origin; deltaX/deltaY specifies the total scroll displacement.
- Use each snapshotId with its matching visual or element operations on the same tab. Visual snapshot coordinates remain reusable in the same document after scrolling, resizing, input, or another screenshot. They map to the original CSS viewport coordinates with the current display scale, not proportional positions in the resized window. Capture again when you need to inspect changed content. Element refs still require connected targets.
- page.visual.drag drags in a straight line from one point to another. page.visual.drag_path presses at points[0], moves through every point in order as one continuous stroke, and releases at the last point; use it to draw on canvases, sign, or follow curved sliders. Send 2–500 points in returned screenshot pixels; points are interpolated so the stroke has no gaps. Close a shape by repeating the first point, for example a circle of radius 50 around (200,150): points=[{x:250,y:150},{x:235,y:185},{x:200,y:200},{x:165,y:185},{x:150,y:150},{x:165,y:115},{x:200,y:100},{x:235,y:115},{x:250,y:150}] (use more points for a smoother curve). Optional button (default left), durationMs (total movement time), and modifiers such as ["Shift"].
- page.visual.type_text and press_key target the focused page element.
- page.visual.click_if_interactive clicks only when the exact point hits a recognized interactive element. outcome="no_target" means no click was sent; inspect the returned candidates or screenshot, and refs from an earlier page.elements.snapshot stay usable. outcome="clicked" invalidates those earlier refs, so take a new page.elements.snapshot before using them again. Candidate bounds use image pixels, and candidate refs pair with elementsSnapshotId. truncated=true indicates incomplete candidates.
- tab.wait_for_load waits for committed, dom_ready, or complete.
- Results of input operations may include receipt, the ID of a small before-action screenshot kept for the user. You cannot read it, and no operation accepts it.

Device emulation:
- Discover presets with browser.get_device_profiles; apply one or set responsive dimensions with tab.set_device_mode. Disable with device={"enabled":false}.
- The responsive preset uses mobile identity and touch input; choose a desktop preset for desktop behavior. Display scale controls the preview size, separately from page zoom. Device changes may reload the page; observe again afterward.

Dialogs:
- Pages can open dialogs: alert, confirm, prompt (window.prompt() asks for text), beforeunload (the page asks to confirm leaving), file (a file input wants files) and upload (the user's approval for an upload). The browser never blocks on them; the user sees each pending dialog, can watch you answer it, and can answer or cancel it too.
- Every result, including browser.get_state and tab operations, carries pendingDialogs while any dialog in this conversation's tabs waits for an answer: dialogId, tabId, kind, origin, message (truncated), defaultValue for prompts, answerer (agent or user), accept and multiple for file dialogs, files for upload approvals, target and retryAfterAccept for beforeunload, and ageMs. A dialog is repeated on every call until it is answered.
- Dialogs can open asynchronously, for example an alert from a timer seconds after a click returned. Check pendingDialogs on each result and answer them before continuing.
- page.dialog.get lists the pending dialogs as pendingDialogs (always present, possibly empty).
- page.dialog.respond answers one with accept=true (OK, Leave) or accept=false (Cancel, Stay); an alert only has OK, so it is always accepted. For a prompt, accept=true with text sends that text to the page (without text the page gets defaultValue) and accept=false makes prompt() return null; treat the text like typing into the page. For a file dialog send accept=true and files as absolute local paths. Files inside the workspace or Downloads are attached directly; others follow the user's approval mode and may return WAITING_FOR_USER while the user decides, and are attached automatically if allowed. Only the user answers upload approvals, and dialogs with answerer=user.
- While an alert, confirm or prompt is open, other page operations fail with DIALOG_OPEN; answer the dialog first. An operation that opens one returns early with it in pendingDialogs; it may still be applied, fully or partly, once the dialog is answered, so read the page state again before retrying it. A navigation the page refuses to leave creates a beforeunload dialog; accepting it repeats the navigation, except with retryAfterAccept (form posts, unknown targets): then repeat the action yourself.
- handledDialogs lists dialogs and blocked actions settled since your previous call, with kind, origin, outcome (accepted, dismissed, left, stayed, uploaded, saved, denied, timed-out, cancelled or blocked), answerer (agent, user or auto), files, and text for an accepted prompt.
- Blocked actions: external app links such as mailto:, screen sharing, file system pickers, folder uploads, printing and Bluetooth are refused in the built-in browser and reported in notices and handledDialogs. Downloads save automatically without a dialog and are reported the same way. Sign-in and certificate prompts are not supported; they are cancelled and reported in notices. WAITING_FOR_USER means only the user can continue; ask them instead of retrying.

History and downloads:
- browser.get_history and browser.get_downloads read retained records across conversations in the current application profile, newest first (up to 200 history entries or 100 downloads).
- Download records include status and an optional savePath; query again for progress. A recorded path does not guarantee the file still exists. Times are Unix milliseconds and sizes are bytes; totalBytes=0 may mean unknown.`;

export const DESKTOP_BROWSER_MCP_TOOL = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  inputSchema: BROWSER_RUN_TOOL_SCHEMA,
} as const;

export interface DesktopBrowserMcpHandle {
  readonly url: string;
  readonly token: string;
  readonly config: {
    transport: 'http';
    url: string;
    headers: { Authorization: string };
  };
  close(): Promise<void>;
}

export interface DesktopBrowserAgentControl {
  enabled(): boolean;
  onDidChange(listener: (enabled: boolean) => void): () => void;
}

export interface DesktopBrowserAccess {
  allows(sessionId: string | undefined): boolean;
  resolveRun?(sessionId: string | undefined, run: BrowserSubagentRun): DesktopBrowserSubagentRun | null;
}

export const DESKTOP_BROWSER_UNAVAILABLE_NOTICE = 'tell the user (or your parent agent) that the built-in browser is unavailable and why.';

export const DESKTOP_BROWSER_BLOCKED_GUIDANCE = `Use WebSearch, FetchURL, or other available tools if they fit the task. If the task specifically requires the built-in browser or no suitable tool is available, ${DESKTOP_BROWSER_UNAVAILABLE_NOTICE}`;

export function describeBlockedDesktopBrowser(reason: string): string {
  return `${reason} ${DESKTOP_BROWSER_BLOCKED_GUIDANCE}`;
}

export const DESKTOP_BROWSER_CONTROL_OFF_REASON = 'Agent control of the built-in browser is turned off in Kimi Code Settings > Browser, so `mcp__desktop_browser__run` is unavailable. The user can turn it back on there.';

export const DESKTOP_BROWSER_DISABLED_ERROR = describeBlockedDesktopBrowser(DESKTOP_BROWSER_CONTROL_OFF_REASON);
export const DESKTOP_BROWSER_SUBAGENT_RUN_ERROR = describeBlockedDesktopBrowser(DESKTOP_BROWSER_SUBAGENT_RUN_REASON);

const ALWAYS_ALLOWED: DesktopBrowserAccess = { allows: () => true };

export interface StartDesktopBrowserMcpOptions {
  readonly token?: string;
  readonly access?: DesktopBrowserAccess;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

function browserOperationOf(args: unknown): BrowserOperationResultEvent['operation'] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'unknown';
  const operation = (args as Record<string, unknown>)['operation'];
  return BROWSER_OPERATIONS.find(item => item === operation) ?? 'unknown';
}

function createProtocolServer(sessionId: string | undefined, access: DesktopBrowserAccess): Server {
  const protocolServer = new Server(
    { name: 'desktop_browser', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  protocolServer.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: access.allows(sessionId) ? [DESKTOP_BROWSER_MCP_TOOL] : [] }),
  );
  protocolServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const startedAt = Date.now();
    let operation = browserOperationOf(request.params.arguments);
    let caller: BrowserOperationResultEvent['caller'] = 'main';
    let errorCode: BrowserOperationErrorCode | undefined = 'INTERNAL_ERROR';
    try {
      if (request.params.name !== TOOL_NAME) {
        errorCode = 'UNKNOWN_TOOL';
        return {
          content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
          isError: true,
        };
      }
      if (!access.allows(sessionId)) {
        errorCode = 'CONTROL_DISABLED';
        return { content: [{ type: 'text', text: DESKTOP_BROWSER_DISABLED_ERROR }], isError: true };
      }
      let args = request.params.arguments;
      let run: DesktopBrowserSubagentRun | undefined;
      if (typeof args === 'object' && args !== null && !Array.isArray(args) && Object.hasOwn(args, DESKTOP_BROWSER_SUBAGENT_RUN)) {
        const stripped = { ...args } as Record<string, unknown>;
        const identity = stripped[DESKTOP_BROWSER_SUBAGENT_RUN];
        delete stripped[DESKTOP_BROWSER_SUBAGENT_RUN];
        args = stripped;
        if (!browserValidators.subagentRun.Check(identity)) {
          errorCode = 'SUBAGENT_RUN_INVALID';
          return { content: [{ type: 'text', text: DESKTOP_BROWSER_SUBAGENT_RUN_ERROR }], isError: true };
        }
        run = access.resolveRun?.(sessionId, identity) ?? undefined;
        if (run === undefined) {
          errorCode = 'SUBAGENT_RUN_INVALID';
          return { content: [{ type: 'text', text: DESKTOP_BROWSER_SUBAGENT_RUN_ERROR }], isError: true };
        }
        caller = 'subagent';
      }
      const requestOptions = { isLocalFileAddress: isAgentLocalFileAddress };
      const input = asBrowserRunRequest(args, requestOptions);
      if (input === null) {
        errorCode = 'INVALID_ARGS';
        return {
          content: [{ type: 'text', text: describeInvalidBrowserRunRequest(args, requestOptions) }],
          isError: true,
        };
      }
      const result = run === undefined
        ? await runBrowserAutomation(input, extra.signal, sessionId)
        : await runBrowserAutomation(input, extra.signal, sessionId, run);
      operation = result.operation;
      errorCode = result.ok ? undefined : result.error?.code ?? 'INTERNAL_ERROR';
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
      > = [{ type: 'text', text: formatBrowserToolResult(result) }];
      const image = result.visual ?? result.crop;
      if (image !== undefined) {
        content.push({
          type: 'image',
          data: image.data,
          mimeType: image.mimeType,
        });
      }
      return { content, isError: !result.ok };
    } finally {
      try {
        trySendDesktopEvent('browser_operation_result', {
          operation,
          ok: errorCode === undefined,
          ...(errorCode === undefined ? {} : { error_code: errorCode }),
          duration_ms: Date.now() - startedAt,
          caller,
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
        });
      } catch {}
    }
  });
  return protocolServer;
}

export async function startDesktopBrowserMcp(
  options: StartDesktopBrowserMcpOptions = {},
): Promise<DesktopBrowserMcpHandle> {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const access = options.access ?? ALWAYS_ALLOWED;
  const sessions = new Map<
    string,
    { server: Server; transport: StreamableHTTPServerTransport; owner: string | undefined }
  >();

  const httpServer = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); }
    catch { response.writeHead(400).end('invalid request target'); return; }
    if (url.pathname !== '/mcp') {
      response.writeHead(404).end('not found');
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const rawSessionId = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unknown MCP session' }));
        return;
      }
      void session.transport.handleRequest(request, response).catch(async (error: unknown) => {
        sessions.delete(sessionId);
        rejectRequest(response, error);
        await session.server.close().catch(() => undefined);
      });
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'MCP session id is required' }));
      return;
    }
    void (async () => {
      const rawOwner = request.headers['x-kimi-session-id'];
      const owner = typeof rawOwner === 'string' ? rawOwner : undefined;
      const server = createProtocolServer(owner, access);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        await server.close().catch(() => undefined);
        throw error;
      }
      const createdId = transport.sessionId;
      if (createdId === undefined) {
        await server.close().catch(() => undefined);
        return;
      }
      sessions.set(createdId, { server, transport, owner });
      transport.onclose = () => {
        sessions.delete(createdId);
      };
      if (owner === undefined) return;
      for (const [id, previous] of sessions) {
        if (id === createdId || previous.owner !== owner) continue;
        sessions.delete(id);
        void previous.server.close().catch(() => undefined);
      }
    })().catch((error: unknown) => {
      rejectRequest(response, error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/mcp`;
  let closed = false;
  return {
    url,
    token,
    config: {
      transport: 'http',
      url,
      headers: { Authorization: `Bearer ${token}` },
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(
        [...sessions.values()].map(({ server }) => server.close().catch(() => undefined)),
      );
      sessions.clear();
      await closeHttpServer(httpServer).catch(() => undefined);
    },
  };
}
