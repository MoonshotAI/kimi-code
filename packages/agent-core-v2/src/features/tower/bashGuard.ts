import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { BashParseResult, BashSyntaxNode } from '#/app/bashParser/bashParser';

import { COMMS_DIR, TOWER_ROOT, WORKTREES_DIR } from './protocol/paths';

export const TOWER_BASH_GUARD_PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

export type TowerBashGuardParse = (source: string) => BashParseResult;

export async function towerWorkspaceOwned(stateFile: string): Promise<boolean> {
  return readFile(stateFile, 'utf8').then(
    (raw) => {
      const sessionId = (JSON.parse(raw) as { sessionId?: unknown }).sessionId;
      return typeof sessionId === 'string' && sessionId.length > 0;
    },
    () => false,
  );
}

export interface TowerBashGuardTarget {
  readonly command: string;
  readonly cwd: string;
  readonly mainCheckout: string;
}

interface TowerLayout {
  readonly mainCheckout: string;
  readonly towerRoot: string;
  readonly commsDir: string;
  readonly worktreesDir: string;
}

interface GuardContext {
  readonly layout: TowerLayout;
  readonly parse: TowerBashGuardParse;
  readonly depth: number;
}

interface WalkResult {
  readonly veto?: string;
  readonly cwd: string;
}

const MAX_NESTED_PARSE_DEPTH = 4;

const GIT_KEYWORD = /\bgit\b/;
const CLEAN_KEYWORD = /\bclean\b/;
const RESET_KEYWORD = /\breset\b/;
const RM_KEYWORD = /\brm\b/;

export function commandNeedsTowerGuard(command: string): boolean {
  if (RM_KEYWORD.test(command)) return true;
  return GIT_KEYWORD.test(command) && (CLEAN_KEYWORD.test(command) || RESET_KEYWORD.test(command));
}

export function analyzeTowerBashCommand(
  target: TowerBashGuardTarget,
  parse: TowerBashGuardParse,
): string | undefined {
  const layout = towerLayout(target.mainCheckout);
  return analyzeSource(target.command, resolve(target.cwd), layout, parse, 0);
}

function towerLayout(mainCheckout: string): TowerLayout {
  const root = resolve(mainCheckout);
  return {
    mainCheckout: root,
    towerRoot: join(root, TOWER_ROOT),
    commsDir: join(root, COMMS_DIR),
    worktreesDir: join(root, WORKTREES_DIR),
  };
}

function analyzeSource(
  source: string,
  cwd: string,
  layout: TowerLayout,
  parse: TowerBashGuardParse,
  depth: number,
): string | undefined {
  const parsed = parse(source);
  if (!parsed.ok || parsed.hasError) return unanalyzableVeto();
  return walkNode(parsed.root, cwd, { layout, parse, depth }).veto;
}

function walkNode(node: BashSyntaxNode, cwd: string, ctx: GuardContext): WalkResult {
  if (node.type === 'command') return analyzeCommand(node, cwd, ctx);
  if (node.type === 'pipeline') {
    for (const child of namedChildren(node)) {
      const result = walkNode(child, cwd, ctx);
      if (result.veto !== undefined) return { veto: result.veto, cwd };
    }
    return { cwd };
  }
  if (node.type === 'subshell' || node.type === 'command_substitution') {
    const result = walkChildren(node, cwd, ctx);
    return result.veto === undefined ? { cwd } : { veto: result.veto, cwd };
  }
  return walkChildren(node, cwd, ctx);
}

function walkChildren(node: BashSyntaxNode, cwd: string, ctx: GuardContext): WalkResult {
  let current = cwd;
  for (const child of namedChildren(node)) {
    const result = walkNode(child, current, ctx);
    if (result.veto !== undefined) return { veto: result.veto, cwd: current };
    current = result.cwd;
  }
  return { cwd: current };
}

function namedChildren(node: BashSyntaxNode): BashSyntaxNode[] {
  return node.children.filter((child) => child.isNamed);
}

const SKIPPED_COMMAND_CHILDREN: ReadonlySet<string> = new Set([
  'variable_assignment',
  'file_redirect',
  'heredoc_redirect',
]);

