import { basename } from 'node:path';

import {
  descendantsOfType,
  parse,
  type SyntaxNode,
} from '@moonshot-ai/tree-sitter-bash';

export const READONLY_BASH_PARSE_BUDGET = { timeoutMs: 500, maxNodes: 20_000 } as const;

const NEUTRAL = new Set(['cd', 'pwd', 'echo', 'printf', 'true', 'false', 'sleep', 'test', '[', 'exit', 'wait', 'read']);
const PLAIN_READERS = new Set([
  'cat', 'head', 'tail', 'wc', 'ls', 'tree', 'file', 'stat', 'du', 'df', 'which', 'basename', 'dirname',
  'realpath', 'readlink', 'nl', 'cut', 'tr', 'column', 'diff', 'cmp', 'jq', 'od', 'strings', 'shasum',
  'md5', 'sha256sum', 'comm', 'paste', 'fold', 'grep', 'egrep', 'fgrep', 'rg', 'uniq', 'sort', 'xxd', 'date',
]);
const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'merge-base', 'shortlog',
  'cat-file', 'ls-tree', 'grep', 'rev-list', 'name-rev', 'for-each-ref', 'show-ref', 'whatchanged',
]);
const GH_READ: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(['view', 'list', 'diff', 'checks', 'status']),
  issue: new Set(['view', 'list', 'status']),
  run: new Set(['view', 'list', 'watch']),
  repo: new Set(['view']),
};
const SED_PRINT_SCRIPT = /^(\s*((\d+|\$)(,(\d+|\$|\+\d+))?|\/[^/]*\/(,\/[^/]*\/)?)?\s*[pq=]\s*;?)+$/;

interface CommandParts {
  readonly name: string;
  readonly args: readonly string[];
}

