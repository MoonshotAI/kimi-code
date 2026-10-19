import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type CallExpression,
  Node,
  Project,
  SyntaxKind,
  ts,
  type Identifier,
  type PropertyAccessExpression,
  type Signature,
  type SourceFile,
  type Symbol as MorphSymbol,
  type Type as MorphType,
  type TypeChecker,
  type VariableDeclaration,
} from 'ts-morph';

const PKG = join(import.meta.dirname, '..');
const REPO_ROOT = join(PKG, '..', '..');
const SRC = join(PKG, 'src');
export const MANIFEST_PATH = join(PKG, 'docs', 'state-manifest.d.ts');

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
  readonly file: string;
  readonly exported: boolean;
  readonly declaration: VariableDeclaration;
  readonly replayable?: {
    readonly durable: boolean;
    readonly undoable: boolean;
    readonly folds: readonly string[];
  };
}

interface Registration {
  readonly def: KeyDef;
  readonly scope: ScopeDir;
}

interface StateManifestModel {
  readonly registrations: readonly Registration[];
  readonly unregistered: readonly KeyDef[];
}

function scopeDirOf(file: string): ScopeDir | undefined {
  const first = relative(SRC, file).split(/[\\/]/)[0];
  return SCOPES.some((scope) => scope.dir === first) ? (first as ScopeDir) : undefined;
}

function isFeaturesFile(file: string): boolean {
  return relative(SRC, file).split(/[\\/]/)[0] === 'features';
}

const FEATURES_RECEIVER_SCOPE: Readonly<Record<string, ScopeDir>> = {
  IAppStateService: 'app',
  IWorkspaceStateService: 'workspace',
  ISessionStateService: 'session',
  IAgentStateService: 'agent',
};

function receiverScope(
  expression: PropertyAccessExpression,
  checker: TypeChecker,
): ScopeDir | undefined {
  const typeName = checker.getTypeAtLocation(expression.getExpression()).getSymbol()?.getName();
  return typeName === undefined ? undefined : FEATURES_RECEIVER_SCOPE[typeName];
}

function featuresRegisterScope(
  expression: PropertyAccessExpression,
  checker: TypeChecker,
  sf: SourceFile,
): ScopeDir {
  const scope = receiverScope(expression, checker);
  if (scope === undefined) {
    throw new Error(
      `[gen-state-manifest] cannot resolve the state-service scope of '${expression.getText()}' ` +
        `in ${srcRelative(sf.getFilePath())} — register through an ` +
        'I{App,Workspace,Session,Agent}StateService-typed member.',
    );
  }
  return scope;
}

function srcRelative(file: string): string {
  return relative(PKG, file).split('\\').join('/');
}

function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

function tsFieldKey(key: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(key) ? key : JSON.stringify(key);
}

function stableSymbolKey(key: string): string {
  const match = /^__@(.+)@\d+$/.exec(key);
  return match === null ? key : `__@${match[1]}`;
}

function collectKeyDefs(project: Project): Map<VariableDeclaration, KeyDef> {
  const defs = new Map<VariableDeclaration, KeyDef>();
  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (scopeDirOf(filePath) === undefined && !isFeaturesFile(filePath)) continue;
    for (const statement of sf.getVariableStatements()) {
      for (const declaration of statement.getDeclarations()) {
        const initializer = declaration.getInitializer();
        if (initializer === undefined || !Node.isCallExpression(initializer)) continue;
        const parsed = parseDefineStateChain(initializer);
        if (parsed === undefined) continue;
        defs.set(declaration, {
          constName: declaration.getName(),
          keyName: parsed.keyName,
          file: sf.getFilePath(),
          exported: statement.isExported(),
          declaration,
          replayable: parsed.replayable,
        });
      }
    }
  }
  return defs;
}

function parseDefineStateChain(
  initializer: CallExpression,
): { keyName: string; replayable?: KeyDef['replayable'] } | undefined {
  let durable = true;
  let undoable = false;
  let replayable = false;
  const folds: string[] = [];
  let current: CallExpression = initializer;
  for (;;) {
    const expression = current.getExpression();
    if (Node.isIdentifier(expression) && expression.getText() === 'defineState') {
      const [nameArg] = current.getArguments();
      if (nameArg === undefined || !Node.isStringLiteral(nameArg)) return undefined;
      return {
        keyName: nameArg.getLiteralValue(),
        replayable: replayable ? { durable, undoable, folds } : undefined,
      };
    }
    if (!Node.isPropertyAccessExpression(expression)) return undefined;
    const method = expression.getName();
    if (method === 'replayable') {
      replayable = true;
      const [arg] = current.getArguments();
      if (arg !== undefined && Node.isObjectLiteralExpression(arg)) {
        const durableProp = arg.getProperty('durable');
        if (durableProp !== undefined && Node.isPropertyAssignment(durableProp)) {
          durable = durableProp.getInitializer()?.getText() !== 'false';
        }
      }
    } else if (method === 'undoable') {
      undoable = true;
    } else if (method === 'on') {
      const [eventArg] = current.getArguments();
      if (eventArg !== undefined) folds.unshift(eventArg.getText());
    } else {
      return undefined;
    }
    const inner = expression.getExpression();
    if (!Node.isCallExpression(inner)) return undefined;
    current = inner;
  }
}

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

