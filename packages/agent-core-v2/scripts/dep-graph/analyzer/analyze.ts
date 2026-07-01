/**
 * Static analyzer for the `agent-core-v2` service graph.
 *
 * Discovers services registered via `registerScopedService(...)` and, for each
 * impl class, records four kinds of edges to other services:
 *
 *  - `ctor`     — constructor DI (`@IToken` param decorators)
 *  - `accessor` — runtime lookups (`<expr>.get(IToken)`)
 *  - `publish`/`subscribe` — `IEventService` usage from a class field
 *  - `emit`/`on`           — `IAgentEventSinkService` usage from a class field
 *
 * Deliberately parse-only (no type checker) so the whole tree runs in ~1s.
 * We rely on the codebase convention that constructor DI params carry an
 * explicit type annotation matching the injected token — that's how we know
 * which field holds an event bus without asking the type checker.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CallExpression,
  type ClassDeclaration,
  type ParameterDeclaration,
  Project,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';

import type { Edge, EdgeKind, EdgeRef, Graph, ServiceNode, ServiceScope } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root — three levels above `scripts/dep-graph/analyzer/`. */
export const PKG_ROOT = resolve(__dirname, '..', '..', '..');
export const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
export const SRC_ROOT = join(PKG_ROOT, 'src');
export const SNAPSHOT_PATH = join(PKG_ROOT, '.local', 'dep-graph.json');

const EVENT_BUS_TOKENS = new Set(['IEventService', 'IAgentEventSinkService']);

const EVENT_METHOD_KIND: Record<string, EdgeKind> = {
  publish: 'publish',
  subscribe: 'subscribe',
  emit: 'emit',
  on: 'on',
};

const SCOPE_ORDER: ServiceScope[] = ['App', 'Session', 'Agent'];
const SCOPE_LEVEL: Record<ServiceScope, number> = { App: 0, Session: 1, Agent: 2 };

/**
 * Framework tokens seeded via `ServiceCollection.set(id, value)` at scope
 * construction time rather than `registerScopedService`. The analyzer never
 * sees a `registerScopedService` for them, so we synthesise virtual bindings
 * so edges targeting them resolve rather than showing up as "unresolved".
 *
 * The scope tags reflect *where the seed lives*: `ISessionContext` is set
 * on the Session collection, `IKaos` on App, etc. — this matches the
 * bootstrap composition roots in `bootstrap/appContainer.ts` and friends.
 */
const FRAMEWORK_BINDINGS: readonly { token: string; scope: ServiceScope; impl: string }[] = [
  { token: 'IInstantiationService', scope: 'App', impl: 'InstantiationService' },
  { token: 'IKaos', scope: 'App', impl: 'Kaos' },
  { token: 'ILogOptions', scope: 'App', impl: 'LogOptions' },
  { token: 'IBootstrapOptions', scope: 'App', impl: 'BootstrapOptions' },
  { token: 'ISessionContext', scope: 'Session', impl: 'SessionContext' },
];

/**
 * Turn a `(scope, token)` pair into the unique node id used across the
 * graph. This matches the DI registration identity: one `registerScopedService`
 * call = one id.
 */
export function nodeId(scope: ServiceScope, token: string): string {
  return `${scope}::${token}`;
}

/**
 * Bindings map — `token → scope → ServiceNode`. Used by edge resolution to
 * find the impl visible from a given source scope.
 */
type Bindings = Map<string, Map<ServiceScope, ServiceNode>>;

/**
 * Return the `ServiceNode` that a source at `sourceScope` would receive when
 * it asks for `token`. Walks the source's scope tree from the source scope
 * downward toward App (parent), picking the innermost binding visible.
 *
 *   Source scope = Session → check Session, then App
 *   Source scope = Agent   → check Agent, then Session, then App
 *   Source scope = App     → check App only
 *
 * Returns `undefined` if nothing is registered at any visible scope — the
 * container would crash trying to resolve `token` from this source.
 */
