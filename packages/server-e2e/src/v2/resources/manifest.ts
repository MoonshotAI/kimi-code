/**
 * `/api/v2` resource manifest — the SDK's view of the server surface.
 *
 * Mirrors `server-v2/src/transport/actionMap.ts` exactly (same
 * `resource:action` set, same `readonly` flags). The runtime proxies and the
 * derived TypeScript shapes are both built from these tables, so the resource
 * tree and its types can never disagree.
 *
 * A drift test (`test/v2/actionMap.test.ts`) cross-checks these manifests
 * against the server's `actionMap`; a server change that adds/removes an
 * action fails the test until the manifest (and types) catch up.
 */
import type { ActionMeta } from '../transport/rpcProxy.js';

type Manifest = Record<string, Record<string, ActionMeta>>;

const RO: ActionMeta = { readonly: true };
const RW: ActionMeta = {};

/** Core scope — `/api/v2/<resource>:<action>`. */
export const CORE = {
  sessions: { list: RO, get: RO, countActive: RO },
  workspaces: { list: RO, get: RO, createOrTouch: RW, update: RW, delete: RW },
  config: {
    get: RO,
    getAll: RO,
    inspect: RO,
    diagnostics: RO,
    set: RW,
    replace: RW,
    reload: RW,
  },
  providers: { list: RO, get: RO, set: RW, delete: RW },
  oauth: { startLogin: RW, getFlow: RO, cancelLogin: RW, logout: RW, status: RO },
  auth: { summarize: RO, ensureReady: RW },
  flags: { snapshot: RO, enabled: RO, enabledIds: RO, explain: RO, explainAll: RO },
  plugins: {
    list: RO,
    install: RW,
    setEnabled: RW,
    setMcpServerEnabled: RW,
    remove: RW,
    reload: RW,
    getInfo: RO,
    listCommands: RO,
    checkUpdates: RO,
  },
  fs: { browse: RO, home: RO },
  meta: { getEnv: RO, detect: RO },
} as const satisfies Manifest;

/** Session scope — `/api/v2/session/<sid>/<resource>:<action>`. */
export const SESSION = {
  session: {
    read: RO,
    update: RW,
    setTitle: RW,
    setArchived: RW,
    status: RO,
    isIdle: RO,
    archive: RW,
  },
  approvals: { listPending: RO, request: RW, decide: RW },
  questions: { listPending: RO, ask: RW, answer: RW },
  interactions: { listPending: RO, request: RW, respond: RW },
  workspace: {
    resolve: RO,
    isWithin: RO,
    setWorkDir: RW,
    addAdditionalDir: RW,
    removeAdditionalDir: RW,
  },
  fs: { search: RO, grep: RO, gitStatus: RO, diff: RO },
} as const satisfies Manifest;

/** Agent scope — `/api/v2/session/<sid>/agent/<aid>/<resource>:<action>`. */
export const AGENT = {
  goal: { get: RO, create: RW, pause: RW, resume: RW, cancel: RW },
  plan: { status: RO, enter: RW, exit: RW, cancel: RW, clear: RW },
  tasks: { list: RO, get: RO, readOutput: RO, stop: RW, detach: RW },
  usage: { status: RO },
  context: { status: RO },
  swarm: { isActive: RO, enter: RW, exit: RW },
  permission: { getMode: RO, setMode: RW },
  permissionRules: { list: RO, addRules: RW },
  profile: {
    get: RO,
    getModel: RO,
    getSystemPrompt: RO,
    getActiveToolNames: RO,
    setModel: RW,
    setThinking: RW,
  },
  messages: { list: RO, splice: RW },
  mcp: { list: RO, reconnect: RW },
  tools: { list: RO },
  prompts: { submit: RW, steer: RW, undo: RW, clear: RW, cancel: RW },
  shell: { run: RW, cancel: RW },
  plugins: { activateCommand: RW },
} as const satisfies Manifest;

export type CoreManifest = typeof CORE;
export type SessionManifest = typeof SESSION;
export type AgentManifest = typeof AGENT;

/** Flatten a manifest to a sorted list of `resource:action` strings. */
export function flattenManifest(manifest: Manifest): string[] {
  const out: string[] = [];
  for (const resource of Object.keys(manifest)) {
    for (const action of Object.keys(manifest[resource]!)) {
      out.push(`${resource}:${action}`);
    }
  }
  return out.sort();
}
