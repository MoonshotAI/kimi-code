import {
  IBashParserService,
  type BashParseResult,
  type BashSyntaxNode,
} from '#/app/bashParser/bashParser';
import { IConfigService } from '#/app/config/config';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { isDangerousCommandGuardEnabled } from '#/agent/permissionRules/configSection';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

const PARSE_OPTIONS = { timeoutMs: 20, maxNodes: 10_000 } as const;

const MAX_NESTED_SHELL_DEPTH = 4;

const UNSAFE_OPERAND = /[$`*?[\]~]/;

const SKIPPED_COMMAND_CHILDREN: ReadonlySet<string> = new Set([
  'variable_assignment',
  'file_redirect',
  'heredoc_redirect',
]);

const SIMPLE_DANGEROUS_COMMANDS: ReadonlySet<string> = new Set([
  'shutdown',
  'halt',
  'poweroff',
  'reboot',
  'bcdedit',
  'diskpart',
  'format',
  'restart-computer',
  'stop-computer',
  'mkfs',
  'wipefs',
]);

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

const NESTED_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);

const LAUNCH_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'builtin',
  'nice',
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
]);

const SYSTEMCTL_DANGEROUS_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'poweroff',
  'reboot',
  'halt',
  'kexec',
]);

const SYSTEMCTL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-H', '--host', '-M', '--machine']);

const DD_SAFE_DEVICE_TARGETS: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/full',
  '/dev/random',
  '/dev/urandom',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
]);

type DangerousVerdict =
  | { readonly kind: 'dangerous'; readonly command: string }
  | { readonly kind: 'unanalyzable' };

export class DangerousCommandAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'dangerous-command-ask';

  constructor(
    @IBashParserService private readonly bashParser: IBashParserService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IConfigService private readonly config: IConfigService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (!isDangerousCommandGuardEnabled(this.config)) return undefined;
    if (context.toolCall.name !== 'Bash') return undefined;
    const command = bashCommandText(context.args);
    const verdict =
      command === undefined
        ? ({ kind: 'unanalyzable' } as const)
        : analyzeSource(command, 0, (source) =>
            this.bashParser.parse(source, PARSE_OPTIONS),
          );
    if (verdict === undefined) return undefined;
    const auto = this.modeService.mode === 'auto';
    if (verdict.kind === 'dangerous') {
      if (auto) {
        return {
          kind: 'deny',
          reason: { dangerous_command: verdict.command },
          message: `Bash command '${verdict.command}' is blocked in auto permission mode because it is considered dangerous. Ask the user to switch permission mode or run it themselves.`,
        };
      }
      return { kind: 'ask', reason: { dangerous_command: verdict.command } };
    }
    if (auto) {
      return {
        kind: 'deny',
        reason: { unanalyzable_command: true },
        message:
          'This Bash command could not be analyzed and is blocked in auto permission mode. Rewrite it with a literal command name and arguments, or ask the user to run it themselves.',
      };
    }
    return { kind: 'ask', reason: { unanalyzable_command: true } };
  }
}

function bashCommandText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

function analyzeSource(
  source: string,
  depth: number,
  parse: (source: string) => BashParseResult,
): DangerousVerdict | undefined {
  const parsed = parse(source);
  if (!parsed.ok || parsed.hasError) return { kind: 'unanalyzable' };
  const commands: BashSyntaxNode[] = [];
  collectCommands(parsed.root, commands);
  for (const command of commands) {
    const verdict = analyzeCommand(command, depth, parse);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
}

function collectCommands(node: BashSyntaxNode, out: BashSyntaxNode[]): void {
  if (node.type === 'command') out.push(node);
  for (const child of node.children) collectCommands(child, out);
}

function analyzeCommand(
  command: BashSyntaxNode,
  depth: number,
  parse: (source: string) => BashParseResult,
): DangerousVerdict | undefined {
  const nameIndex = command.children.findIndex((child) => child.type === 'command_name');
  const nameNode = nameIndex >= 0 ? command.children[nameIndex] : undefined;
  const nameWord = nameNode?.children.find((child) => child.isNamed);
  const rawName = nameWord === undefined ? undefined : literalText(nameWord);
  if (rawName === undefined || rawName.length === 0) return { kind: 'unanalyzable' };
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
  return analyzeInvocation(normalizeCommandName(rawName), args, dropped, depth, parse);
}

function analyzeInvocation(
  name: string,
  args: readonly string[],
  dropped: boolean,
  depth: number,
  parse: (source: string) => BashParseResult,
): DangerousVerdict | undefined {
  if (PRIVILEGE_WRAPPERS.has(name)) {
    const rest = dropLeadingOptions(args, PRIVILEGE_VALUE_OPTIONS);
    const inner = rest[0];
    if (inner === undefined) return dropped ? { kind: 'unanalyzable' } : undefined;
    return analyzeInvocation(normalizeCommandName(inner), rest.slice(1), dropped, depth, parse);
  }
  if (LAUNCH_WRAPPERS.has(name)) {
    if (name === 'command') {
      for (const arg of args) {
        if (arg === '--') break;
        if (arg === '-') continue;
        if (!arg.startsWith('-')) break;
        if (/[vV]/.test(arg)) return undefined;
      }
    }
    const rest = dropLaunchWrapperOperands(name, args);
    const inner = rest[0];
    if (inner === undefined) return dropped ? { kind: 'unanalyzable' } : undefined;
    return analyzeInvocation(normalizeCommandName(inner), rest.slice(1), dropped, depth, parse);
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
    if (payloadIndex < 0) return dropped ? { kind: 'unanalyzable' } : undefined;
    const payload = args[payloadIndex];
    if (payload === undefined || depth >= MAX_NESTED_SHELL_DEPTH) {
      return { kind: 'unanalyzable' };
    }
    return analyzeSource(payload, depth + 1, parse);
  }
  if (name === 'eval') {
    if (args.length === 0) return dropped ? { kind: 'unanalyzable' } : undefined;
    if (dropped || depth >= MAX_NESTED_SHELL_DEPTH) return { kind: 'unanalyzable' };
    return analyzeSource(args.join(' '), depth + 1, parse);
  }
  if (name === 'busybox') {
    const applet = args[0];
    if (applet === undefined || applet.startsWith('-')) {
      return dropped ? { kind: 'unanalyzable' } : undefined;
    }
    return analyzeInvocation(normalizeCommandName(applet), args.slice(1), dropped, depth, parse);
  }
  if (SIMPLE_DANGEROUS_COMMANDS.has(name) || name.startsWith('mkfs.')) {
    return { kind: 'dangerous', command: name };
  }
  if (name === 'init' || name === 'telinit') {
    if (args.some((arg) => arg === '0' || arg === '6')) {
      return { kind: 'dangerous', command: name };
    }
    return dropped ? { kind: 'unanalyzable' } : undefined;
  }
  if (name === 'systemctl') {
    const subcommand = dropLeadingOptions(args, SYSTEMCTL_VALUE_OPTIONS)[0];
    if (subcommand !== undefined && SYSTEMCTL_DANGEROUS_SUBCOMMANDS.has(subcommand)) {
      return { kind: 'dangerous', command: `systemctl ${subcommand}` };
    }
    return dropped ? { kind: 'unanalyzable' } : undefined;
  }
  if (name === 'dd') {
    for (const arg of args) {
      if (!arg.startsWith('of=')) continue;
      const target = arg.slice('of='.length);
      if (target.startsWith('/dev/') && !DD_SAFE_DEVICE_TARGETS.has(target)) {
        return { kind: 'dangerous', command: 'dd' };
      }
    }
    return dropped ? { kind: 'unanalyzable' } : undefined;
  }
  if (name === 'rm') {
    let recursive = false;
    let force = false;
    for (const arg of args) {
      if (arg === '--') break;
      if (arg === '--recursive') {
        recursive = true;
      } else if (arg === '--force') {
        force = true;
      } else if (/^-[a-zA-Z]+$/.test(arg)) {
        if (/[rR]/.test(arg)) recursive = true;
        if (arg.includes('f')) force = true;
      }
    }
    if (recursive && force) return { kind: 'dangerous', command: 'rm -rf' };
    return dropped ? { kind: 'unanalyzable' } : undefined;
  }
  return undefined;
}

function normalizeCommandName(raw: string): string {
  let name = raw;
  const separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (separator >= 0) name = name.slice(separator + 1);
  name = name.toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -'.exe'.length);
  return name;
}

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
