/**
 * Static analyzer for the `agent-core-v2` service graph.
 *
 * Discovers services registered via `registerScopedService(...)` and, for each
 * impl class, records four kinds of edges to other services:
 *
 *  - `ctor`     — constructor DI (`@IToken` param decorators)
 *  - `accessor` — runtime lookups (`<expr>.get(IToken)`)
 *  - `publish`/`subscribe` — `IEventService` usage from a class field
 *  - `signal`/`append`/`on` — `IAgentRecordService` usage from a class field
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
  type InterfaceDeclaration,
  type Node,
  type ParameterDeclaration,
  Project,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';

import type { Edge, EdgeKind, EdgeRef, Graph, ServiceNode, ServiceScope } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PKG_ROOT = resolve(__dirname, '..', '..', '..');
export const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
export const SRC_ROOT = join(PKG_ROOT, 'src');
export const SNAPSHOT_PATH = join(PKG_ROOT, '.local', 'dep-graph.json');

const EVENT_BUS_TOKENS = new Set(['IEventService', 'IAgentRecordService']);

const EVENT_METHOD_KIND: Record<string, EdgeKind> = {
  publish: 'publish',
  subscribe: 'subscribe',
  append: 'emit',
  signal: 'emit',
  on: 'on',
};

const SCOPE_ORDER: ServiceScope[] = ['App', 'Session', 'Agent'];
const SCOPE_LEVEL: Record<ServiceScope, number> = { App: 0, Session: 1, Agent: 2 };

const FRAMEWORK_BINDINGS: readonly { token: string; scope: ServiceScope; impl: string }[] = [
  { token: 'IInstantiationService', scope: 'App', impl: 'InstantiationService' },
  { token: 'IKaos', scope: 'App', impl: 'Kaos' },
  { token: 'ILogOptions', scope: 'App', impl: 'LogOptions' },
  { token: 'IBootstrapOptions', scope: 'App', impl: 'BootstrapOptions' },
  { token: 'ISessionContext', scope: 'Session', impl: 'SessionContext' },
  { token: 'IAgentScopeContext', scope: 'Agent', impl: 'AgentScopeContext' },
];

const PRODUCTION_OVERRIDES: readonly { token: string; scope: ServiceScope; impl: string }[] = [
  { token: 'IFileSystemStorageService', scope: 'App', impl: 'FileStorageService' },
  { token: 'ISkillDiscovery', scope: 'App', impl: 'FileSkillDiscovery' },
];

export function nodeId(scope: ServiceScope, token: string): string {
  return `${scope}::${token}`;
}

type Bindings = Map<string, Map<ServiceScope, ServiceNode>>;

function resolveFromScope(
  bindings: Bindings,
  token: string,
  sourceScope: ServiceScope,
): ServiceNode | undefined {
  const scopeMap = bindings.get(token);
  if (!scopeMap) return undefined;
  const sourceLevel = SCOPE_LEVEL[sourceScope];
  for (let lvl = sourceLevel; lvl >= 0; lvl--) {
    const s = SCOPE_ORDER[lvl];
    const hit = scopeMap.get(s);
    if (hit) return hit;
  }
  return undefined;
}

interface EdgeAccumulator {
  services: ServiceNode[];
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
  overrideScope?: ServiceScope,
): void {
  const target = resolveFromScope(acc.bindings, token, overrideScope ?? source.scope);

  let toId: string;
  let extra: Pick<Edge, 'unresolved' | 'scopeMismatch' | 'actualScope'>;
  if (target) {
    toId = target.id;
    extra = {};
  } else {
    const scopeMap = acc.bindings.get(token);
    const actualScope = scopeMap ? innermostScope(scopeMap) : undefined;
    if (actualScope !== undefined) {
      toId = `scopeMismatch::${token}`;
      extra = { scopeMismatch: true as const, actualScope };
    } else {
      toId = `unresolved::${token}`;
      extra = { unresolved: true as const };
    }
  }

  const key = edgeKey(fromId, toId, kind);
  const existing = acc.edges.get(key);
  if (existing) {
    if (!existing.refs.some((r) => sameRef(r, ref))) {
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
    ...extra,
  };
  acc.edges.set(key, edge);
  if (extra.unresolved) acc.unknownRefs.add(token);
}

function innermostScope(scopeMap: Map<ServiceScope, ServiceNode>): ServiceScope | undefined {
  let best: ServiceScope | undefined;
  let bestLevel = -1;
  for (const s of scopeMap.keys()) {
    const lvl = SCOPE_LEVEL[s];
    if (lvl > bestLevel) {
      bestLevel = lvl;
      best = s;
    }
  }
  return best;
}

function sameRef(a: EdgeRef, b: EdgeRef): boolean {
  return (
    a.file === b.file &&
    a.line === b.line &&
    (a.fromMethod ?? '') === (b.fromMethod ?? '') &&
    (a.toMethod ?? '') === (b.toMethod ?? '')
  );
}

function collectInterfaces(sourceFiles: SourceFile[]): Map<string, InterfaceDeclaration> {
  const out = new Map<string, InterfaceDeclaration>();
  for (const file of sourceFiles) {
    for (const iface of file.getInterfaces()) {
      const name = iface.getName();
      if (!name) continue;
      out.set(name, iface);
    }
  }
  return out;
}

function collectInterfaceMembers(iface: InterfaceDeclaration): string[] {
  const names = new Set<string>();
  for (const member of iface.getMembers()) {
    const kind = member.getKind();
    if (kind === SyntaxKind.MethodSignature) {
      const name = member.asKindOrThrow(SyntaxKind.MethodSignature).getName();
      names.add(name);
    } else if (kind === SyntaxKind.PropertySignature) {
      const name = member.asKindOrThrow(SyntaxKind.PropertySignature).getName();
      if (name === '_serviceBrand') continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

function readRegistration(
  call: CallExpression,
): { token: string; impl: string; scope: ServiceScope; domain: string; line: number } | undefined {
  const args = call.getArguments();
  if (args.length < 3) return undefined;

  const scopeArg = args[0];
  const tokenArg = args[1];
  const implArg = args[2];
  const domainArg = args[4];

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
      if (!scopeMap.has(reg.scope)) scopeMap.set(reg.scope, node);
    }
  }

  return { services, implClasses, bindings };
}

function readCtor(cls: ClassDeclaration): {
  ctorDeps: { token: string; line: number }[];
  injectedFields: Map<string, string>;
} {
  const ctorDeps: { token: string; line: number }[] = [];
  const injectedFields = new Map<string, string>();

  const ctors = cls.getConstructors();
  if (ctors.length === 0) return { ctorDeps, injectedFields };
  const ctor = ctors[0];

  for (const param of ctor.getParameters()) {
    const decorators = param.getDecorators();
    let paramToken: string | undefined;
    for (const dec of decorators) {
      const decName = dec.getName();
      if (!decName.startsWith('I')) continue;
      ctorDeps.push({ token: decName, line: dec.getStartLineNumber() });
      paramToken = decName;
    }
    if (paramToken === undefined) continue;
    const fieldName = fieldNameOf(param);
    if (fieldName) injectedFields.set(fieldName, paramToken);
  }

  return { ctorDeps, injectedFields };
}

function fieldNameOf(param: ParameterDeclaration): string | undefined {
  const modifiers = param.getModifiers().map((m) => m.getText());
  if (modifiers.some((m) => m === 'private' || m === 'protected' || m === 'public')) {
    return param.getName();
  }
  return undefined;
}

function enclosingMethodName(node: Node): string | undefined {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    const kind = cur.getKind();
    if (kind === SyntaxKind.MethodDeclaration) {
      const m = cur.asKindOrThrow(SyntaxKind.MethodDeclaration);
      return m.getName();
    }
    if (kind === SyntaxKind.Constructor) return '<ctor>';
    if (kind === SyntaxKind.GetAccessor) {
      const g = cur.asKindOrThrow(SyntaxKind.GetAccessor);
      return `get ${g.getName()}`;
    }
    if (kind === SyntaxKind.SetAccessor) {
      const s = cur.asKindOrThrow(SyntaxKind.SetAccessor);
      return `set ${s.getName()}`;
    }
    if (kind === SyntaxKind.PropertyDeclaration) {
      const p = cur.asKindOrThrow(SyntaxKind.PropertyDeclaration);
      return `<field ${p.getName()}>`;
    }
    if (kind === SyntaxKind.ClassDeclaration) return undefined;
    cur = cur.getParent();
  }
  return undefined;
}

function chainedMethodName(getCall: CallExpression): string | undefined {
  const parent = getCall.getParent();
  if (!parent || parent.getKind() !== SyntaxKind.PropertyAccessExpression) return undefined;
  const pae = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
  if (pae.getExpression() !== getCall) return undefined;
  const grandparent = pae.getParent();
  if (!grandparent || grandparent.getKind() !== SyntaxKind.CallExpression) return undefined;
  const outer = grandparent.asKindOrThrow(SyntaxKind.CallExpression);
  if (outer.getExpression() !== pae) return undefined;
  return pae.getName();
}

const HANDLE_ALIAS_SCOPE: Record<string, ServiceScope> = {
  IAppScopeHandle: 'App',
  ISessionScopeHandle: 'Session',
  IAgentScopeHandle: 'Agent',
};

const FUNCTION_LIKE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.MethodDeclaration,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

function stripTypeWrappers(text: string): string {
  let t = text.trim();
  t = t.replace(/\s*\|\s*(undefined|null)\s*/g, '').trim();
  const promise = /^Promise\s*<\s*(.+?)\s*>$/.exec(t);
  if (promise) t = promise[1].trim();
  t = t.replace(/\[\]\s*$/, '').trim();
  t = t.replace(/^readonly\s+/, '').trim();
  return t;
}

