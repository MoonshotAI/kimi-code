/**
 * Generates `docs/state-manifest.d.ts` — the single place to see every state
 * key registered into the four scoped state services (App-scope
 * `IAppStateService`, Workspace-scope `IWorkspaceStateService`, Session-scope
 * `ISessionStateService`, Agent-scope `IAgentStateService`).
 *
 * Pure static pass (state keys are registered inside DI scope constructors, so
 * there is no process-level registry to drain the way `gen-wire-manifest`
 * does):
 *   1. A ts-morph scan of `src/{app,workspace,session,agent}/**` collects
 *      every top-level `defineState('name', ...)` key constant.
 *   2. Every `.register(key)` call site resolves its argument back to a key
 *      constant (following imports); the key joins the scope of the
 *      registering file (`src/app/**` → App, `src/workspace/**` → Workspace,
 *      `src/session/**` → Session, `src/agent/**` → Agent).
 *      A key that is defined but never registered is excluded.
 *
 * The output is a self-contained `.d.ts`: each key's value type is the
 * compile-time `StateKey<T>` parameter, expanded fully inline through the type
 * checker — no imports and no helper declarations. Every named type is marked
 * at its expansion site with an inline `TypeName — source/file.ts` comment;
 * recursion stops with a `TypeName — recursive` marker on an `unknown`. Generic
 * instantiations are expanded structurally and classes render as their public
 * instance shape; only lib globals (`Map`/`Set`/…) and a few noted external
 * ambient types keep their names.
 *
 * Usage:
 *   pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest          # write the file
 *   pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest --check  # freshness check (CI-style)
 *
 * Freshness is also enforced by `test/state/stateManifest.test.ts`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type Identifier,
  type Signature,
  type Symbol as MorphSymbol,
  type Type as MorphType,
  type VariableDeclaration,
} from 'ts-morph';

const PKG = join(import.meta.dirname, '..');
const REPO_ROOT = join(PKG, '..', '..');
const SRC = join(PKG, 'src');
export const MANIFEST_PATH = join(PKG, 'docs', 'state-manifest.d.ts');

/** src first-level directory → manifest section. */
const SCOPES = [
  {
    dir: 'app',
    label: 'App',
    interfaceName: 'AppStateSnapshot',
    keyUnionName: 'AppStateKey',
  },
  {
    dir: 'workspace',
    label: 'Workspace',
    interfaceName: 'WorkspaceStateSnapshot',
    keyUnionName: 'WorkspaceStateKey',
  },
  {
    dir: 'session',
    label: 'Session',
    interfaceName: 'SessionStateSnapshot',
    keyUnionName: 'SessionStateKey',
  },
  {
    dir: 'agent',
    label: 'Agent',
    interfaceName: 'AgentStateSnapshot',
    keyUnionName: 'AgentStateKey',
  },
] as const;

type ScopeDir = (typeof SCOPES)[number]['dir'];

interface KeyDef {
  readonly constName: string;
  readonly keyName: string;
  /** Absolute path of the file defining the key constant. */
  readonly file: string;
  readonly exported: boolean;
  readonly declaration: VariableDeclaration;
}

interface Registration {
  readonly def: KeyDef;
  readonly scope: ScopeDir;
}

interface StateManifestModel {
  readonly registrations: readonly Registration[];
  /** Keys defined under the scope dirs but never registered (dead candidates). */
  readonly unregistered: readonly KeyDef[];
}

function scopeDirOf(file: string): ScopeDir | undefined {
  const first = relative(SRC, file).split(/[\\/]/)[0];
  return SCOPES.some((scope) => scope.dir === first) ? (first as ScopeDir) : undefined;
}

/** Package-root-relative posix path (used in index/comment columns). */
function srcRelative(file: string): string {
  return relative(PKG, file).split('\\').join('/');
}

/** Repo-root-relative posix path (used in type-name comments). */
function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

/** Quote a property key only when it is not a plain identifier. */
function tsFieldKey(key: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(key) ? key : JSON.stringify(key);
}