function analyzeCommand(node: BashSyntaxNode, cwd: string, ctx: GuardContext): WalkResult {
  const nameIndex = node.children.findIndex((child) => child.type === 'command_name');
  if (nameIndex < 0) return { cwd };
  const nameWord = node.children[nameIndex]!.children.find((child) => child.isNamed);
  const rawName = nameWord === undefined ? undefined : literalText(nameWord);
  if (rawName === undefined || rawName.length === 0) return { cwd };
  const args: string[] = [];
  let dropped = false;
  for (const child of node.children.slice(nameIndex + 1)) {
    if (!child.isNamed) continue;
    if (SKIPPED_COMMAND_CHILDREN.has(child.type)) continue;
    const value = literalText(child);
    if (value === undefined) {
      dropped = true;
    } else if (value.length > 0) {
      args.push(value);
    }
  }
  return analyzeInvocation(normalizeCommandName(rawName), args, dropped, cwd, ctx);
}

function analyzeInvocation(
  name: string,
  args: readonly string[],
  dropped: boolean,
  cwd: string,
  ctx: GuardContext,
): WalkResult {
  if (PRIVILEGE_WRAPPERS.has(name)) {
    const rest = dropLeadingOptions(args, PRIVILEGE_VALUE_OPTIONS);
    const inner = rest[0];
    if (inner === undefined) return { cwd };
    return analyzeInvocation(normalizeCommandName(inner), rest.slice(1), dropped, cwd, ctx);
  }
  if (LAUNCH_WRAPPERS.has(name)) {
    const rest = dropLaunchWrapperOperands(name, args);
    const inner = rest[0];
    if (inner === undefined) return { cwd };
    return analyzeInvocation(normalizeCommandName(inner), rest.slice(1), dropped, cwd, ctx);
  }
  if (NESTED_SHELLS.has(name)) {
    let payloadIndex = -1;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === '--') break;
      if (/^-[a-zA-Z]+$/.test(arg)) {
        if (arg.includes('c')) payloadIndex = i + 1;
      } else {
        break;
      }
    }
    const payload = payloadIndex < 0 ? undefined : args[payloadIndex];
    if (payload === undefined || ctx.depth >= MAX_NESTED_PARSE_DEPTH) return { cwd };
    const veto = analyzeSource(payload, cwd, ctx.layout, ctx.parse, ctx.depth + 1);
    return veto === undefined ? { cwd } : { veto, cwd };
  }
  if (name === 'eval') {
    if (args.length === 0 || ctx.depth >= MAX_NESTED_PARSE_DEPTH) return { cwd };
    const veto = analyzeSource(args.join(' '), cwd, ctx.layout, ctx.parse, ctx.depth + 1);
    return veto === undefined ? { cwd } : { veto, cwd };
  }
  if (name === 'busybox') {
    const applet = args[0];
    if (applet === undefined || applet.startsWith('-')) return { cwd };
    return analyzeInvocation(normalizeCommandName(applet), args.slice(1), dropped, cwd, ctx);
  }
  if (name === 'cd') {
    let index = 0;
    while (index < args.length && (args[index] === '-L' || args[index] === '-P' || args[index] === '--')) {
      index += 1;
    }
    const dir = args[index];
    if (dir === undefined) return { cwd: dropped ? cwd : homedir() };
    if (dir === '-') return { cwd };
    return { cwd: resolveOperand(cwd, dir) };
  }
  if (name === 'git') return analyzeGit(args, dropped, cwd, ctx);
  if (name === 'rm') return analyzeRm(args, cwd, ctx.layout);
  return { cwd };
}

function analyzeGit(
  args: readonly string[],
  dropped: boolean,
  cwd: string,
  ctx: GuardContext,
): WalkResult {
  if (dropped) return { cwd };
  let gitCwd = cwd;
  let subcommand: string | undefined;
  let subargs: readonly string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-C') {
      const dir = args[i + 1];
      if (dir === undefined) return { cwd };
      gitCwd = resolveOperand(gitCwd, dir);
      i += 1;
      continue;
    }
    if (arg === '-c') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    subcommand = arg;
    subargs = args.slice(i + 1);
    break;
  }
  if (subcommand === 'clean') {
    const veto = analyzeGitClean(subargs, gitCwd, ctx.layout);
    return veto === undefined ? { cwd } : { veto, cwd };
  }
  if (subcommand === 'reset') {
    const veto = analyzeGitReset(subargs, gitCwd, ctx.layout);
    return veto === undefined ? { cwd } : { veto, cwd };
  }
  return { cwd };
}