function handleScopeFromTypeText(text: string | undefined): ServiceScope | undefined {
  if (text === undefined) return undefined;
  const t = stripTypeWrappers(text);
  const alias = HANDLE_ALIAS_SCOPE[t];
  if (alias !== undefined) return alias;
  const generic = /^IScopeHandle\s*<\s*LifecycleScope\.(App|Session|Agent)\s*>$/.exec(t);
  if (generic) return generic[1] as ServiceScope;
  return undefined;
}

function enclosingFunction(node: Node): Node | undefined {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    if (FUNCTION_LIKE_KINDS.has(cur.getKind())) return cur;
    cur = cur.getParent();
  }
  return undefined;
}

function getParams(fn: Node): ParameterDeclaration[] {
  return (fn as unknown as { getParameters(): ParameterDeclaration[] }).getParameters();
}

function isAccessorReceiver(node: Node): boolean {
  if (node.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  return node.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName() === 'accessor';
}

function collectInterfaceMethodReturns(
  interfacesByName: Map<string, InterfaceDeclaration>,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [name, iface] of interfacesByName) {
    const methods = new Map<string, string>();
    for (const member of iface.getMembers()) {
      if (member.getKind() === SyntaxKind.MethodSignature) {
        const m = member.asKindOrThrow(SyntaxKind.MethodSignature);
        const rt = m.getReturnTypeNode()?.getText();
        if (rt) methods.set(m.getName(), rt);
      }
    }
    out.set(name, methods);
  }
  return out;
}