// ---------------------------------------------------------------------------
// Static pass — key constants and their register call sites
// ---------------------------------------------------------------------------

/** Pass 1 — every top-level `defineState('name', ...)` constant under the scope dirs. */
function collectKeyDefs(project: Project): Map<VariableDeclaration, KeyDef> {
  const defs = new Map<VariableDeclaration, KeyDef>();
  for (const sf of project.getSourceFiles()) {
    if (scopeDirOf(sf.getFilePath()) === undefined) continue;
    for (const statement of sf.getVariableStatements()) {
      for (const declaration of statement.getDeclarations()) {
        const initializer = declaration.getInitializer();
        if (initializer === undefined || !Node.isCallExpression(initializer)) continue;
        if (initializer.getExpression().getText() !== 'defineState') continue;
        const [nameArg] = initializer.getArguments();
        if (nameArg === undefined || !Node.isStringLiteral(nameArg)) continue;
        defs.set(declaration, {
          constName: declaration.getName(),
          keyName: nameArg.getLiteralValue(),
          file: sf.getFilePath(),
          exported: statement.isExported(),
          declaration,
        });
      }
    }
  }
  return defs;
}

/** Resolve a `.register(...)` argument back to its `defineState` constant. */
function resolveKeyDef(
  identifier: Identifier,
  defs: ReadonlyMap<VariableDeclaration, KeyDef>,
): KeyDef | undefined {
  for (const info of identifier.getDefinitions()) {
    const node = info.getDeclarationNode();
    if (node !== undefined && Node.isVariableDeclaration(node)) {
      const def = defs.get(node);
      if (def !== undefined) return def;
    }
  }
  return undefined;
}

/** Pass 2 — every `.register(key)` call site whose argument is a state key. */
function collectRegistrations(
  project: Project,
  defs: ReadonlyMap<VariableDeclaration, KeyDef>,
): Registration[] {
  const registrations: Registration[] = [];
  const seen = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    const scope = scopeDirOf(sf.getFilePath());
    if (scope === undefined) continue;
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== 'register') {
        continue;
      }
      const args = call.getArguments();
      const [arg] = args;
      if (args.length !== 1 || arg === undefined || !Node.isIdentifier(arg)) continue;
      const def = resolveKeyDef(arg, defs);
      if (def === undefined) continue;
      if (!def.exported) {
        throw new Error(
          `[gen-state-manifest] state key '${def.keyName}' (${srcRelative(def.file)}) is ` +
            'registered but its key constant is not exported — the manifest cannot reference it.',
        );
      }
      const dedupe = `${scope}:${def.keyName}`;
      if (seen.has(dedupe)) {
        throw new Error(
          `[gen-state-manifest] state key '${def.keyName}' is registered twice in ${scope} scope.`,
        );
      }
      seen.add(dedupe);
      registrations.push({ def, scope });
    }
  }
  return registrations;
}