function analyzeGitClean(
  args: readonly string[],
  gitCwd: string,
  layout: TowerLayout,
): string | undefined {
  let forceCount = 0;
  let dirs = false;
  let ignored = false;
  let dryRun = false;
  let interactive = false;
  const pathspecs: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('--')) {
      if (arg === '--force') forceCount += 1;
      else if (arg === '--dry-run') dryRun = true;
      else if (arg === '--interactive') interactive = true;
      else if (arg === '--exclude') i += 1;
      continue;
    }
    if (!optionsEnded && /^-[a-zA-Z]+$/.test(arg)) {
      const excludeAt = arg.indexOf('e');
      const cluster = excludeAt === -1 ? arg : arg.slice(0, excludeAt);
      forceCount += (cluster.match(/f/g) ?? []).length;
      if (cluster.includes('n')) dryRun = true;
      if (cluster.includes('i')) interactive = true;
      if (cluster.includes('d')) dirs = true;
      if (cluster.includes('x') || cluster.includes('X')) ignored = true;
      if (excludeAt === arg.length - 1) i += 1;
      continue;
    }
    pathspecs.push(arg);
  }
  if (dryRun || interactive || forceCount === 0) return undefined;
  if (!dirs && !ignored) return undefined;
  if (pathspecs.length === 0) {
    return isWithinOrEqual(layout.commsDir, gitCwd) ? gitCleanVeto() : undefined;
  }
  const gitCwdSlotDepth = slotDepth(gitCwd, layout.worktreesDir);
  for (const spec of pathspecs) {
    const abs = resolveOperand(gitCwd, spec);
    if (gitCwdSlotDepth !== undefined && gitCwdSlotDepth >= 1) {
      const specSlotDepth = slotDepth(abs, layout.worktreesDir);
      if (specSlotDepth !== undefined && specSlotDepth >= 1) continue;
    }
    if (operandBucket(abs, layout) !== undefined) return gitCleanVeto();
  }
  return undefined;
}

function analyzeGitReset(
  args: readonly string[],
  gitCwd: string,
  layout: TowerLayout,
): string | undefined {
  if (!args.includes('--hard')) return undefined;
  if (!isWithinOrEqual(gitCwd, layout.mainCheckout)) return undefined;
  if (isWithinOrEqual(gitCwd, layout.worktreesDir) && !pathsEqual(gitCwd, layout.worktreesDir)) {
    return undefined;
  }
  return gitResetVeto();
}

function analyzeRm(args: readonly string[], cwd: string, layout: TowerLayout): WalkResult {
  let recursive = false;
  const operands: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('--')) {
      if (arg === '--recursive') recursive = true;
      continue;
    }
    if (!optionsEnded && /^-[a-zA-Z]+$/.test(arg)) {
      if (/[rR]/.test(arg)) recursive = true;
      continue;
    }
    operands.push(arg);
  }
  for (const operand of operands) {
    const bucket = operandBucket(resolveOperand(cwd, operand), layout);
    if (bucket === 'comms') return { veto: rmVeto(operand), cwd };
    if ((bucket === 'tower-ancestor' || bucket === 'protected-interior') && recursive) {
      return { veto: rmVeto(operand), cwd };
    }
  }
  return { cwd };
}

type OperandBucket = 'comms' | 'tower-ancestor' | 'protected-interior' | undefined;

function operandBucket(abs: string, layout: TowerLayout): OperandBucket {
  if (isWithinOrEqual(abs, layout.commsDir)) return 'comms';
  if (isWithinOrEqual(layout.towerRoot, abs)) return 'tower-ancestor';
  if (!isWithinOrEqual(abs, layout.towerRoot)) return undefined;
  const depth = slotDepth(abs, layout.worktreesDir);
  return depth !== undefined && depth >= 2 ? undefined : 'protected-interior';
}

function isWithinOrEqual(candidate: string, base: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathsEqual(a: string, b: string): boolean {
  return relative(a, b) === '';
}

function slotDepth(path: string, worktreesDir: string): number | undefined {
  const rel = relative(worktreesDir, path);
  if (rel === '') return 0;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).length;
}