function inferExprTypeText(
  expr: Node,
  cls: ClassDeclaration,
  ifaceMethods: Map<string, Map<string, string>>,
  fn: Node,
  depth = 0,
): string | undefined {
  if (depth > 6) return undefined;
  const kind = expr.getKind();

  if (kind === SyntaxKind.AwaitExpression) {
    const inner = (expr as unknown as { getExpression(): Node }).getExpression();
    return inferExprTypeText(inner, cls, ifaceMethods, fn, depth + 1);
  }

  if (kind === SyntaxKind.AsExpression || kind === SyntaxKind.NonNullExpression) {
    const inner = (expr as unknown as { getExpression(): Node }).getExpression();
    return inferExprTypeText(inner, cls, ifaceMethods, fn, depth + 1);
  }

  if (kind === SyntaxKind.CallExpression) {
    const call = expr.asKindOrThrow(SyntaxKind.CallExpression);
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return undefined;
    const pae = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const methodName = pae.getName();
    const base = pae.getExpression();

    if (methodName === 'get' && isAccessorReceiver(base)) {
      const first = call.getArguments()[0];
      if (first && first.getKind() === SyntaxKind.Identifier) return first.getText();
      return undefined;
    }

    if (base.getKind() === SyntaxKind.ThisKeyword) {
      return cls.getMethod(methodName)?.getReturnTypeNode()?.getText();
    }

    const baseType = inferExprTypeText(base, cls, ifaceMethods, fn, depth + 1);
    if (baseType === undefined) return undefined;
    return ifaceMethods.get(stripTypeWrappers(baseType))?.get(methodName);
  }

  if (kind === SyntaxKind.Identifier) {
    return resolveIdentifierTypeText(expr, cls, ifaceMethods, fn, depth + 1);
  }

  if (kind === SyntaxKind.PropertyAccessExpression) {
    const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (pae.getExpression().getKind() === SyntaxKind.ThisKeyword) {
      return thisFieldTypeText(cls, pae.getName());
    }
    return undefined;
  }

  if (kind === SyntaxKind.BinaryExpression) {
    const bin = expr.asKindOrThrow(SyntaxKind.BinaryExpression);
    if (bin.getOperatorToken().getKind() === SyntaxKind.QuestionQuestionToken) {
      return (
        inferExprTypeText(bin.getLeft(), cls, ifaceMethods, fn, depth + 1) ??
        inferExprTypeText(bin.getRight(), cls, ifaceMethods, fn, depth + 1)
      );
    }
    return undefined;
  }

  if (kind === SyntaxKind.ConditionalExpression) {
    const cond = expr.asKindOrThrow(SyntaxKind.ConditionalExpression);
    return (
      inferExprTypeText(cond.getWhenTrue(), cls, ifaceMethods, fn, depth + 1) ??
      inferExprTypeText(cond.getWhenFalse(), cls, ifaceMethods, fn, depth + 1)
    );
  }

  return undefined;
}