function collectRegistrations(
  project: Project,
  defs: ReadonlyMap<VariableDeclaration, KeyDef>,
): Registration[] {
  const checker = project.getTypeChecker();
  const registrations: Registration[] = [];
  const seen = new Map<string, string>();
  for (const sf of project.getSourceFiles()) {
    const fileScope = scopeDirOf(sf.getFilePath());
    const featuresFile = isFeaturesFile(sf.getFilePath());
    if (fileScope === undefined && !featuresFile) continue;
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (
        !Node.isPropertyAccessExpression(expression) ||
        expression.getName() !== 'contributeState'
      ) {
        continue;
      }
      const args = call.getArguments();
      const [arg] = args;
      if (args.length !== 1 || arg === undefined || !Node.isIdentifier(arg)) continue;
      const def = resolveKeyDef(arg, defs);
      if (def === undefined) continue;
      const scope = receiverScope(expression, checker) ?? fileScope ?? featuresRegisterScope(expression, checker, sf);
      if (!def.exported) {
        throw new Error(
          `[gen-state-manifest] state key '${def.keyName}' (${srcRelative(def.file)}) is ` +
            'registered but its key constant is not exported — the manifest cannot reference it.',
        );
      }
      const dedupe = `${scope}:${def.keyName}`;
      const seenFile = seen.get(dedupe);
      if (seenFile !== undefined) {
        if (seenFile === sf.getFilePath()) continue;
        throw new Error(
          `[gen-state-manifest] state key '${def.keyName}' is registered twice in ${scope} scope.`,
        );
      }
      seen.set(dedupe, sf.getFilePath());
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

const NO_TRUNCATION = ts.TypeFormatFlags.NoTruncation;

class TypeRenderer {
  private readonly checker: ts.TypeChecker;
  private readonly expanding = new Set<ts.Type>();
  private readonly expandingNamed: ts.Symbol[] = [];
  readonly externals = new Set<string>();
  readonly warnings = new Set<string>();

  constructor(private readonly project: Project) {
    this.checker = project.getTypeChecker().compilerObject;
  }

  renderKeyType(def: KeyDef): string {
    const valueType = def.declaration.getType().getTypeArguments()[0];
    if (valueType === undefined) {
      throw new Error(
        `[gen-state-manifest] cannot resolve the value type of '${def.keyName}' (${srcRelative(def.file)}).`,
      );
    }
    return this.renderType(valueType, def.declaration, 0);
  }

  private renderType(
    type: MorphType,
    location: Node,
    depth: number,
    skipSymbol?: ts.Symbol,
  ): string {
    if (depth > 40) return this.fallback(type, location, 'depth cap');

    if ((type.getFlags() & ts.TypeFlags.EnumLiteral) !== 0) {
      return this.renderEnumLiteral(type);
    }

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

  private leafText(type: MorphType): string {
    const text = this.checker.typeToString(type.compilerType, undefined, NO_TRUNCATION);
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

  private enumLiteralValue(type: MorphType): string {
    const value = (type.compilerType as ts.LiteralType).value;
    if (typeof value === 'string') {
      return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
    }
    if (typeof value === 'number') return String(value);
    return this.leafText(type);
  }

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

  private renderStructural(type: MorphType, location: Node, depth: number): string {
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
        `  ${readonly}${tsFieldKey(stableSymbolKey(prop.getName()))}${optional ? '?' : ''}: ${propLines[0]}`,
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
        if (r.def.replayable !== undefined) {
          const meta = r.def.replayable;
          const flags = [
            meta.durable ? 'durable' : 'transient',
            ...(meta.undoable ? ['undoable'] : []),
          ];
          lines.push(
            `  // replayable · ${flags.join(' · ')} — folds: ${meta.folds.length > 0 ? meta.folds.join(', ') : '(protocol only)'}`,
          );
        }
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
    '// `states.contributeState(...)` call sites and the replayable key chains — a',
    '// `defineState(...).replayable(...)` key is contributed into the Agent-scope',
    '// service by its owner service at construction, and',
    '// carries a `// replayable · durable|transient · undoable? — folds: ...` line.',
    '// Replayable values are excluded from snapshot()/inspect(). A key defined via',
    '// defineState but never registered nor replayable does not appear here. Each entry shows the',
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
  for (const def of defs.values()) {
    if (def.replayable === undefined) continue;
    if (!registered.has(def)) {
      throw new Error(
        `[gen-state-manifest] replayable state key '${def.keyName}' (${srcRelative(def.file)}) is ` +
          'never contributed — its owner service must contributeState it into the Agent-scope state service.',
      );
    }
    for (const registration of registrations) {
      if (registration.def === def && registration.scope !== 'agent') {
        throw new Error(
          `[gen-state-manifest] replayable state key '${def.keyName}' (${srcRelative(def.file)}) is ` +
            `contributed into the ${registration.scope} scope — replayable keys belong to the Agent scope.`,
        );
      }
    }
  }
  const unregistered = [...defs.values()].filter((def) => !registered.has(def));
  const model: StateManifestModel = { registrations, unregistered };
  const { manifest, warnings } = renderManifest(model, project);
  return { model, manifest, warnings };
}

export function buildStateManifest(): string {
  return buildAll().manifest;
}

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