function resolveFromScope(
  bindings: Bindings,
  token: string,
  sourceScope: ServiceScope,
): ServiceNode | undefined {
  const scopeMap = bindings.get(token);
  if (!scopeMap) return undefined;
  const sourceLevel = SCOPE_LEVEL[sourceScope];
  // Walk from source (innermost visible) up to App (root).
  for (let lvl = sourceLevel; lvl >= 0; lvl--) {
    const s = SCOPE_ORDER[lvl];
    const hit = scopeMap.get(s);
    if (hit) return hit;
  }
  return undefined;
}

interface EdgeAccumulator {
  services: ServiceNode[];
  /** `key = fromId|toId|kind` → Edge (refs merged). */
  edges: Map<string, Edge>;
  bindings: Bindings;
  unknownRefs: Set<string>;
}

function relFromRepo(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/');
}

function edgeKey(fromId: string, toId: string, kind: EdgeKind): string {
  return `${fromId}|${toId}|${kind}`;
}

function pushEdge(
  acc: EdgeAccumulator,
  fromId: string,
  source: ServiceNode,
  token: string,
  kind: EdgeKind,
  ref: EdgeRef,
): void {
  const target = resolveFromScope(acc.bindings, token, source.scope);
  const toId = target ? target.id : `unresolved::${token}`;
  const key = edgeKey(fromId, toId, kind);
  const existing = acc.edges.get(key);
  if (existing) {
    if (!existing.refs.some((r) => r.file === ref.file && r.line === ref.line)) {
      existing.refs.push(ref);
    }
    return;
  }
  const edge: Edge = {
    from: fromId,
    to: toId,
    token,
    kind,
    refs: [ref],
    ...(target ? {} : { unresolved: true as const }),
  };
  acc.edges.set(key, edge);
  if (!target) acc.unknownRefs.add(token);
}

/**
 * Extract the token identifier from a `registerScopedService(...)` call.
 * Returns `undefined` if the call doesn't match the expected shape.
 */
function readRegistration(
  call: CallExpression,
): { token: string; impl: string; scope: ServiceScope; domain: string; line: number } | undefined {
  const args = call.getArguments();
  if (args.length < 3) return undefined;

  const scopeArg = args[0];
  const tokenArg = args[1];
  const implArg = args[2];
  const domainArg = args[4];

  // scope: `LifecycleScope.App | .Session | .Agent`
  if (scopeArg.getKind() !== SyntaxKind.PropertyAccessExpression) return undefined;
  const scopeText = scopeArg.getText();
  const scope = scopeText.split('.').at(-1);
  if (scope !== 'App' && scope !== 'Session' && scope !== 'Agent') return undefined;

  if (tokenArg.getKind() !== SyntaxKind.Identifier) return undefined;
  if (implArg.getKind() !== SyntaxKind.Identifier) return undefined;

  let domain = 'unknown';
  if (domainArg?.getKind() === SyntaxKind.StringLiteral) {
    domain = domainArg.getText().slice(1, -1);
  }

  return {
    token: tokenArg.getText(),
    impl: implArg.getText(),
    scope,
    domain,
    line: call.getStartLineNumber(),
  };
}

function domainOf(absPath: string): string {
  const rel = relative(SRC_ROOT, absPath).replaceAll('\\', '/');
  return rel.split('/')[0] ?? 'unknown';
}

/**
 * Pass 1 — collect every `registerScopedService(...)` call and every impl
 * class declaration in the tree. Records the service list, the
 * impl-class-name → decl map, and the token → scope → node bindings map
 * for pass 2's edge resolution.
 */
function collectServices(sourceFiles: SourceFile[]): {
  services: ServiceNode[];
  implClasses: Map<string, ClassDeclaration>;
  bindings: Bindings;
} {
  const services: ServiceNode[] = [];
  const implClasses = new Map<string, ClassDeclaration>();
  const bindings: Bindings = new Map();

  for (const file of sourceFiles) {
    for (const cls of file.getClasses()) {
      const name = cls.getName();
      if (name) implClasses.set(name, cls);
    }
  }

  for (const file of sourceFiles) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (expr.getText() !== 'registerScopedService') continue;
      const reg = readRegistration(call);
      if (!reg) continue;
      const domain = reg.domain !== 'unknown' ? reg.domain : domainOf(file.getFilePath());
      const node: ServiceNode = {
        id: nodeId(reg.scope, reg.token),
        token: reg.token,
        impl: reg.impl,
        scope: reg.scope,
        domain,
        file: relFromRepo(file.getFilePath()),
        line: reg.line,
      };
      services.push(node);
      let scopeMap = bindings.get(reg.token);
      if (!scopeMap) {
        scopeMap = new Map();
        bindings.set(reg.token, scopeMap);
      }
      // If the same (scope, token) is registered twice we keep the first —
      // the DI container would honor the earliest binding too; a duplicate
      // is a source-code bug, not an analyzer concern.
      if (!scopeMap.has(reg.scope)) scopeMap.set(reg.scope, node);
    }
  }

  return { services, implClasses, bindings };
}

