import {
  IBashParserService,
  type BashParseResult,
  type BashSyntaxNode,
} from '#/app/bashParser/bashParser';
import { findGitWorkTree } from '#/app/git/workTree';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { canonicalizePath, isSensitiveFile } from '#/tool/path-access';
import { acquireEnvironmentLease } from './environment-lease';
import { hasGitPathComponent, isGitControlPath } from './path-utils';

const PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'grep',
  'egrep',
  'fgrep',
  'diff',
  'du',
  'df',
  'echo',
  'strings',
  'hexdump',
  'od',
  'nl',
  'cut',
  'column',
  'tr',
  'tac',
  'rev',
  'cmp',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'sha256sum',
  'sha1sum',
  'md5sum',
  'uniq',
  'cd',
]);

const SIMPLE_READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(['pwd', 'whoami', 'alias']);

const EXACT_READ_ONLY_INVOCATIONS: string[][] = [
  ['claude', '-h'],
  ['claude', '--help'],
  ['node', '-v'],
  ['node', '--version'],
  ['python', '--version'],
  ['python3', '--version'],
  ['ip', 'addr'],
];

export class BashReadOnlyApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'bash-read-only-approve';

  constructor(
    @IBashParserService private readonly bashParser: IBashParserService,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    if (context.toolCall.name !== 'Bash') return undefined;
    if (typeof context.args !== 'object' || context.args === null) return undefined;
    const command = (context.args as { readonly command?: unknown }).command;
    if (typeof command !== 'string') return undefined;
    const readOnly = analyzeBashReadOnly(this.bashParser.parse(command, PARSE_OPTIONS));
    if (readOnly === undefined) return undefined;
    const lease = acquireEnvironmentLease(this.environment);
    if (lease === undefined) return undefined;
    try {
      const pathClass = lease.environment.host?.pathClass;
      if (pathClass === undefined) return undefined;
      const cwd = this.workspace.workDir;
      if (cwd.length === 0) return undefined;
      const paths = readOnly.paths.map((path) => {
        if (path.startsWith('~') && lease.environment.host?.homeDir === undefined) return undefined;
        try {
          const expanded = path === '~'
            ? lease.environment.host!.homeDir
            : path.startsWith('~/')
              ? `${lease.environment.host!.homeDir}/${path.slice(2)}`
              : path;
          return canonicalizePath(expanded, cwd, pathClass);
        } catch {
          return undefined;
        }
      });
      if (paths.some((path) => path === undefined || isSensitiveFile(path))) return undefined;
      const marker = lease.environment.fs === undefined
        ? null
        : await findGitWorkTree(lease.environment.fs, cwd);
      if (paths.some((path) => hasGitPathComponent(path!, cwd, pathClass))) return undefined;
      if (marker !== null && paths.some((path) => isGitControlPath(path!, marker, pathClass))) {
        return undefined;
      }
      return { kind: 'approve' };
    } finally {
      lease.dispose();
    }
  }
}

export function analyzeBashReadOnly(result: BashParseResult): { paths: string[] } | undefined {
  if (!result.ok || result.hasError) return undefined;
  const commands: {
    node: BashSyntaxNode;
    arguments: BashSyntaxNode[];
    inputs: BashSyntaxNode[];
  }[] = [];
  if (!collectCommands(result.root, commands) || commands.length === 0) return undefined;
  const paths: string[] = [];
  for (const command of commands) {
    const operands = analyzeCommand(command.node, command.arguments, command.inputs);
    if (operands === undefined) return undefined;
    paths.push(...operands);
  }
  return { paths };
}

function collectCommands(
  node: BashSyntaxNode,
  out: { node: BashSyntaxNode; arguments: BashSyntaxNode[]; inputs: BashSyntaxNode[] }[],
): boolean {
  if (node.type === 'command') {
    const args: BashSyntaxNode[] = [];
    const inputs: BashSyntaxNode[] = [];
    out.push({ node, arguments: args, inputs });
    return node.children.every((child) => {
      if (child.type === 'file_redirect') return collectRedirectArguments(child, args, inputs);
      if (child.type === 'heredoc_redirect') {
        return isReadOnlyHeredoc(child) && child.children.every(
          (part) => part.type !== 'file_redirect' || collectRedirectArguments(part, args, inputs),
        );
      }
      return true;
    });
  }
  if (
    node.type === 'variable_assignment' ||
    node.type === 'variable_assignments' ||
    node.type === 'subshell' ||
    node.type === 'compound_statement' ||
    node.type === 'command_substitution' ||
    node.type === 'process_substitution' ||
    node.type === 'arithmetic_expansion' ||
    node.type === 'herestring_redirect' ||
    node.type === 'ERROR'
  ) {
    return false;
  }
  return node.children.every((child) => {
    if (child.type === '&') return false;
    if (child.type === 'file_redirect') {
      const command = out.at(-1);
      return command !== undefined && collectRedirectArguments(child, command.arguments, command.inputs);
    }
    if (child.type === 'heredoc_redirect') {
      const command = out.at(-1);
      return command !== undefined && isReadOnlyHeredoc(child) && child.children.every(
        (part) => part.type !== 'file_redirect' || collectRedirectArguments(part, command.arguments, command.inputs),
      );
    }
    return collectCommands(child, out);
  });
}