function commandParts(command: SyntaxNode): CommandParts | undefined {
  const nameIndex = command.children.findIndex((child) => child.type === 'command_name');
  if (nameIndex < 0) return undefined;
  const nameNode = command.children[nameIndex];
  if (nameNode === undefined) return undefined;
  const name = basename(nameNode.text.replaceAll(/^['"]|['"]$/g, ''));
  const args: string[] = [];
  for (const child of command.children.slice(nameIndex + 1)) {
    if (!child.isNamed) continue;
    if (child.type === 'file_redirect' || child.type === 'heredoc_redirect' || child.type === 'herestring_redirect') continue;
    args.push(child.text.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1'));
  }
  return { name, args };
}

function redirectAllowed(text: string): boolean {
  const normalized = text.replaceAll(/\s+/g, '');
  const readWrite = /^\d*<>(.*)$/.exec(normalized);
  if (readWrite !== null) return readWrite[1] === '/dev/null';
  if (/^\d*<(?![<>])/.test(normalized) || normalized.startsWith('<<<')) return true;
  const match = /^(\d*|&)(>>|>|>&|>\|)(.*)$/.exec(normalized);
  if (match === null) return false;
  const destination = match[3];
  return destination === '/dev/null' || destination !== undefined && (/^&?[0-2]$/.test(destination) || destination === '&-');
}

function environmentAssignmentAllowed(node: SyntaxNode): boolean {
  const separator = node.text.indexOf('=');
  const name = separator < 0 ? node.text : node.text.slice(0, separator);
  if (['LC_ALL', 'LANG', 'TZ', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'TERM', 'COLUMNS', 'LINES'].includes(name) || name.startsWith('LC_')) return true;
  if (name !== 'PAGER' && name !== 'GIT_PAGER') return false;
  return node.text.slice(separator + 1) === 'cat';
}

function gitReadonly(args: readonly string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree') {
      index += 2;
      continue;
    }
    if (arg === '-c') return false;
    if (arg?.startsWith('--git-dir=') || arg?.startsWith('--work-tree=') || arg === '--no-pager' || arg === '-P') {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (subcommand === undefined) return false;
  if (rest.some((arg) =>
    arg === '--output' || arg.startsWith('--output=') ||
    arg === '--ext-diff' || arg === '--textconv' ||
    arg.startsWith('-O') || arg.startsWith('--open-files-in-pager'))) return false;
  if (GIT_READ.has(subcommand)) return true;
  if (subcommand === 'branch') {
    return rest.every((arg) =>
      ['-a', '-r', '--list', '-v', '-vv', '--show-current', '--all', '--remotes'].includes(arg) ||
      arg.startsWith('--contains') || arg.startsWith('--format') || arg.startsWith('--sort'));
  }
  if (subcommand === 'remote' && rest.every((arg) => ['-v', 'show', 'get-url'].includes(arg) || !arg.startsWith('-'))) {
    return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url';
  }
  if (subcommand === 'worktree') return rest[0] === 'list';
  if (subcommand === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (subcommand === 'config') return rest.some((arg) => arg === '--get' || arg === '--list' || arg === '-l' || arg === '--get-all');
  if (subcommand === 'tag') {
    return rest.every((arg) =>
      arg === '-l' || arg === '--list' || arg.startsWith('--sort') || arg.startsWith('--contains'));
  }
  return false;
}

function ghReadonly(args: readonly string[]): boolean {
  const [group, verb] = args;
  if (group === 'api') {
    if ((verb ?? '').includes('graphql')) return false;
    return !args.some((arg, index) =>
      ['-f', '-F', '--field', '--raw-field', '--input'].includes(arg) || /^-[fF]./.test(arg) ||
      arg.startsWith('--field=') || arg.startsWith('--raw-field=') || arg.startsWith('--input=') ||
      ((arg === '-X' || arg === '--method') && (args[index + 1] ?? '').toUpperCase() !== 'GET') ||
      (arg.startsWith('--method=') && arg.slice(9).toUpperCase() !== 'GET') ||
      (/^-X[A-Za-z]+$/.test(arg) && arg.slice(2).toUpperCase() !== 'GET'));
  }
  return group !== undefined && verb !== undefined && GH_READ[group]?.has(verb) === true;
}

function dateReadonly(args: readonly string[]): boolean {
  const bsdDisplayOnly = args.includes('-j');
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) return false;
    if (arg.startsWith('+') || ['-u', '--utc', '--universal', '-R', '--rfc-2822', '--rfc-email', '-j'].includes(arg)) continue;
    if (arg.startsWith('-I') || arg.startsWith('--iso-8601') || arg.startsWith('--rfc-3339=') || arg.startsWith('-v')) continue;
    if (['-d', '--date', '-r', '--reference'].includes(arg)) {
      if (args[index + 1] === undefined) return false;
      index++;
      continue;
    }
    if (/^(?:-d|--date|-r|--reference)=.+/.test(arg)) continue;
    if (arg === '-f') {
      if (!bsdDisplayOnly || args[index + 1] === undefined) return false;
      index++;
      continue;
    }
    if (bsdDisplayOnly && !arg.startsWith('-')) continue;
    return false;
  }
  return true;
}

function commandReadonly({ name, args }: CommandParts): boolean {
  if (NEUTRAL.has(name)) return true;
  if (name === 'sort' && args.some((arg) => /^-[^-]*o/.test(arg) || arg.startsWith('--output'))) return false;
  if (name === 'uniq' && args.filter((arg) => !arg.startsWith('-')).length >= 2) return false;
  if (name === 'xxd' && (args.includes('-r') || args.filter((arg) => !arg.startsWith('-')).length >= 2)) return false;
  if (name === 'date' && !dateReadonly(args)) return false;
  if (name === 'rg' && args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))) return false;
  if (name === 'tree' && args.some((arg) => /^-(?!-).*o/.test(arg))) return false;
  if (name === 'sort' && args.some((arg) => arg === '--compress-program' || arg.startsWith('--compress-program='))) return false;
  if (name === 'file' && args.some((arg) => /^-(?!-).*C/.test(arg) || arg === '--compile')) return false;
  if (PLAIN_READERS.has(name)) return true;
  if (name === 'sed') {
    if (args.some((arg) => /^-(?!-).*i/.test(arg) || arg.startsWith('--in-place'))) return false;
    if (args.some((arg) => arg === '-f' || arg === '--file' || arg.startsWith('--file='))) return false;
    const quiet = args.some((arg) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(arg) || arg === '--quiet' || arg === '--silent');
    const scripts: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '-e') {
        scripts.push(args[index + 1] ?? '');
        index++;
        continue;
      }
      if (arg?.startsWith('-')) continue;
      if (arg !== undefined && scripts.length === 0) scripts.push(arg);
    }
    return quiet && scripts.length > 0 && scripts.every((script) => SED_PRINT_SCRIPT.test(script));
  }
  if (name === 'find') {
    return !args.some((arg) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg));
  }
  if (name === 'git') return gitReadonly(args);
  if (name === 'gh') return ghReadonly(args);
  return false;
}

export function isReadonlyBash(source: string): boolean {
  const parsed = parse(source, READONLY_BASH_PARSE_BUDGET);
  if (!parsed.ok || parsed.hasError) return false;
  const nodes = descendantsOfType(parsed.rootNode);
  if (nodes.some((node) => node.type === 'function_definition')) return false;
  if (nodes.some((node) => node.type === 'variable_assignment' && !environmentAssignmentAllowed(node))) return false;
  if (nodes.some((node) => node.type === 'file_redirect' && !redirectAllowed(node.text))) return false;
  const commands = nodes
    .filter((node) => node.type === 'command')
    .map(commandParts)
    .filter((command): command is CommandParts => command !== undefined);
  if (commands.length === 0 || commands.some((command) => command.name === 'tee')) return false;
  return commands.every(commandReadonly);
}