function createProject(): Project {
  const project = new Project({
    tsConfigFilePath: join(PKG, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths(join(SRC, '**', '*.ts'));
  return project;
}

// ---------------------------------------------------------------------------
// Type expansion — render every key's value type fully inline.
//
// Every named type declared in the repo is expanded at the use site and marked
// with a `/* TypeName — source/file.ts */` comment; a recursion point stops
// with a `/* TypeName — recursive (...) */ unknown` marker. Types from lib
// (`Map`, `Set`, `Date`, …) or node_modules are ambient and keep their names
// (type arguments are still rendered recursively). Generic instantiations and
// anonymous shapes are expanded structurally from their apparent members, so
// the checker always hands us substituted, concrete member types.
// ---------------------------------------------------------------------------

const NO_TRUNCATION = ts.TypeFormatFlags.NoTruncation;

class TypeRenderer {
  private readonly checker: ts.TypeChecker;
  /** Cycle guard for anonymous / generic-instantiation structural expansion. */
  private readonly expanding = new Set<ts.Type>();
  /** Named types currently being expanded along this path (recursion guard). */
  private readonly expandingNamed: ts.Symbol[] = [];
  /** Ambient names kept as-is whose declaration lives outside the TS lib. */
  readonly externals = new Set<string>();
  /** Degradations worth reporting (cycle fallbacks). */
  readonly warnings = new Set<string>();

  constructor(private readonly project: Project) {
    this.checker = project.getTypeChecker().compilerObject;
  }

  /** Render the value type `T` of a key's `StateKey<T>`. */
  renderKeyType(def: KeyDef): string {
    const valueType = def.declaration.getType().getTypeArguments()[0];
    if (valueType === undefined) {
      throw new Error(
        `[gen-state-manifest] cannot resolve the value type of '${def.keyName}' (${srcRelative(def.file)}).`,
      );
    }
    return this.renderType(valueType, def.declaration, 0);
  }

  // -- core dispatch --------------------------------------------------------

  private renderType(
    type: MorphType,
    location: Node,
    depth: number,
    skipSymbol?: ts.Symbol,
  ): string {
    if (depth > 40) return this.fallback(type, location, 'depth cap');

    // A single enum-literal type (e.g. `FaultKind.A`) — value + enum comment.
    if ((type.getFlags() & ts.TypeFlags.EnumLiteral) !== 0) {
      return this.renderEnumLiteral(type);
    }

    // The boolean union (`false | true`) collapses to `boolean`.
    if (type.isUnion() && (type.getFlags() & ts.TypeFlags.Boolean) !== 0) return 'boolean';

    if (type.isUnion()) {
      const alias = this.tryRenderAlias(type, location, depth, skipSymbol);
      if (alias !== undefined) return alias;
      const enumUnion = this.tryRenderEnumUnion(type);
      if (enumUnion !== undefined) return enumUnion;
      return this.renderUnionMembers(type.getUnionTypes(), location, depth);
    }

    if (type.isIntersection()) {
      const alias = this.tryRenderAlias(type, location, depth, skipSymbol);
      if (alias !== undefined) return alias;
      return type
        .getIntersectionTypes()
        .map((member) => this.renderType(member, location, depth + 1))
        .join(' & ');
    }

    if (this.isLeaf(type)) return this.leafText(type);

    if (type.isTuple()) {
      const elements = type
        .getTupleElements()
        .map((element) => this.renderType(element, location, depth + 1));
      return `[${elements.join(', ')}]`;
    }

    if (type.isArray()) {
      const element = type.getArrayElementType();
      if (element === undefined) return this.fallback(type, location, 'array without element');
      const rendered = this.renderType(element, location, depth + 1);
      const text =
        element.isUnion() || element.isIntersection() ? `(${rendered})[]` : `${rendered}[]`;
      return type.getSymbol()?.getName() === 'ReadonlyArray' ? `readonly ${text}` : text;
    }

    if (type.isObject()) {
      return this.renderObjectType(type, location, depth, skipSymbol);
    }

    return this.fallback(type, location, 'unhandled type kind');
  }

  /**
   * Render union members: a `false | true` pair anywhere collapses to
   * `boolean`, `null`/`undefined` sort last, duplicates removed, and parens
   * are only added when the union actually has multiple members.
   */
  private renderUnionMembers(
    members: readonly MorphType[],
    location: Node,
    depth: number,
  ): string {
    const booleanLiterals = members.filter((m) => m.isBooleanLiteral());
    const collapseBoolean =
      booleanLiterals.length === 2 &&
      new Set(booleanLiterals.map((m) => this.leafText(m))).size === 2;
    const rest = collapseBoolean ? members.filter((m) => !m.isBooleanLiteral()) : members;
    const rank = (type: MorphType): number => (type.isNull() ? 1 : type.isUndefined() ? 2 : 0);
    const rendered = rest
      .map((member) => ({ member, rank: rank(member) }))
      .toSorted((a, b) => a.rank - b.rank)
      .map(({ member }) => ({
        member,
        text: this.renderType(member, location, depth + 1),
      }));
    const multi = rendered.length + (collapseBoolean ? 1 : 0) > 1;
    const parts = rendered.map(({ member, text }) =>
      multi && this.needsParensInUnion(member) ? `(${text})` : text,
    );
    if (collapseBoolean) parts.unshift('boolean');
    return [...new Set(parts)].join(' | ');
  }

  private isLeaf(type: MorphType): boolean {
    const flags = type.getFlags();
    return (
      type.isString() ||
      type.isNumber() ||
      type.isBoolean() ||
      type.isStringLiteral() ||
      type.isNumberLiteral() ||
      type.isBooleanLiteral() ||
      type.isNull() ||
      type.isUndefined() ||
      type.isUnknown() ||
      type.isAny() ||
      type.isNever() ||
      type.isTypeParameter() ||
      (flags &
        (ts.TypeFlags.Void |
          ts.TypeFlags.BigInt |
          ts.TypeFlags.BigIntLiteral |
          ts.TypeFlags.ESSymbol |
          ts.TypeFlags.UniqueESSymbol |
          ts.TypeFlags.TemplateLiteral)) !==
        0
    );
  }

  /** typeToString is only safe on leaf types (never emits `import(...)`). */
  private leafText(type: MorphType): string {
    const text = this.checker.typeToString(type.compilerType, undefined, NO_TRUNCATION);
    // Normalize double-quoted string literals to the repo's single-quote style.
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      const value = JSON.parse(text) as string;
      return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
    }
    return text;
  }

  private needsParensInUnion(type: MorphType): boolean {
    return type.isIntersection() || (type.isObject() && type.getCallSignatures().length > 0);
  }

  private fallback(type: MorphType, location: Node, reason: string): string {
    const text = this.checker.typeToString(type.compilerType, location.compilerNode, NO_TRUNCATION);
    this.warnings.add(`${reason}: fell back to '${text.slice(0, 80)}'`);
    return text;
  }

  // -- enums ----------------------------------------------------------------

  /** The literal value of an enum-literal type, quoted TS-style. */
  private enumLiteralValue(type: MorphType): string {
    const value = (type.compilerType as ts.LiteralType).value;
    if (typeof value === 'string') {
      return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
    }
    if (typeof value === 'number') return String(value);
    return this.leafText(type);
  }

  /** The enum declaration backing an enum-literal type, if any. */
  private enumDeclOf(type: MorphType): Node | undefined {
    const memberDecl = type.getSymbol()?.getDeclarations()[0];
    if (memberDecl === undefined || !Node.isEnumMember(memberDecl)) return undefined;
    return memberDecl.getParent();
  }

  private renderEnumLiteral(type: MorphType): string {
    const enumDecl = this.enumDeclOf(type);
    const text = this.enumLiteralValue(type);
    if (enumDecl !== undefined && Node.isEnumDeclaration(enumDecl)) {
      const sym = enumDecl.getSymbol();
      if (sym !== undefined) {
        return `/* ${sym.getName()} — ${repoRelative(enumDecl.getSourceFile().getFilePath())} */ ${text}`;
      }
    }
    return text;
  }

  /** Collapse a union covering every member of one enum: comment + values. */
  private tryRenderEnumUnion(type: MorphType): string | undefined {
    const members = type.getUnionTypes();
    if (members.length === 0) return undefined;
    let enumDecl: Node | undefined;
    for (const member of members) {
      if ((member.getFlags() & ts.TypeFlags.EnumLiteral) === 0) return undefined;
      const parent = this.enumDeclOf(member);
      if (parent === undefined) return undefined;
      if (enumDecl === undefined) enumDecl = parent;
      else if (parent !== enumDecl) return undefined;
    }
    if (enumDecl === undefined || !Node.isEnumDeclaration(enumDecl)) return undefined;
    if (enumDecl.getMembers().length !== members.length) return undefined;
    const sym = enumDecl.getSymbol();
    if (sym === undefined) return undefined;
    const values = members.map((member) => this.enumLiteralValue(member));
    return `/* ${sym.getName()} — ${repoRelative(enumDecl.getSourceFile().getFilePath())} */ ${values.join(' | ')}`;
  }

  // -- named-type annotation --------------------------------------------------

  /**
   * Where do the symbol's declarations live: repo ('named' — expand inline
   * with a name comment), lib/node_modules ('ambient' — keep the name), or
   * mixed/anonymous ('inline' — expand without a comment).
   */
  private classify(sym: MorphSymbol): 'named' | 'ambient' | 'inline' {
    const decls = sym.getDeclarations();
    if (decls.length === 0) return 'inline';
    const inNodeModules = (file: string) => /[\\/]node_modules[\\/]/.test(file);
    if (decls.every((d) => !inNodeModules(d.getSourceFile().getFilePath()))) {
      const named = decls.some(
        (d) =>
          Node.isInterfaceDeclaration(d) ||
          Node.isClassDeclaration(d) ||
          Node.isTypeAliasDeclaration(d) ||
          Node.isEnumDeclaration(d),
      );
      const generic = decls.some(
        (d) =>
          (Node.isInterfaceDeclaration(d) ||
            Node.isClassDeclaration(d) ||
            Node.isTypeAliasDeclaration(d)) &&
          d.getTypeParameters().length > 0,
      );
      return named && !generic ? 'named' : 'inline';
    }
    if (decls.every((d) => inNodeModules(d.getSourceFile().getFilePath()))) return 'ambient';
    return 'inline';
  }

  private noteExternal(sym: MorphSymbol): void {
    const isTsLib = (file: string) => /[\\/]node_modules[\\/]typescript[\\/]lib[\\/]/.test(file);
    if (sym.getDeclarations().some((d) => !isTsLib(d.getSourceFile().getFilePath()))) {
      this.externals.add(sym.getName());
    }
  }

  /**
   * `Name — origin` comment prefixed to the expansion. A named type already
   * on the expansion path stops with a recursion marker instead.
   */
  private renderNamed(sym: MorphSymbol, expand: () => string): string {
    const decl = sym.getDeclarations()[0];
    const origin =
      decl !== undefined
        ? repoRelative(decl.getSourceFile().getFilePath())
        : '(unknown source)';
    const name = sym.getName();
    if (this.expandingNamed.includes(sym.compilerSymbol)) {
      return `/* ${name} — recursive (${origin}) */ unknown`;
    }
    this.expandingNamed.push(sym.compilerSymbol);
    try {
      return `/* ${name} — ${origin} */ ${expand()}`;
    } finally {
      this.expandingNamed.pop();
    }
  }

  /**
   * Render a type through the alias it was referenced with, when that alias is
   * worth keeping: a repo-declared non-generic alias expands inline under its
   * name comment; a lib or node_modules alias (`Readonly`, `Record`,
   * `Partial`, …) is referenced as `Name<args>` with recursive arguments.
   * `skipSymbol` suppresses the alias's own annotation while its right-hand
   * side is being rendered (the alias type still carries itself as aliasSymbol).
   */
  private tryRenderAlias(
    type: MorphType,
    location: Node,
    depth: number,
    skipSymbol?: ts.Symbol,
  ): string | undefined {
    const alias = type.getAliasSymbol();
    if (alias === undefined || alias.compilerSymbol === skipSymbol) return undefined;
    const kind = this.classify(alias);
    if (kind === 'named') {
      const decl = alias.getDeclarations().find((d) => Node.isTypeAliasDeclaration(d));
      if (decl === undefined || !Node.isTypeAliasDeclaration(decl)) return undefined;
      return this.renderNamed(alias, () =>
        this.renderType(decl.getType(), decl, depth + 1, alias.compilerSymbol),
      );
    }
    if (kind === 'ambient') {
      const args = type.getAliasTypeArguments();
      if (args.length === 0) return undefined;
      this.noteExternal(alias);
      const rendered = args.map((arg) => this.renderType(arg, location, depth + 1));
      return `${alias.getName()}<${rendered.join(', ')}>`;
    }
    return undefined;
  }

  // -- object types -----------------------------------------------------------

  private renderObjectType(
    type: MorphType,
    location: Node,
    depth: number,
    skipSymbol?: ts.Symbol,
  ): string {
    const alias = this.tryRenderAlias(type, location, depth, skipSymbol);
    if (alias !== undefined) return alias;
    const sym = type.getSymbol();
    const typeArgs = type.getTypeArguments();
    // `__type`/`__object` are checker names for anonymous shapes — they are
    // never real symbols, so skip the named-type paths and expand structurally.
    const anonymous = sym === undefined || /^__(type|object)$/.test(sym.getName());
    if (!anonymous && sym.compilerSymbol !== skipSymbol) {
      const kind = this.classify(sym);
      if (kind === 'named' && typeArgs.length === 0) {
        return this.renderNamed(sym, () => this.renderStructural(type, location, depth));
      }
      if (kind === 'ambient') {
        this.noteExternal(sym);
        const name = sym.getName();
        if (typeArgs.length === 0) return name;
        const args = typeArgs.map((arg) => this.renderType(arg, location, depth + 1));
        return `${name}<${args.join(', ')}>`;
      }
    }
    return this.renderStructural(type, location, depth);
  }

  /** Structural rendering from the type's apparent members (braced or arrow). */
  private renderStructural(type: MorphType, location: Node, depth: number): string {
    // Cycle guard for self-referential instantiations expanded inline.
    if (this.expanding.has(type.compilerType)) {
      return this.fallback(type, location, 'cycle expanding');
    }
    this.expanding.add(type.compilerType);
    try {
      const callSignatures = type.getCallSignatures();
      const props = type.getProperties().filter((prop) => this.isPublic(prop));
      const stringIndex = type.getStringIndexType();
      const numberIndex = type.getNumberIndexType();
      if (
        callSignatures.length > 0 &&
        props.length === 0 &&
        stringIndex === undefined &&
        numberIndex === undefined
      ) {
        if (callSignatures.length === 1 && callSignatures[0] !== undefined) {
          return this.renderSignature(callSignatures[0], location, depth, 'arrow');
        }
        return callSignatures
          .map((sig) => `(${this.renderSignature(sig, location, depth, 'arrow')})`)
          .join(' & ');
      }
      const body = this.renderObjectBody(type, location, depth, callSignatures, props);
      if (body.length === 0) return '{}';
      return `{\n${body.join('\n')}\n}`;
    } finally {
      this.expanding.delete(type.compilerType);
    }
  }

  /** Member lines of an object type, each indented by two spaces. */
  private renderObjectBody(
    type: MorphType,
    location: Node,
    depth: number,
    callSignatures?: readonly Signature[],
    props?: readonly MorphSymbol[],
  ): string[] {
    const lines: string[] = [];
    for (const sig of callSignatures ?? type.getCallSignatures()) {
      lines.push(`  ${this.renderSignature(sig, location, depth, 'call')};`);
    }
    for (const prop of props ?? type.getProperties().filter((p) => this.isPublic(p))) {
      const decl = prop.getDeclarations()[0];
      const at = decl ?? location;
      const propType = prop.getTypeAtLocation(at);
      const optional = (prop.getFlags() & ts.SymbolFlags.Optional) !== 0;
      // An optional prop's `| undefined` is redundant with the `?` — drop it.
      const rendered =
        optional && propType.isUnion()
          ? this.renderUnionMembers(
              propType.getUnionTypes().filter((member) => !member.isUndefined()),
              at,
              depth,
            )
          : this.renderType(propType, at, depth + 1);
      const readonly =
        decl !== undefined && Node.isPropertySignature(decl) && decl.isReadonly()
          ? 'readonly '
          : '';
      const propLines = rendered.split('\n');
      propLines[propLines.length - 1] += ';';
      lines.push(
        `  ${readonly}${tsFieldKey(prop.getName())}${optional ? '?' : ''}: ${propLines[0]}`,
        ...propLines.slice(1).map((line) => `  ${line}`),
      );
    }
    const stringIndex = type.getStringIndexType();
    if (stringIndex !== undefined) {
      lines.push(`  [key: string]: ${this.renderType(stringIndex, location, depth + 1)};`);
    }
    const numberIndex = type.getNumberIndexType();
    if (numberIndex !== undefined) {
      lines.push(`  [key: number]: ${this.renderType(numberIndex, location, depth + 1)};`);
    }
    return lines;
  }

  private renderSignature(
    sig: Signature,
    location: Node,
    depth: number,
    style: 'arrow' | 'call',
  ): string {
    const params: string[] = [];
    for (const param of sig.getParameters()) {
      if (param.getName() === 'this') continue;
      const decl = param.getDeclarations()[0];
      const at = decl ?? location;
      const paramType = param.getTypeAtLocation(at);
      let optional = (param.getFlags() & ts.SymbolFlags.Optional) !== 0;
      let rest = false;
      if (decl !== undefined && Node.isParameterDeclaration(decl)) {
        optional = optional || decl.hasQuestionToken() || decl.getInitializer() !== undefined;
        rest = decl.isRestParameter();
      }
      const rendered =
        optional && paramType.isUnion()
          ? this.renderUnionMembers(
              paramType.getUnionTypes().filter((member) => !member.isUndefined()),
              at,
              depth,
            )
          : this.renderType(paramType, at, depth + 1);
      params.push(`${rest ? '...' : ''}${param.getName()}${optional ? '?' : ''}: ${rendered}`);
    }
    const returnType = this.renderType(sig.getReturnType(), location, depth + 1);
    return style === 'arrow'
      ? `(${params.join(', ')}) => ${returnType}`
      : `(${params.join(', ')}): ${returnType}`;
  }

  private isPublic(prop: MorphSymbol): boolean {
    if (prop.getName().startsWith('#')) return false;
    return !prop.getDeclarations().some((decl) => {
      const modifiers = ts.canHaveModifiers(decl.compilerNode)
        ? ts.getModifiers(decl.compilerNode)
        : undefined;
      return (
        modifiers !== undefined &&
        modifiers.some(
          (m) =>
            m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
        )
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Manifest rendering
// ---------------------------------------------------------------------------

function renderManifest(
  model: StateManifestModel,
  project: Project,
): { manifest: string; warnings: readonly string[] } {
  const renderer = new TypeRenderer(project);
  const byScope = new Map<ScopeDir, Registration[]>();
  for (const scope of SCOPES) byScope.set(scope.dir, []);
  for (const registration of model.registrations) byScope.get(registration.scope)?.push(registration);
  for (const [dir, regs] of byScope) {
    byScope.set(
      dir,
      regs.toSorted((a, b) => a.def.keyName.localeCompare(b.def.keyName)),
    );
  }

  // Snapshot interfaces — rendering these fills the external-name registry.
  const sections: string[] = [];
  for (const scope of SCOPES) {
    const regs = byScope.get(scope.dir) ?? [];
    const lines = [
      `/** ${scope.label}-scope keys registered into I${scope.label}StateService. */`,
      `export interface ${scope.interfaceName} {`,
    ];
    const byFile = new Map<string, Registration[]>();
    for (const r of regs) {
      const list = byFile.get(r.def.file) ?? [];
      list.push(r);
      byFile.set(r.def.file, list);
    }
    for (const file of [...byFile.keys()].toSorted()) {
      lines.push(`  // ${srcRelative(file)}`);
      for (const r of byFile.get(file) ?? []) {
        const rendered = renderer.renderKeyType(r.def).split('\n');
        rendered[rendered.length - 1] += ';';
        lines.push(`  '${r.def.keyName}': ${rendered[0]}`, ...rendered.slice(1).map((l) => `  ${l}`));
      }
    }
    lines.push('}');
    lines.push('');
    lines.push(`export type ${scope.keyUnionName} = keyof ${scope.interfaceName};`);
    sections.push(lines.join('\n'));
  }

  const counts = SCOPES.map((s) => `${s.label}: ${byScope.get(s.dir)?.length ?? 0} keys`).join(
    ' · ',
  );
  const out: string[] = [
    '// App, Workspace, Session & Agent State Manifest',
    '//',
    '// Generated by scripts/gen-state-manifest.mts — do not edit by hand.',
    '// Regenerate with: pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest',
    '//',
    '// Every state key registered into the App-scope IAppStateService, the',
    '// Workspace-scope IWorkspaceStateService, the Session-scope',
    '// ISessionStateService, or the Agent-scope IAgentStateService (see',
    '// src/_base/state/stateRegistry.ts), collected statically from the',
    '// `states.register(...)` call sites — a key defined via',
    '// defineState but never registered does not appear here. Each entry shows the',
    '// compile-time StateKey<T> value type fully expanded inline, so the manifest is',
    '// self-contained (no imports, no helper declarations). A named type is marked',
    '// at its expansion site with a `/* TypeName — source/file.ts */` comment; a',
    '// `/* TypeName — recursive (...) */ unknown` marker stops a recursive expansion.',
    '// Lib globals (Map/Set/Record/…) are referenced as-is. Generic instantiations',
    '// expand structurally; classes render as their public instance shape. The',
    '// defining source file heads each group.',
  ];
  if (renderer.externals.size > 0) {
    out.push(
      '//',
      `// External ambient types referenced but not expanded (from node_modules): ${[...renderer.externals].toSorted().join(', ')}`,
    );
  }
  out.push(
    '//',
    '// snapshot() returns JSON-safe deep copies of these values: Maps become plain',
    '// objects (or [key, value] entry arrays when a key is not string/number), Sets',
    '// become arrays, bigints become strings, functions are dropped, circular',
    "// references become '(circular)', and class instances collapse to a '(ClassName)'",
    '// marker — the wire shape of an entry is the JSON projection of the type here.',
    '//',
    `// Index (${counts})`,
  );
  for (const scope of SCOPES) {
    const regs = byScope.get(scope.dir) ?? [];
    const width = Math.max(0, ...regs.map((r) => r.def.keyName.length));
    out.push(`//   ${scope.label}`);
    for (const r of regs) {
      out.push(`//     ${r.def.keyName.padEnd(width)}  ${srcRelative(r.def.file)}`);
    }
  }
  out.push('');
  out.push(...sections.flatMap((section) => [section, '']));
  return { manifest: `${out.join('\n').trimEnd()}\n`, warnings: [...renderer.warnings] };
}

interface BuildResult {
  readonly model: StateManifestModel;
  readonly manifest: string;
  readonly warnings: readonly string[];
}

function buildAll(): BuildResult {
  const project = createProject();
  const defs = collectKeyDefs(project);
  const registrations = collectRegistrations(project, defs);
  const registered = new Set(registrations.map((r) => r.def));
  const unregistered = [...defs.values()].filter((def) => !registered.has(def));
  const model: StateManifestModel = { registrations, unregistered };
  const { manifest, warnings } = renderManifest(model, project);
  return { model, manifest, warnings };
}

export function buildStateManifest(): string {
  return buildAll().manifest;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const check = process.argv.includes('--check');
  const { model, manifest, warnings } = buildAll();
  for (const warning of warnings) {
    console.warn(`[gen-state-manifest] warning: ${warning}`);
  }
  if (check) {
    let current: string | undefined;
    try {
      current = readFileSync(MANIFEST_PATH, 'utf-8');
    } catch {
      current = undefined;
    }
    if (current !== manifest) {
      console.error(
        `[gen-state-manifest] ${relative(process.cwd(), MANIFEST_PATH)} is stale. ` +
          'Regenerate with `pnpm --filter @moonshot-ai/agent-core-v2 gen:state-manifest`.',
      );
      process.exit(1);
    }
    console.log('[gen-state-manifest] up to date');
    return;
  }
  writeFileSync(MANIFEST_PATH, manifest);
  console.log(`[gen-state-manifest] wrote ${relative(process.cwd(), MANIFEST_PATH)}`);
  if (model.unregistered.length > 0) {
    console.log(
      `[gen-state-manifest] note: ${model.unregistered.length} defineState key(s) never registered (excluded):`,
    );
    for (const def of model.unregistered) {
      console.log(`  - ${def.keyName} (${srcRelative(def.file)})`);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