function resolveOperand(cwd: string, operand: string): string {
  if (operand === '~') return homedir();
  if (operand.startsWith('~/') || operand.startsWith(`~${sep}`)) {
    return resolve(homedir(), operand.slice(2));
  }
  return isAbsolute(operand) ? resolve(operand) : resolve(cwd, operand);
}

const DYNAMIC_OPERAND = /[$`*?[\]{}]/;

function literalText(node: BashSyntaxNode): string | undefined {
  switch (node.type) {
    case 'word': {
      const raw = node.text;
      if (DYNAMIC_OPERAND.test(raw)) return undefined;
      const unescaped = raw.replaceAll(/\\(.)/gs, '$1');
      return DYNAMIC_OPERAND.test(unescaped) ? undefined : unescaped;
    }
    case 'number':
      return node.text;
    case 'raw_string': {
      if (node.text.length < 2) return undefined;
      const value = node.text.slice(1, -1);
      return DYNAMIC_OPERAND.test(value) ? undefined : value;
    }
    case 'string': {
      let value = '';
      for (const child of node.children) {
        if (child.type === 'string_content') {
          value += child.text;
        } else if (child.isNamed) {
          return undefined;
        }
      }
      return DYNAMIC_OPERAND.test(value) ? undefined : value;
    }
    default:
      return undefined;
  }
}

function normalizeCommandName(raw: string): string {
  let name = raw;
  const separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (separator >= 0) name = name.slice(separator + 1);
  name = name.toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -'.exe'.length);
  return name;
}

const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'doas']);

const PRIVILEGE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-C',
  '--close-from',
  '-T',
  '--command-timeout',
  '-U',
  '--other-user',
  '-r',
  '--role',
  '-t',
  '--type',
]);

const LAUNCH_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'builtin',
  'nice',
  'time',
]);

const WRAPPER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-S',
  '--split-string',
  '-a',
  '-n',
  '--adjustment',
  '-o',
  '--output',
  '-f',
  '--format',
]);

const NESTED_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);

function dropLeadingOptions(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') return args.slice(i + 1);
    if (arg === '-' || !arg.startsWith('-')) return args.slice(i);
    if (!arg.includes('=') && valueOptions.has(arg)) i += 1;
  }
  return [];
}

function dropLaunchWrapperOperands(name: string, args: readonly string[]): string[] {
  let rest = dropLeadingOptions(args, WRAPPER_VALUE_OPTIONS);
  if (name === 'env') {
    let i = rest[0] === '-' ? 1 : 0;
    while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i]!)) i += 1;
    rest = rest.slice(i);
  }
  return rest;
}

const TOWER_GUARD_ESCAPE =
  'to retire the tower workspace deliberately, turn tower mode off and remove .tower/comms manually in a terminal — this guard only intercepts agent Bash calls.';

function gitCleanVeto(): string {
  return (
    '`git clean` with force and -d/-x is not allowed when its scope covers the tower main checkout — ' +
    'it would delete .tower/comms, the tower protocol state, which git does not track and cannot restore. ' +
    'Run the clean inside your own tower worktree or a temporary `git worktree add` checkout instead; ' +
    TOWER_GUARD_ESCAPE
  );
}

function gitResetVeto(): string {
  return (
    '`git reset --hard` is not allowed in the tower main checkout — ' +
    'it would silently discard base-checkout work the tower fleet depends on. ' +
    'Run it inside your own tower worktree or a temporary worktree instead; ' +
    TOWER_GUARD_ESCAPE
  );
}

function rmVeto(operand: string): string {
  return (
    `\`rm\` is not allowed on tower protocol paths ("${operand}") — ` +
    '.tower/comms holds the tower protocol state and deleting it orphans the fleet. ' +
    'Remove paths inside your own worktree instead; ' +
    TOWER_GUARD_ESCAPE
  );
}

function unanalyzableVeto(): string {
  return (
    'this Bash command mentions git clean / git reset / rm and the tower guard could not parse it safely, ' +
    'so it is blocked conservatively — a misread command could delete .tower/comms, the tower protocol state. ' +
    'Split it into simpler commands or run it inside your tower worktree.'
  );
}
