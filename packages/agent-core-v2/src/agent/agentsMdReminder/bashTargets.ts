import { isAbsolute, join, normalize } from 'pathe';

import type { BashSyntaxNode } from '#/app/bashParser/bashParser';

const LISTING_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'tree',
  'find',
  'dir',
  'exa',
  'eza',
  'lsd',
]);

const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  'program',
  'list',
  'pipeline',
  'redirected_statement',
]);

const LS_ARG_TAKING_OPTIONS: ReadonlySet<string> = new Set([
  '-w',
  '--width',
  '--sort',
  '--block-size',
  '-I',
  '--ignore',
  '--hide',
  '--format',
  '--time-style',
  '--indicator-style',
  '--quoting-style',
  '-T',
  '--tabsize',
]);

const TREE_LIKE_ARG_TAKING_OPTIONS: ReadonlySet<string> = new Set([
  '-w',
  '--width',
  '--sort',
  '--block-size',
  '-I',
  '--ignore',
  '--ignore-glob',
  '--hide',
  '--format',
  '--time-style',
  '--indicator-style',
  '--hyperlink',
  '--quoting-style',
  '-T',
  '--tabsize',
  '-L',
  '--level',
  '--depth',
  '-P',
  '-o',
  '--filelimit',
  '--charset',
  '--timefmt',
  '-s',
]);

const FIND_GLOBAL_OPTIONS: ReadonlySet<string> = new Set(['-H', '-L', '-P']);

const UNSAFE_OPERAND = /[$`*?[\]~]/;

export function extractBashTargetDirs(
  root: BashSyntaxNode,
  cwd: string,
  homeDir: string,
): string[] {
  const commands: CollectedCommand[] = [];
  collectCommands(root, commands);

  const targets: string[] = [];
  const seen = new Set<string>();
  let base: string | undefined = cwd;
  const push = (operand: string): void => {
    let dir: string;
    if (isAbsolute(operand)) {
      dir = normalize(operand);
    } else {
      const currentBase = base;
      if (currentBase === undefined) return;
      dir = normalize(join(currentBase, operand));
    }
    if (seen.has(dir)) return;
    seen.add(dir);
    targets.push(dir);
  };

  for (const { node, inPipeline } of commands) {
    const { name, args, dropped } = commandNameAndArgs(node);
    if (name === undefined) continue;
    if (name === 'cd') {
      if (inPipeline) continue;
      if (dropped) {
        base = undefined;
        continue;
      }
      const target = args[0];
      if (args.length === 1 && target !== undefined && !target.startsWith('-')) {
        if (isAbsolute(target)) {
          base = normalize(target);
        } else if (base !== undefined) {
          base = normalize(join(base, target));
        }
      } else if (args.length === 0) {
        base = homeDir;
      } else {
        base = undefined;
      }
      continue;
    }
    if (!LISTING_COMMANDS.has(name)) continue;
    const operands = name === 'find' ? takeLeadingPaths(args) : dropFlags(args, name);
    if (operands.length === 0) {
      if (!dropped) push('.');
      continue;
    }
    for (const operand of operands) push(operand);
  }
  return targets;
}

interface CollectedCommand {
  readonly node: BashSyntaxNode;
  readonly inPipeline: boolean;
}

function collectCommands(node: BashSyntaxNode, out: CollectedCommand[], inPipeline = false): void {
  if (node.type === 'command') {
    out.push({ node, inPipeline });
    return;
  }
  if (!TRANSPARENT_WRAPPERS.has(node.type)) return;
  const nested = inPipeline || node.type === 'pipeline';
  for (const child of node.children) collectCommands(child, out, nested);
}

function commandNameAndArgs(command: BashSyntaxNode): {
  name: string | undefined;
  args: string[];
  dropped: boolean;
} {
  const nameIndex = command.children.findIndex((child) => child.type === 'command_name');
  const nameNode = nameIndex >= 0 ? command.children[nameIndex] : undefined;
  const nameWord = nameNode?.children.find((child) => child.isNamed);
  const rawName = nameWord === undefined ? undefined : literalText(nameWord);
  if (rawName === undefined || rawName.length === 0 || rawName.includes('/')) {
    return { name: undefined, args: [], dropped: false };
  }
  const args: string[] = [];
  let dropped = false;
  for (const child of command.children.slice(nameIndex + 1)) {
    const value = literalText(child);
    if (value === undefined) {
      dropped = true;
    } else if (value.length > 0) {
      args.push(value);
    }
  }
  return { name: rawName, args, dropped };
}

function literalText(node: BashSyntaxNode): string | undefined {
  switch (node.type) {
    case 'word': {
      const raw = node.text;
      if (UNSAFE_OPERAND.test(raw)) return undefined;
      const unescaped = raw.replaceAll(/\\(.)/gs, '$1');
      return UNSAFE_OPERAND.test(unescaped) ? undefined : unescaped;
    }
    case 'number':
      return node.text;
    case 'raw_string': {
      if (node.text.length < 2) return undefined;
      const value = node.text.slice(1, -1);
      return UNSAFE_OPERAND.test(value) ? undefined : value;
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
      return UNSAFE_OPERAND.test(value) ? undefined : value;
    }
    default:
      return undefined;
  }
}

function dropFlags(args: readonly string[], command: string): string[] {
  const argumentTakingOptions =
    command === 'ls' || command === 'dir'
      ? LS_ARG_TAKING_OPTIONS
      : TREE_LIKE_ARG_TAKING_OPTIONS;
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      out.push(arg);
      continue;
    }
    if (!arg.includes('=') && argumentTakingOptions.has(arg)) {
      i += 1;
    }
  }
  return out;
}

function takeLeadingPaths(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (FIND_GLOBAL_OPTIONS.has(arg) || arg === '--') continue;
    if (arg.startsWith('-') || arg === '(' || arg === ')' || arg === '!') break;
    out.push(arg);
  }
  return out;
}