/**
 * From a class ctor, list `{decorator, param}` for every `@IToken`-decorated
 * parameter, in declaration order. Also returns the "event bus fields": params
 * whose declared type is `IEventService` or `IAgentEventSinkService`, keyed
 * by field/param name so we can find `this.<name>.publish(...)` etc.
 */
function readCtor(cls: ClassDeclaration): {
  ctorDeps: { token: string; line: number }[];
  eventBusFields: Map<string, string>;
} {
  const ctorDeps: { token: string; line: number }[] = [];
  const eventBusFields = new Map<string, string>();

  const ctors = cls.getConstructors();
  if (ctors.length === 0) return { ctorDeps, eventBusFields };
  const ctor = ctors[0];

  for (const param of ctor.getParameters()) {
    const decorators = param.getDecorators();
    for (const dec of decorators) {
      const decName = dec.getName();
      if (!decName.startsWith('I')) continue;
      ctorDeps.push({ token: decName, line: dec.getStartLineNumber() });
    }
    // Field type — for detecting event-bus fields regardless of decorator.
    const typeNode = param.getTypeNode();
    if (typeNode) {
      const typeText = typeNode.getText();
      if (EVENT_BUS_TOKENS.has(typeText)) {
        const name = fieldNameOf(param);
        if (name) eventBusFields.set(name, typeText);
      }
    }
  }

  return { ctorDeps, eventBusFields };
}

/**
 * Constructor parameter with `private readonly foo: IX` becomes a field
 * named `foo`. When only `@IX foo: IX` (no visibility modifier) is present,
 * TypeScript doesn't lift it to a field, but the codebase always uses the
 * lifted form for injected deps, so this covers the observed patterns.
 */
function fieldNameOf(param: ParameterDeclaration): string | undefined {
  const modifiers = param.getModifiers().map((m) => m.getText());
  if (modifiers.some((m) => m === 'private' || m === 'protected' || m === 'public')) {
    return param.getName();
  }
  return undefined;
}

/**
 * Pass 2 — for a given impl class, walk method bodies and detect:
 *   - `<expr>.get(IToken)`             → accessor edge
 *   - `this.<busField>.publish/...`    → publish/subscribe/emit/on edges
 */
function collectRuntimeEdges(
  cls: ClassDeclaration,
  source: ServiceNode,
  eventBusFields: Map<string, string>,
  acc: EdgeAccumulator,
): void {
  const filePath = relFromRepo(cls.getSourceFile().getFilePath());

  for (const call of cls.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const pae = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const methodName = pae.getName();
    const line = call.getStartLineNumber();
    const ref: EdgeRef = { file: filePath, line };

    if (methodName === 'get') {
      const args = call.getArguments();
      if (args.length === 0) continue;
      const first = args[0];
      if (first.getKind() !== SyntaxKind.Identifier) continue;
      const tokenName = first.getText();
      if (!tokenName.startsWith('I')) continue;
      // Ignore self-references — a service asking the accessor for itself.
      if (tokenName === source.token) continue;
      pushEdge(acc, source.id, source, tokenName, 'accessor', ref);
      continue;
    }

    const edgeKind = EVENT_METHOD_KIND[methodName];
    if (edgeKind === undefined) continue;

    // Detect `this.<field>` or `<field>` receivers where the field holds an
    // event bus. `<expr>.<field>.<method>()` patterns are ignored: those come
    // up rarely, and we would need the type checker to be sure.
    const receiver = pae.getExpression();
    let busToken: string | undefined;
    if (receiver.getKind() === SyntaxKind.PropertyAccessExpression) {
      const inner = receiver.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (inner.getExpression().getKind() === SyntaxKind.ThisKeyword) {
        busToken = eventBusFields.get(inner.getName());
      }
    } else if (receiver.getKind() === SyntaxKind.Identifier) {
      busToken = eventBusFields.get(receiver.getText());
    }
    if (!busToken) continue;
    if (busToken === source.token) continue;
    pushEdge(acc, source.id, source, busToken, edgeKind, ref);
  }
}