function collectRedirectArguments(
  node: BashSyntaxNode,
  args: BashSyntaxNode[],
  inputs: BashSyntaxNode[],
): boolean {
  const operatorIndex = node.children.findIndex((child) => !child.isNamed);
  const operator = node.children[operatorIndex]?.text;
  const target = node.children[operatorIndex + 1];
  if (target === undefined) return operator === '>&-' || operator === '<&-';
  const path = literalText(target);
  if (path === undefined) return false;
  if (operator === '<') {
    if (target.type !== 'word' || /^\/dev\/(?:tcp|udp)\//.test(path)) return false;
    inputs.push(target);
  } else if (operator === '>&' || operator === '<&') {
    if (target.type !== 'number' || !/^\d+$/.test(target.text)) return false;
  } else if (operator === '>' || operator === '>>') {
    if (target.type !== 'word' || path !== '/dev/null') return false;
  } else {
    return false;
  }
  args.push(...node.children.slice(operatorIndex + 2));
  return true;
}

function isReadOnlyHeredoc(node: BashSyntaxNode): boolean {
  const delimiter = node.children.find((child) => child.type === 'heredoc_start');
  if (delimiter === undefined) return false;
  const body = node.children.find((child) => child.type === 'heredoc_body');
  if (body !== undefined && body.children.length > 0) return false;
  return node.children.every((child) =>
    child.type === 'heredoc_start' ||
    child.type === 'heredoc_body' ||
    child.type === 'heredoc_end' ||
    child.type === '<<' ||
    child.type === '<<-' ||
    child.type === 'file_descriptor' ||
    child.type === 'file_redirect'
  );
}

function analyzeCommand(
  command: BashSyntaxNode,
  redirectArguments: BashSyntaxNode[],
  redirectInputs: BashSyntaxNode[],
): string[] | undefined {
  const nameIndex = command.children.findIndex((child) => child.type === 'command_name');
  const commandName = command.children[nameIndex];
  if (nameIndex < 0 || commandName?.children.length !== 1 || !isLiteral(commandName.children[0]!)) {
    return undefined;
  }
  const inputPaths = redirectInputs.map(literalText);
  if (inputPaths.some((path) => path === undefined)) return undefined;
  const paths = inputPaths.filter((path): path is string => path !== undefined && path.length > 0);
  if (command.children.slice(0, nameIndex).some((child) =>
    child.type !== 'file_redirect' && child.type !== 'heredoc_redirect'
  )) return undefined;
  const name = literalText(commandName.children[0]!);
  if (name === undefined) return undefined;
  const args = command.children
    .filter((child) =>
      child.startIndex > commandName.endIndex &&
      child.type !== 'file_redirect' &&
      child.type !== 'heredoc_redirect'
    )
    .toSorted((left, right) => left.startIndex - right.startIndex);
  args.push(...redirectArguments);
  if (!args.every(isLiteral)) return undefined;
  const texts = args.map(literalText);
  if (texts.some((text) => text === undefined)) return undefined;
  const operands = texts.filter((text): text is string => text !== undefined && text.length > 0);
  if (operands.length === 0) {
    return READ_ONLY_COMMANDS.has(name) || SIMPLE_READ_ONLY_COMMANDS.has(name) || ['history', 'arch', 'ifconfig'].includes(name) ? paths : undefined;
  }
  if (SIMPLE_READ_ONLY_COMMANDS.has(name)) return undefined;
  if (EXACT_READ_ONLY_INVOCATIONS.some(
    (invocation) => invocation[0] === name
      && invocation.length === texts.length + 1
      && invocation.slice(1).every((arg, index) => arg === texts[index]),
  )) {
    return paths;
  }
  if (name === 'history') {
    return texts.length === 1 && /^\d+$/.test(texts[0]!) ? paths : undefined;
  }
  if (name === 'arch') {
    return texts.length === 1 && ['-h', '--help'].includes(texts[0]!) ? paths : undefined;
  }
  if (name === 'ifconfig') {
    return operands.length === 1 && /^[a-zA-Z]/.test(operands[0]!) ? paths : undefined;
  }
  if (!READ_ONLY_COMMANDS.has(name)) return undefined;
  if (['echo', 'tr'].includes(name)) return paths;
  if (name === 'uniq') {
    const inputs: string[] = [];
    for (let index = 0; index < operands.length; index++) {
      const text = operands[index]!;
      if (/^--(?:skip-chars|skip-fields|check-chars)$/.test(text)) {
        index++;
        if (index === operands.length) return undefined;
      } else if (/^-[fsw]$/.test(text)) {
        index++;
        if (index === operands.length || !/^\d+$/.test(operands[index]!)) return undefined;
      } else if (text.startsWith('-')) {
        if (!/^-[a-zA-Z]+$/.test(text) && !/^--[a-zA-Z-]+(?:=\S+)?$/.test(text)) return undefined;
      } else {
        inputs.push(text);
      }
    }
    return inputs.length <= 1 ? [...paths, ...inputs] : undefined;
  }
  if (name === 'ls' || name === 'cd') {
    if (operands.some((arg) => /[$`<>|&;(){}*?[\]]/.test(arg))) return undefined;
    if (name === 'ls') return [...paths, ...operands.flatMap((arg) => arg.startsWith('-') ? [] : [arg])];
    return operands.length <= 1 ? [...paths, ...operands] : undefined;
  }
  if (['grep', 'egrep', 'fgrep'].includes(name)) {
    let patternSeen = false;
    for (let index = 0; index < operands.length; index++) {
      const text = operands[index]!;
      if (text === '-f' || text === '--file' || text === '--exclude-from' || text === '-e' || text === '--regexp') {
        const path = operands[++index];
        if (path === undefined) return undefined;
        if (text !== '--exclude-from') patternSeen = true;
        if (text === '-f' || text === '--file' || text === '--exclude-from') paths.push(path);
      } else if (text.startsWith('--file=')) {
        patternSeen = true;
        paths.push(text.slice('--file='.length));
      } else if (text.startsWith('--exclude-from=')) {
        paths.push(text.slice('--exclude-from='.length));
      } else if (text.startsWith('--regexp=')) {
        patternSeen = true;
      } else if (/^-[^-]*f.+/.test(text)) {
        patternSeen = true;
        paths.push(text.slice(text.indexOf('f') + 1));
      } else if (/^-[^-]*e.+/.test(text)) {
        patternSeen = true;
      } else if (/^-[^-]*[ef]$/.test(text)) {
        const path = operands[++index];
        if (path === undefined) return undefined;
        patternSeen = true;
        if (text.endsWith('f')) paths.push(path);
      } else if (text === '--') {
        if (!patternSeen) index++;
        paths.push(...operands.slice(index + 1));
        break;
      } else if (text.startsWith('-')) {
        continue;
      } else if (!patternSeen) {
        patternSeen = true;
      } else {
        paths.push(text);
      }
    }
    return paths;
  }
  if (operands.some((text) => /^--(?:output|exclude|exclude-from|files0-from)(?:=|$)/.test(text))) {
    return undefined;
  }
  for (let index = 0; index < operands.length; index++) {
    const text = operands[index]!;
    if (text === '--') {
      paths.push(...operands.slice(index + 1));
      break;
    }
    if (text === '--version' || text === '--help') continue;
    if (/^--[a-zA-Z][a-zA-Z0-9-]*=/.test(text)) continue;
    if (/^--[a-zA-Z][a-zA-Z0-9-]*$/.test(text)) continue;
    if (/^-[a-zA-Z]+$/.test(text)) {
      if (['head', 'tail'].includes(name) && ['-n', '-c'].includes(text)) index++;
      continue;
    }
    paths.push(text);
  }
  return paths;
}

function isLiteral(node: BashSyntaxNode): boolean {
  return literalText(node) !== undefined;
}

function literalText(node: BashSyntaxNode): string | undefined {
  switch (node.type) {
    case 'word':
      return node.text.replaceAll(/\\(.)/gs, '$1');
    case 'number':
      return node.text;
    case 'raw_string':
      return node.text.length >= 2 ? node.text.slice(1, -1) : undefined;
    case 'string':
      return node.children.every((child) => !child.isNamed || child.type === 'string_content')
        ? node.children.filter((child) => child.type === 'string_content').map((child) => child.text).join('')
        : undefined;
    case 'concatenation': {
      const parts = node.children.map(literalText);
      return parts.every((part) => part !== undefined) ? parts.join('') : undefined;
    }
    default:
      return undefined;
  }
}
