import type { BashParseResult, BashSyntaxNode } from '#/app/bashParser/bashParser';

export type ArtexBashParse = (source: string) => BashParseResult;

export const ARTEX_ARGV_MAX_TOKENS = 8;

const UNSAFE_OPERAND = /[$`*?[\]~]/;

/**
 * The arity table (port of ARTEX intercept.argvArity): how many leading tokens
 * of a command form its prefix (the program plus its subcommands). The longest
 * entry matching the start of the argv wins; an unlisted program takes 1.
 */
const ARGV_ARITY: ReadonlyMap<string, number> = new Map([
  ['cat', 1],
  ['cd', 1],
  ['ls', 1],
  ['rm', 1],
  ['grep', 1],
  ['head', 1],
  ['tail', 1],
  ['echo', 1],
  ['pwd', 1],
  ['find', 1],
  ['curl', 1],
  ['wget', 1],
  ['nmap', 1],
  ['git', 2],
  ['npm', 2],
  ['docker', 2],
  ['kubectl', 2],
  ['terraform', 2],
  ['npm run', 3],
  ['docker compose', 3],
  ['kubectl rollout', 3],
  ['git config', 3],
  ['gcloud', 3],
  ['gh', 3],
  ['aws', 3],
]);

const ARGV_WRAPPERS: ReadonlySet<string> = new Set([
  'command',
  'builtin',
  'env',
  'exec',
  'eval',
]);

const DISALLOWED_ARGV_NODES: ReadonlySet<string> = new Set([
  'pipeline',
  'list',
  'command_substitution',
  'process_substitution',
  'subshell',
  'compound_statement',
  'negated_command',
  'for_statement',
  'while_statement',
  'if_statement',
  'case_statement',
  'function_definition',
  'brace_expression',
  'ansi_c_string',
  'expansion',
  'simple_expansion',
  'arithmetic_expansion',
  'string_expansion',
  'variable_assignment',
  'file_redirect',
  'heredoc_redirect',
  'heredoc_body',
  'redirected_statement',
]);

function argvPrefixLen(tokens: readonly (string | undefined)[]): number {
  for (let n = tokens.length; n > 0; n -= 1) {
    if (tokens.slice(0, n).some((token) => token === undefined)) continue;
    const key = tokens.slice(0, n).join(' ');
    const arity = ARGV_ARITY.get(key);
    if (arity !== undefined) return Math.min(arity, tokens.length);
  }
  return Math.min(1, tokens.length);
}

export function argvPrefixOf(tokens: readonly (string | undefined)[]): readonly (string | undefined)[] {
  return tokens.slice(0, argvPrefixLen(tokens));
}

export function checkArgvToken(token: string): boolean {
  if (token === '') return false;
  if (token.startsWith('-')) return false;
  if (/[;&|><`$()]/.test(token) || /\s/.test(token)) return false;
  return true;
}

/**
 * Validates an argv rule pattern: a JSON array of 1 to 8 tokens, each non-empty,
 * not a flag, without a shell metacharacter or whitespace. Returns the tokens or
 * undefined for an invalid pattern (the rule is skipped). Ported from
 * ARTEX intercept.ParseArgvPattern.
 */
export function parseArgvPattern(pattern: string): readonly string[] | undefined {
  let tokens: unknown;
  try {
    tokens = JSON.parse(pattern);
  } catch {
    return undefined;
  }
  if (!Array.isArray(tokens)) return undefined;
  if (tokens.length === 0 || tokens.length > ARTEX_ARGV_MAX_TOKENS) return undefined;
  const out: string[] = [];
  for (const token of tokens) {
    if (typeof token !== 'string' || !checkArgvToken(token)) return undefined;
    out.push(token);
  }
  return out;
}

interface ExtractedCommand {
  readonly tokens: readonly (string | undefined)[];
}

function extractSimpleCommand(command: string, parse: ArtexBashParse): ExtractedCommand | undefined {
  const parsed = parse(command);
  if (!parsed.ok || parsed.hasError) return undefined;
  if (hasDisallowedNode(parsed.root)) return undefined;
  const commands: BashSyntaxNode[] = [];
  collectCommands(parsed.root, commands);
  if (commands.length !== 1) return undefined;
  const node = commands[0];
  if (node === undefined) return undefined;
  if (node.children.some((child) => child.type === 'background' || child.text === '&')) {
    return undefined;
  }
  const tokens = commandTokens(node);
  if (tokens.length === 0) return undefined;
  const program = tokens[0];
  if (program !== undefined && ARGV_WRAPPERS.has(baseName(program))) return undefined;
  return { tokens };
}

/**
 * Derives the prefix of a Bash command (program and subcommands): the leading
 * literal tokens up to the arity. Returns undefined when the command is not a
 * single simple command, a prefix token is non-literal, or a prefix token is a
 * flag. Ported from ARTEX intercept.ArgvPrefix.
 */
export function argvPrefix(command: string, parse: ArtexBashParse): readonly string[] | undefined {
  const extracted = extractSimpleCommand(command, parse);
  if (extracted === undefined) return undefined;
  const length = argvPrefixLen(extracted.tokens);
  const prefix: string[] = [];
  for (let i = 0; i < length; i += 1) {
    const token = extracted.tokens[i];
    if (token === undefined || !checkArgvToken(token)) return undefined;
    prefix.push(token);
  }
  return prefix;
}