function thisFieldTypeText(cls: ClassDeclaration, fieldName: string): string | undefined {
  const ctor = cls.getConstructors()[0];
  if (ctor) {
    for (const p of ctor.getParameters()) {
      if (p.getName() !== fieldName) continue;
      const t = p.getTypeNode()?.getText();
      if (t) return t;
    }
  }
  return cls.getProperty(fieldName)?.getTypeNode()?.getText();
}

function resolveIdentifierTypeText(
  id: Node,
  cls: ClassDeclaration,
  ifaceMethods: Map<string, Map<string, string>>,
  fn: Node,
  depth: number,
): string | undefined {
  const name = id.getText();

  for (const p of getParams(fn)) {
    if (p.getName() === name) {
      const t = p.getTypeNode()?.getText();
      if (t) return t;
    }
  }

  const decls = fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  for (const decl of decls) {
    if (decl.getName() !== name) continue;
    if (decl.getStart() > id.getStart()) continue;
    const annotated = decl.getTypeNode()?.getText();
    if (annotated) return annotated;
    const init = decl.getInitializer();
    if (init) {
      const inferred = inferExprTypeText(init, cls, ifaceMethods, fn, depth + 1);
      if (inferred) return inferred;
    }
  }
  return undefined;
}

function inferAccessorScope(
  getCall: CallExpression,
  cls: ClassDeclaration,
  ifaceMethods: Map<string, Map<string, string>>,
): ServiceScope | undefined {
  const getExpr = getCall.getExpression();
  if (getExpr.getKind() !== SyntaxKind.PropertyAccessExpression) return undefined;
  const receiver = getExpr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression();
  if (!isAccessorReceiver(receiver)) return undefined;
  const obj = receiver.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression();
  const fn = enclosingFunction(getCall);
  if (fn === undefined) return undefined;
  return handleScopeFromTypeText(inferExprTypeText(obj, cls, ifaceMethods, fn));
}