/**
 * Run the static analysis. `srcRoot` overrides the default `src/` (used by
 * tests). Returns a `Graph` snapshot.
 */
export function analyze(options: { srcRoot?: string; generatedAt?: string } = {}): Graph {
  const srcRoot = options.srcRoot ?? SRC_ROOT;
  const project = new Project({
    tsConfigFilePath: undefined,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: {
      allowJs: false,
      noResolve: true,
      experimentalDecorators: true,
    },
  });

  const globPattern = `${srcRoot.replaceAll('\\', '/')}/**/*.ts`;
  project.addSourceFilesAtPaths(globPattern);

  const sourceFiles = project.getSourceFiles();

  const { services, implClasses, bindings } = collectServices(sourceFiles);

  // Seed the framework tokens as synthetic nodes so edges to them resolve
  // like any other registered service. They are marked domain=`framework`
  // and file/line refer to the `bootstrap` composition root convention;
  // the UI can filter them by domain.
  const frameworkNodes: ServiceNode[] = FRAMEWORK_BINDINGS.map((b) => ({
    id: nodeId(b.scope, b.token),
    token: b.token,
    impl: b.impl,
    scope: b.scope,
    domain: 'framework',
    file: 'packages/agent-core-v2/src/_base',
    line: 0,
  }));
  for (const node of frameworkNodes) {
    services.push(node);
    let scopeMap = bindings.get(node.token);
    if (!scopeMap) {
      scopeMap = new Map();
      bindings.set(node.token, scopeMap);
    }
    if (!scopeMap.has(node.scope)) scopeMap.set(node.scope, node);
  }

  const acc: EdgeAccumulator = {
    services,
    edges: new Map(),
    bindings,
    unknownRefs: new Set(),
  };

  for (const svc of services) {
    const cls = implClasses.get(svc.impl);
    if (!cls) continue;
    const { ctorDeps, eventBusFields } = readCtor(cls);
    const filePath = relFromRepo(cls.getSourceFile().getFilePath());
    for (const dep of ctorDeps) {
      // Self-refs happen when a service also declares a param typed as
      // its own interface (rare, never legit) — skip.
      if (dep.token === svc.token) continue;
      pushEdge(acc, svc.id, svc, dep.token, 'ctor', { file: filePath, line: dep.line });
    }
    collectRuntimeEdges(cls, svc, eventBusFields, acc);
  }

  return {
    generatedAt: options.generatedAt ?? new Date(0).toISOString(),
    services: services.sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) ||
        a.impl.localeCompare(b.impl) ||
        a.scope.localeCompare(b.scope),
    ),
    edges: [...acc.edges.values()].sort(
      (a, b) =>
        a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind) || a.to.localeCompare(b.to),
    ),
    unknownTokens: [...acc.unknownRefs].sort(),
  };
}

/** Convenience: read the current git HEAD as a stable "generated at" tag. */
export function readHeadSha(): string | undefined {
  try {
    const head = readFileSync(join(REPO_ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      return readFileSync(join(REPO_ROOT, '.git', ref), 'utf8').trim();
    }
    return head;
  } catch {
    return undefined;
  }
}

/** Persist a graph snapshot to disk (creates parent dir as needed). */
export function writeSnapshot(graph: Graph, path: string = SNAPSHOT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
}

/** One-line, sortable summary of a graph — used by both the CLI and the dev-server watcher. */
export function summarize(graph: Graph): string {
  const byKind = new Map<string, number>();
  for (const e of graph.edges) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  const kindSummary = [...byKind.entries()]
    .sort()
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  return `services=${graph.services.length} edges=${graph.edges.length} ${kindSummary}`;
}