/**
 * Reports whether a Bash call's command derives exactly the rule's prefix
 * tokens. Flags after the prefix are not constrained. Ported from ARTEX
 * intercept.argvRuleMatches.
 */
export function argvRuleMatches(
  ruleTokens: readonly string[],
  toolName: string,
  command: string | undefined,
  parse: ArtexBashParse,
): boolean {
  if (toolName !== 'Bash' || ruleTokens.length === 0 || command === undefined) return false;
  const prefix = argvPrefix(command, parse);
  if (prefix === undefined || prefix.length !== ruleTokens.length) return false;
  return prefix.every((token, index) => token === ruleTokens[index]);
}

function hasDisallowedNode(node: BashSyntaxNode): boolean {
  if (DISALLOWED_ARGV_NODES.has(node.type)) return true;
  return node.children.some(hasDisallowedNode);
}

function collectCommands(node: BashSyntaxNode, out: BashSyntaxNode[]): void {
  if (node.type === 'command') out.push(node);
  for (const child of node.children) collectCommands(child, out);
}

function commandTokens(command: BashSyntaxNode): readonly (string | undefined)[] {
  const nameIndex = command.children.findIndex((child) => child.type === 'command_name');
  if (nameIndex < 0) return [];
  const tokens: (string | undefined)[] = [];
  const nameNode = command.children[nameIndex];
  const nameWord = nameNode?.children.find((child) => child.isNamed);
  tokens.push(nameWord === undefined ? undefined : literalText(nameWord));
  for (const child of command.children.slice(nameIndex + 1)) {
    if (child.type === 'variable_assignment') continue;
    if (child.type === 'file_redirect' || child.type === 'heredoc_redirect') continue;
    tokens.push(literalText(child));
  }
  return tokens;
}

function literalText(node: BashSyntaxNode): string | undefined {
  switch (node.type) {
    case 'word': {
      const raw = node.text;
      if (raw.includes('\\')) return undefined;
      if (UNSAFE_OPERAND.test(raw)) return undefined;
      return raw;
    }
    case 'number':
      return node.text;
    case 'raw_string': {
      if (node.text.length < 2) return undefined;
      return node.text.slice(1, -1);
    }
    case 'string': {
      let value = '';
      for (const child of node.children) {
        if (child.type === 'string_content') value += child.text;
        else if (child.isNamed) return undefined;
      }
      return UNSAFE_OPERAND.test(value) ? undefined : value;
    }
    default:
      return undefined;
  }
}

function baseName(token: string): string {
  const separator = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return separator >= 0 ? token.slice(separator + 1) : token;
}

const ALWAYS_ALLOW_DENYLIST: ReadonlySet<string> = new Set(
  (
    'sh bash zsh dash ksh fish csh tcsh ash mksh rbash pwsh powershell python pypy ipython perl ruby irb ' +
    'node deno bun php lua luajit rscript tclsh wish expect awk gawk mawk nawk sed jshell osascript ' +
    'env command builtin exec eval source . nohup timeout nice ionice stdbuf setsid chroot unshare nsenter ' +
    'systemd-run su sudo doas pkexec runuser setpriv sg watch busybox toybox xargs parallel make gmake ' +
    'mapfile trap script find ssh scp sftp rsync socat ncat nc netcat flock strace ltrace gdb ' +
    'taskset chrt unbuffer rlwrap firejail bwrap proot proxychains torsocks tar zip vim vi nvim emacs less more man ' +
    'npm npx pnpm yarn bunx corepack pip pipx uv uvx poetry conda composer gem bundle bundler rake cargo go ' +
    'mvn gradle dotnet apt apt-get dpkg dnf yum rpm pacman apk brew snap flatpak ' +
    'docker docker-compose podman nerdctl kubectl helm ansible ansible-playbook terraform pulumi vagrant ' +
    'rm dd mkfs mkswap wipefs fdisk sfdisk parted shred truncate chmod chown kill pkill killall systemctl service ' +
    'iptables ip6tables nft ufw mount umount swapoff shutdown reboot poweroff halt init telinit crontab ' +
    'insmod rmmod modprobe'
  )
    .split(/\s+/)
    .filter((name) => name.length > 0),
);

/**
 * Normalizes a program token for the denylist: basename, lower case, no trailing
 * version, every mkfs.* reduced to mkfs. Ported from ARTEX intercept.argvProgramName.
 */
export function argvProgramName(token: string): string {
  const name = baseName(token).toLowerCase();
  if (name.startsWith('mkfs.')) return 'mkfs';
  let end = name.length;
  while (end > 0) {
    const char = name[end - 1];
    if (char === '.' || (char !== undefined && char >= '0' && char <= '9')) end -= 1;
    else break;
  }
  if (end > 0 && end < name.length) return name.slice(0, end);
  return name;
}

export function argvAllowDenied(program: string): boolean {
  return ALWAYS_ALLOW_DENYLIST.has(argvProgramName(program));
}

/**
 * Reports whether an argv allow rule whose first token is a denylisted program
 * is refused. Ported from ARTEX intercept.CheckArgvAllow.
 */
export function checkArgvAllow(tokens: readonly string[]): boolean {
  const first = tokens[0];
  return first !== undefined && argvAllowDenied(first);
}