function collectRuntimeEdges(
  cls: ClassDeclaration,
  source: ServiceNode,
  injectedFields: Map<string, string>,
  acc: EdgeAccumulator,
  ifaceMethods: Map<string, Map<string, string>>,
): void {
  const filePath = relFromRepo(cls.getSourceFile().getFilePath());

  for (const call of cls.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const pae = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const methodName = pae.getName();
    const line = call.getStartLineNumber();
    const fromMethod = enclosingMethodName(call);
    const baseRef: EdgeRef = { file: filePath, line };
    if (fromMethod !== undefined) baseRef.fromMethod = fromMethod;

    if (methodName === 'get') {
      const args = call.getArguments();
      if (args.length === 0) continue;
      const first = args[0];
      if (first.getKind() !== SyntaxKind.Identifier) continue;
      const tokenName = first.getText();
      if (!tokenName.startsWith('I')) continue;
      if (tokenName === source.token) continue;
      const toMethod = chainedMethodName(call);
      const ref: EdgeRef = { ...baseRef };
      if (toMethod !== undefined) ref.toMethod = toMethod;
      const accessorScope = inferAccessorScope(call, cls, ifaceMethods);
      pushEdge(acc, source.id, source, tokenName, 'accessor', ref, accessorScope);
      continue;
    }

    const receiver = pae.getExpression();
    let fieldName: string | undefined;
    if (receiver.getKind() === SyntaxKind.PropertyAccessExpression) {
      const inner = receiver.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (inner.getExpression().getKind() === SyntaxKind.ThisKeyword) {
        fieldName = inner.getName();
      }
    } else if (receiver.getKind() === SyntaxKind.Identifier) {
      fieldName = receiver.getText();
    }
    if (fieldName === undefined) continue;

    const fieldToken = injectedFields.get(fieldName);
    if (fieldToken === undefined) continue;
    if (fieldToken === source.token) continue;

    if (EVENT_BUS_TOKENS.has(fieldToken)) {
      const eventKind = EVENT_METHOD_KIND[methodName];
      if (eventKind === undefined) continue;
      pushEdge(acc, source.id, source, fieldToken, eventKind, baseRef);
      continue;
    }

    const ref: EdgeRef = { ...baseRef, toMethod: methodName };
    pushEdge(acc, source.id, source, fieldToken, 'ctor', ref);
  }
}

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
  const interfacesByName = collectInterfaces(sourceFiles);
  const ifaceMethods = collectInterfaceMethodReturns(interfacesByName);

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

  for (const override of PRODUCTION_OVERRIDES) {
    const id = nodeId(override.scope, override.token);
    const cls = implClasses.get(override.impl);
    const file = cls ? relFromRepo(cls.getSourceFile().getFilePath()) : SRC_ROOT;
    const domain = cls ? domainOf(cls.getSourceFile().getFilePath()) : 'unknown';
    const line = cls ? cls.getStartLineNumber() : 0;
    const node: ServiceNode = {
      id,
      token: override.token,
      impl: override.impl,
      scope: override.scope,
      domain,
      file,
      line,
    };
    const existingIndex = services.findIndex((s) => s.id === id);
    if (existingIndex >= 0) {
      services[existingIndex] = node;
    } else {
      services.push(node);
    }
    let scopeMap = bindings.get(override.token);
    if (!scopeMap) {
      scopeMap = new Map();
      bindings.set(override.token, scopeMap);
    }
    scopeMap.set(override.scope, node);
  }

  const acc: EdgeAccumulator = {
    services,
    edges: new Map(),
    bindings,
    unknownRefs: new Set(),
  };

  for (const svc of services) {
    const iface = interfacesByName.get(svc.token);
    if (!iface) continue;
    const members = collectInterfaceMembers(iface);
    if (members.length > 0) svc.publicMembers = members;
  }

  for (const svc of services) {
    const cls = implClasses.get(svc.impl);
    if (!cls) continue;
    const { ctorDeps, injectedFields } = readCtor(cls);
    const filePath = relFromRepo(cls.getSourceFile().getFilePath());
    for (const dep of ctorDeps) {
      if (dep.token === svc.token) continue;
      pushEdge(acc, svc.id, svc, dep.token, 'ctor', { file: filePath, line: dep.line });
    }
    collectRuntimeEdges(cls, svc, injectedFields, acc, ifaceMethods);
  }

  const nodeById = new Map(services.map((s) => [s.id, s]));
  const unresolvedReferrers = new Map<string, Set<ServiceScope>>();
  for (const edge of acc.edges.values()) {
    if (!edge.unresolved) continue;
    let scopes = unresolvedReferrers.get(edge.token);
    if (!scopes) {
      scopes = new Set();
      unresolvedReferrers.set(edge.token, scopes);
    }
    const source = nodeById.get(edge.from);
    if (source) scopes.add(source.scope);
  }
  for (const [token, scopes] of unresolvedReferrers) {
    let scope: ServiceScope = 'App';
    let minLevel = Number.POSITIVE_INFINITY;
    for (const s of scopes) {
      const lvl = SCOPE_LEVEL[s];
      if (lvl < minLevel) {
        minLevel = lvl;
        scope = s;
      }
    }
    const node: ServiceNode = {
      id: `unresolved::${token}`,
      token,
      impl: token,
      scope,
      domain: 'unresolved',
      file: '',
      line: 0,
      unresolved: true,
    };
    const iface = interfacesByName.get(token);
    if (iface) {
      const members = collectInterfaceMembers(iface);
      if (members.length > 0) node.publicMembers = members;
    }
    services.push(node);
  }

  const mismatchTokens = new Map<string, ServiceScope>();
  for (const edge of acc.edges.values()) {
    if (!edge.scopeMismatch || edge.actualScope === undefined) continue;
    if (!mismatchTokens.has(edge.token)) mismatchTokens.set(edge.token, edge.actualScope);
  }
  for (const [token, scope] of mismatchTokens) {
    const registered = acc.bindings.get(token)?.get(scope);
    const node: ServiceNode = {
      id: `scopeMismatch::${token}`,
      token,
      impl: token,
      scope,
      domain: registered?.domain ?? 'unknown',
      file: '',
      line: 0,
      scopeMismatch: true,
    };
    const iface = interfacesByName.get(token);
    if (iface) {
      const members = collectInterfaceMembers(iface);
      if (members.length > 0) node.publicMembers = members;
    }
    services.push(node);
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

export function writeSnapshot(graph: Graph, path: string = SNAPSHOT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`);
}

export function summarize(graph: Graph): string {
  const byKind = new Map<string, number>();
  for (const e of graph.edges) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  const kindSummary = [...byKind.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  return `services=${graph.services.length} edges=${graph.edges.length} ${kindSummary}`;
}
