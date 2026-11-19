import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decode } from '@toon-format/toon';

import { BROWSER_AUTOMATION_PROTOCOL } from '../../src/shared/browser-automation';

export interface BrowserDialogEvent {
  readonly dialogId?: string;
  readonly tabId?: string;
  readonly kind: string;
  readonly origin?: string;
  readonly message?: string;
  readonly answerer?: string;
  readonly outcome?: string;
  readonly retryAfterAccept?: true;
}

export interface BrowserElementRow {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
}

export interface BrowserResult {
  readonly ok: boolean;
  readonly operation: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly tab?: { readonly tabId: string; readonly url: string; readonly visible: boolean };
  readonly elements?: { readonly snapshotId: string; readonly elements: readonly BrowserElementRow[] };
  readonly dialog?: { readonly dialogId: string; readonly kind: string; readonly outcome: string };
  readonly pendingDialogs?: readonly BrowserDialogEvent[];
  readonly handledDialogs?: readonly BrowserDialogEvent[];
  readonly notices?: readonly string[];
  readonly [key: string]: unknown;
}

export interface BrowserTarget {
  readonly role?: string;
  readonly name: string | RegExp;
}

export interface BrowserDialogLog {
  readonly notices: string[];
  readonly handled: BrowserDialogEvent[];
  readonly poll: () => Promise<BrowserDialogEvent[]>;
}

export interface BrowserAgent {
  readonly sessionId: string;
  readonly run: (operation: string, params?: Record<string, unknown>) => Promise<BrowserResult>;
  readonly openTab: (url: string) => Promise<string>;
  readonly click: (tabId: string, target: BrowserTarget) => Promise<BrowserResult>;
  readonly hover: (tabId: string, target: BrowserTarget) => Promise<BrowserResult>;
  readonly typeText: (tabId: string, target: BrowserTarget, text: string) => Promise<BrowserResult>;
  readonly selectOption: (tabId: string, target: BrowserTarget, value: string) => Promise<BrowserResult>;
  readonly dialogLog: (tabId: string, first?: BrowserResult) => BrowserDialogLog;
  readonly close: () => Promise<void>;
}

const matches = (row: BrowserElementRow, target: BrowserTarget): boolean =>
  (target.role === undefined || row.role === target.role)
  && (typeof target.name === 'string' ? row.name === target.name : target.name.test(row.name));

export async function connectBrowserAgent(mcpUrl: string, token: string, sessionId: string): Promise<BrowserAgent> {
  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'kimi-desktop-e2e', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Kimi-Session-Id': sessionId } },
    });
    await client.connect(transport);
    return client;
  };
  let client = await connect();
  const callRun = (operation: string, params: Record<string, unknown>) =>
    client.callTool({ name: 'run', arguments: { protocol: BROWSER_AUTOMATION_PROTOCOL, operation, ...params } });
  const run = async (operation: string, params: Record<string, unknown> = {}): Promise<BrowserResult> => {
    let response: Awaited<ReturnType<typeof callRun>>;
    try {
      response = await callRun(operation, params);
    } catch (error) {
      if (!String(error).includes('unknown MCP session')) throw error;
      const replaced = client;
      client = await connect();
      void replaced.close().catch(() => undefined);
      response = await callRun(operation, params);
    }
    const content = response.content as Array<{ type: string; text?: string }>;
    const text = content.find(part => part.type === 'text')?.text ?? '';
    try {
      return (text.trimStart().startsWith('{') ? JSON.parse(text) : decode(text)) as BrowserResult;
    } catch {
      throw new Error(`Unparseable browser tool result for ${operation}: ${text.slice(0, 500)}`);
    }
  };
  const runOk = async (operation: string, params: Record<string, unknown>): Promise<BrowserResult> => {
    const result = await run(operation, params);
    if (!result.ok) throw new Error(`${operation} failed: ${JSON.stringify(result.error)}`);
    return result;
  };
  const act = async (operation: string, tabId: string, target: BrowserTarget, params: Record<string, unknown> = {}): Promise<BrowserResult> => {
    const snapshot = await run('page.elements.snapshot', { tabId });
    const row = snapshot.elements?.elements.find(candidate => matches(candidate, target));
    if (row === undefined) throw new Error(`No ${target.role ?? 'element'} named ${String(target.name)} in tab ${tabId}: ${JSON.stringify(snapshot)}`);
    return run(operation, { tabId, snapshotId: snapshot.elements!.snapshotId, ref: row.ref, ...params });
  };
  return {
    sessionId,
    run,
    openTab: async (url) => {
      const tabId = (await runOk('browser.create_tab', { url })).tab!.tabId;
      await runOk('tab.wait_for_load', { tabId, state: 'complete' });
      await runOk('browser.switch_tab', { tabId });
      return tabId;
    },
    click: (tabId, target) => act('page.element.click', tabId, target),
    hover: (tabId, target) => act('page.element.hover', tabId, target),
    typeText: (tabId, target, text) => act('page.element.type_text', tabId, target, { text }),
    selectOption: (tabId, target, value) => act('page.element.select_option', tabId, target, { value }),
    dialogLog: (tabId, first) => {
      const notices = [...(first?.notices ?? [])];
      const handled = [...(first?.handledDialogs ?? [])];
      return {
        notices,
        handled,
        poll: async () => {
          const state = await run('tab.get_state', { tabId });
          notices.push(...(state.notices ?? []));
          handled.push(...(state.handledDialogs ?? []));
          return handled;
        },
      };
    },
    close: () => client.close(),
  };
}
