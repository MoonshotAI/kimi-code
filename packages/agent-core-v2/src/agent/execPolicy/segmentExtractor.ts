

import type {
  BashParseResult,
  BashSyntaxNode,
} from '#/app/bashParser/bashParser';

export const MAX_NESTED_SHELL_DEPTH = 4;

export const UNSAFE_OPERAND = /[$`*?[\]~]/;

export const SKIPPED_COMMAND_CHILDREN: ReadonlySet<string> = new Set([
  'variable_assignment',
  'file_redirect',
  'heredoc_redirect',
]);

export const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'doas']);

export const PRIVILEGE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
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

export const NESTED_SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'ash',
]);

export const LAUNCH_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'builtin',
  'nice',
]);

export const WRAPPER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-S',
  '--split-string',
  '-a',
  '-n',
  '--adjustment',
]);

export function collectCommands(node: BashSyntaxNode, out: BashSyntaxNode[]): void {
  if (node.type === 'command') out.push(node);
  for (const child of node.children) collectCommands(child, out);
}

export function normalizeCommandName(raw: string): string {
  let name = raw;
  const separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (separator >= 0) name = name.slice(separator + 1);
  name = name.toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -'.exe'.length);
  return name;
}

export function dropLeadingOptions(
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') return args.slice(i + 1);
    if (arg === '-' || !arg.startsWith('-')) return args.slice(i);
    if (!arg.includes('=') && valueOptions.has(arg)) i += 1;
  }
  return [];
}

export function dropLaunchWrapperOperands(
  name: string,
  args: readonly string[],
): string[] {
  let rest = dropLeadingOptions(args, WRAPPER_VALUE_OPTIONS);
  if (name === 'env') {
    let i = rest[0] === '-' ? 1 : 0;
    while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i]!)) i += 1;
    rest = rest.slice(i);
  }
  return rest;
}

export function literalText(node: BashSyntaxNode): string | undefined {
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

export type CommandSegment = readonly string[] | null;

function nestedShellPayloadIndex(args: readonly string[]): number {
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
  return payloadIndex;
}

function commandArgv(
  command: BashSyntaxNode,
): { argv: CommandSegment; name: string; args: readonly string[] } | undefined {
  const nameIndex = command.children.findIndex((child) => child.type === 'command_name');
  const nameNode = nameIndex >= 0 ? command.children[nameIndex] : undefined;
  const nameWord = nameNode?.children.find((child) => child.isNamed);
  const rawName = nameWord === undefined ? undefined : literalText(nameWord);
  if (rawName === undefined || rawName.length === 0) return undefined;
  const name = normalizeCommandName(rawName);
  const args: string[] = [];
  let dropped = false;
  for (const child of command.children.slice(nameIndex + 1)) {
    if (SKIPPED_COMMAND_CHILDREN.has(child.type)) continue;
    const value = literalText(child);
    if (value === undefined) {
      dropped = true;
    } else if (value.length > 0) {
      args.push(value);
    }
  }
  return { argv: dropped ? null : [name, ...args], name, args };
}

function segmentCommand(
  command: BashSyntaxNode,
  depth: number,
  parse: (source: string) => BashParseResult,
  out: CommandSegment[],
): void {
  const invocation = commandArgv(command);
  if (invocation === undefined) {
    out.push(null);
    return;
  }
  const { argv, name, args } = invocation;
  if (NESTED_SHELLS.has(name)) {
    const payloadIndex = nestedShellPayloadIndex(args);
    if (payloadIndex >= 0) {
      const payload = args[payloadIndex];
      if (payload === undefined || depth >= MAX_NESTED_SHELL_DEPTH) {
        out.push(null);
        return;
      }
      if (extractSegments(payload, depth + 1, parse, out) === undefined) {
        out.push(null);
      }
      return;
    }
  }
  if (name === 'eval') {
    if (args.length === 0 || argv === null || depth >= MAX_NESTED_SHELL_DEPTH) {
      out.push(args.length === 0 && argv !== null ? argv : null);
      return;
    }
    if (extractSegments(args.join(' '), depth + 1, parse, out) === undefined) {
      out.push(null);
    }
    return;
  }
  out.push(argv);
}

export function extractSegments(
  source: string,
  depth: number,
  parse: (source: string) => BashParseResult,
  out?: CommandSegment[],
): CommandSegment[] | undefined {
  const segments = out ?? [];
  const parsed = parse(source);
  if (!parsed.ok || parsed.hasError) return undefined;
  const commands: BashSyntaxNode[] = [];
  collectCommands(parsed.root, commands);
  for (const command of commands) {
    segmentCommand(command, depth, parse, segments);
  }
  return segments;
}
