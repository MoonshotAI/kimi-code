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
import { realpathExistingPrefix } from '#/environment/environment';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { isHostFsNotDirectory, isHostFsNotFound } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { canonicalizePath, isSensitiveFile, normalizeUserPath } from '#/tool/path-access';
import {
  BASIC_FILE_READ_COMMANDS,
  CWD_READING_COMMANDS,
  DOCKER_READ_ONLY_SPECS,
  EXACT_READ_ONLY_INVOCATIONS,
  FD_FLAG_SPEC,
  FILE_COMMAND_SPECS,
  GIT_SUBCOMMAND_SPECS,
  GREP_FLAG_SPEC,
  NO_ARG_READ_ONLY_COMMANDS,
  RG_FLAG_SPEC,
  ZERO_FILE_COMMAND_SPECS,
  hasUnsafeControlOrBidi,
  hasUnsafeGitFormat,
  isRiskyWindowsPath,
  isSafeEnvValue,
  validateSafeFlags,
} from './bash-read-only-specs';
import { acquireEnvironmentLease } from './environment-lease';
import { hasGitPathComponent, isGitControlPath } from './path-utils';

const PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

const STRUCTURAL_NODES: ReadonlySet<string> = new Set([
  'program',
  'list',
  'pipeline',
  'redirected_statement',
  'negated_command',
]);

const ALLOWED_STRUCTURAL_TOKENS: ReadonlySet<string> = new Set([
  '&&',
  '||',
  ';',
  '|',
  '|&',
  '!',
  '\n',
]);

const TIMEOUT_DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;
const TIMEOUT_EXEMPT_BUILTINS: ReadonlySet<string> = new Set(['cd', 'alias', 'history', 'type']);
const FIND_DANGEROUS_FLAG_RE =
  /^-(?:delete|rm|exec|ok|fprint|fls|files0-from)/;
const JQ_UNSAFE_FILTER_RE = /\b(?:env|include|import)\b|\$ENV\b/;
const SIMPLE_SED_PRINT_RE = /^\d+(?:,(?:\d+|\$))?p$/;
const WORD_UNSAFE_CHARS_RE = /[$`<>|&;(){}*?[\]]/;
const WORD_TILDE_EXPANSION_RE = /(?:^|[=:])~/;

export interface BashReadOnlyAnalysis {
  readonly paths: string[];
  readonly readsCwd: boolean;
  readonly usesGit?: boolean;
  readonly hasRiskyWindowsArg?: boolean;
}

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
    if (hasUnsafeControlOrBidi(command)) return undefined;
    const readOnly = analyzeBashReadOnly(this.bashParser.parse(command, PARSE_OPTIONS));
    if (readOnly === undefined) return undefined;
    if (readOnly.paths.length === 0 && !readOnly.readsCwd && !readOnly.hasRiskyWindowsArg) {
      return { kind: 'approve' };
    }
    const lease = acquireEnvironmentLease(this.environment);
    if (lease === undefined) return undefined;
    try {
      const pathClass = lease.environment.host?.pathClass;
      if (pathClass === undefined) return undefined;
      if (pathClass === 'win32' && readOnly.hasRiskyWindowsArg) return undefined;
      if (readOnly.paths.length === 0 && !readOnly.readsCwd) return { kind: 'approve' };
      const view = new EnvironmentWorkspaceView(lease.environment, {
        workDir: this.workspace.workDir,
        additionalDirs: this.workspace.additionalDirs,
      });
      const fs = lease.environment.fs;
      if (fs === undefined) return undefined;
      const requestedCwd = (context.args as { readonly cwd?: unknown }).cwd;
      if (requestedCwd !== undefined && typeof requestedCwd !== 'string') return undefined;
      let cwd: string;
      try {
        if (requestedCwd !== undefined) {
          if (pathClass === 'win32' && isRiskyWindowsPath(requestedCwd)) return undefined;
          const bridgedCwd = view.shellPathBridge?.fromShellPath(requestedCwd) ?? requestedCwd;
          const normalizedCwd = normalizeUserPath(bridgedCwd, pathClass);
          if (pathClass === 'win32' && (isRiskyWindowsPath(normalizedCwd) || isUnresolvedPosixPath(normalizedCwd))) {
            return undefined;
          }
          cwd = view.resolve(normalizedCwd);
        } else {
          cwd = view.resolve(view.workDir);
        }
      } catch {
        return undefined;
      }
      if (cwd.length === 0 || !view.path.isAbsolute(cwd)) return undefined;
      if (pathClass === 'win32' && isRiskyWindowsPath(cwd)) return undefined;
      const paths = readOnly.paths.map((path) => {
        if (pathClass === 'win32' && isRiskyWindowsPath(path)) return undefined;
        if (path.startsWith('~') && lease.environment.host?.homeDir === undefined) return undefined;
        try {
          const bridged = view.shellPathBridge?.fromShellPath(path) ?? path;
          if (pathClass === 'win32' && isRiskyWindowsPath(bridged)) return undefined;
          const expanded = bridged === '~'
            ? lease.environment.host!.homeDir
            : bridged.startsWith('~/') || (pathClass === 'win32' && bridged.startsWith('~\\'))
              ? `${lease.environment.host!.homeDir}/${bridged.slice(2)}`
              : bridged;
          const canonical = canonicalizePath(expanded, cwd, pathClass);
          if (pathClass === 'win32' && (isRiskyWindowsPath(canonical) || isUnresolvedPosixPath(canonical))) {
            return undefined;
          }
          return canonical;
        } catch {
          return undefined;
        }
      });
      if (paths.some((path) => path === undefined)) return undefined;
      const nativeCwd = pathClass === 'win32' && isUnresolvedPosixPath(cwd)
        ? view.shellPathBridge?.fromShellPath(cwd) ?? cwd
        : cwd;
      if (pathClass === 'win32' && (isRiskyWindowsPath(nativeCwd) || isUnresolvedPosixPath(nativeCwd))) {
        return undefined;
      }
      const resolvedCwd = await realpathExistingPrefix(
        fs,
        view.path,
        nativeCwd,
        (error) => isHostFsNotFound(error) || isHostFsNotDirectory(error),
      ).catch(() => undefined);
      if (resolvedCwd === undefined) return undefined;
      if (readOnly.usesGit && await hasBareGitIndicators(fs, resolvedCwd, view.path)) {
        return undefined;
      }
      const marker = await findGitWorkTree(fs, resolvedCwd);
      const targets = [cwd, ...paths as string[]];
      const resolvedPaths: ([string, string] | undefined)[] = [];
      for (let index = 0; index < targets.length; index += 8) {
        resolvedPaths.push(...await Promise.all(targets.slice(index, index + 8).map(async (path): Promise<[string, string] | undefined> => {
          try {
            return [path, await realpathExistingPrefix(
              fs,
              view.path,
              path,
              (error) => isHostFsNotFound(error) || isHostFsNotDirectory(error),
            )] as [string, string];
          } catch {
            return undefined;
          }
        })));
        if (context.signal.aborted) return undefined;
      }
      if (resolvedPaths.some((entry) => entry === undefined)) return undefined;
      const checks = resolvedPaths as [string, string][];
      if (checks.some((entry) => entry.some(isSensitiveFile))) return undefined;
      if (checks.some((entry) => entry.some((path) => hasGitPathComponent(path, cwd, pathClass)))) {
        return undefined;
      }
      if (
        marker !== null &&
        checks.some((entry) => entry.some((path) => isGitControlPath(
          canonicalizePath(path, resolvedCwd, pathClass),
          marker,
          pathClass,
        )))
      ) {
        return undefined;
      }
      return { kind: 'approve' };
    } finally {
      lease.dispose();
    }
  }
}

function isUnresolvedPosixPath(path: string): boolean {
  return path.startsWith('/');
}

async function hasBareGitIndicators(
  fs: IHostFileSystem,
  dir: string,
  pathApi: { join(...parts: readonly string[]): string },
): Promise<boolean> {
  const [head, objects, refs] = await Promise.all([
    fs.stat(pathApi.join(dir, 'HEAD')).then((stat) => stat.isFile, () => false),
    fs.stat(pathApi.join(dir, 'objects')).then((stat) => stat.isDirectory, () => false),
    fs.stat(pathApi.join(dir, 'refs')).then((stat) => stat.isDirectory, () => false),
  ]);
  return head && (objects || refs);
}

interface CollectedCommand {
  readonly node: BashSyntaxNode;
  readonly arguments: BashSyntaxNode[];
  readonly inputs: BashSyntaxNode[];
}

interface AnalyzedCommandResult {
  readonly paths: string[];
  readonly readsCwd: boolean;
  readonly usesGit: boolean;
  readonly isCd: boolean;
  readonly hasRiskyWindowsArg?: boolean;
}

export function analyzeBashReadOnly(result: BashParseResult): BashReadOnlyAnalysis | undefined {
  if (!result.ok || result.hasError) return undefined;
  if (hasUnsafeControlOrBidi(result.root.text)) return undefined;
  const commands: CollectedCommand[] = [];
  if (!collectCommands(result.root, commands) || commands.length === 0) return undefined;
  const paths: string[] = [];
  let readsCwd = false;
  let usesGit = false;
  let hasRiskyWindowsArg = false;
  for (const command of commands) {
    const analyzed = analyzeCommand(command.node, command.arguments, command.inputs);
    if (analyzed === undefined) return undefined;
    if (commands.length > 1 && analyzed.isCd) return undefined;
    if (analyzed.readsCwd) readsCwd = true;
    if (analyzed.usesGit) usesGit = true;
    if (analyzed.hasRiskyWindowsArg) hasRiskyWindowsArg = true;
    paths.push(...analyzed.paths);
  }
  return {
    paths,
    readsCwd,
    ...(usesGit ? { usesGit: true } : {}),
    ...(hasRiskyWindowsArg ? { hasRiskyWindowsArg: true } : {}),
  };
}

function collectCommands(node: BashSyntaxNode, out: CollectedCommand[]): boolean {
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
  if (node.type === 'comment') return true;
  if (!STRUCTURAL_NODES.has(node.type)) return false;
  return node.children.every((child) => {
    if (!child.isNamed) return ALLOWED_STRUCTURAL_TOKENS.has(child.type);
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
    if (path.length === 0 || /^\/dev\/(?:tcp|udp)\//.test(path)) return false;
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

function isSafeLeadingAssignment(node: BashSyntaxNode): boolean {
  if (node.type !== 'variable_assignment') return false;
  const nameNode = node.children[0];
  const operatorNode = node.children[1];
  if (nameNode?.type !== 'variable_name' || operatorNode?.text !== '=' || node.children.length > 3) {
    return false;
  }
  const valueNode = node.children[2];
  const value = valueNode === undefined ? '' : literalText(valueNode);
  if (value === undefined) return false;
  return isSafeEnvValue(nameNode.text, value);
}

function analyzeCommand(
  command: BashSyntaxNode,
  redirectArguments: BashSyntaxNode[],
  redirectInputs: BashSyntaxNode[],
): AnalyzedCommandResult | undefined {
  const nameIndex = command.children.findIndex((child) => child.type === 'command_name');
  const commandName = command.children[nameIndex];
  if (nameIndex < 0 || commandName?.children.length !== 1) return undefined;
  const rawName = literalText(commandName.children[0]!);
  if (rawName === undefined || rawName.length === 0) return undefined;
  for (const prefix of command.children.slice(0, nameIndex)) {
    if (prefix.type === 'file_redirect' || prefix.type === 'heredoc_redirect') continue;
    if (!isSafeLeadingAssignment(prefix)) return undefined;
  }
  const inputPaths = redirectInputs.map(literalText);
  if (inputPaths.some((path) => path === undefined)) return undefined;
  const basePaths = inputPaths.filter((path): path is string => path !== undefined && path.length > 0);
  const rawArgs = command.children
    .filter((child) =>
      child.startIndex > commandName.endIndex &&
      child.type !== 'file_redirect' &&
      child.type !== 'heredoc_redirect'
    )
    .toSorted((left, right) => left.startIndex - right.startIndex);
  if (rawName === 'cd' && redirectArguments.length === 0) {
    const cdTarget = analyzeCd(rawArgs);
    if (cdTarget === undefined) return undefined;
    return { paths: [...basePaths, cdTarget], readsCwd: true, usesGit: false, isCd: true };
  }
  rawArgs.push(...redirectArguments);
  const texts = rawArgs.map(literalText);
  if (texts.some((text) => text === undefined)) return undefined;
  const args = texts as string[];
  const analyzed = analyzeUnwrappedInvocation(rawName, args, basePaths, 0);
  if (analyzed === undefined) return undefined;
  const hasRiskyWin =
    isRiskyWindowsPath(rawName) ||
    basePaths.some(isRiskyWindowsPath) ||
    args.some(isRiskyWindowsPath);
  return hasRiskyWin ? { ...analyzed, hasRiskyWindowsArg: true } : analyzed;
}

function analyzeCd(args: readonly BashSyntaxNode[]): string | undefined {
  if (args.length > 1) return undefined;
  if (args.length === 0) return '~';
  const arg = args[0]!;
  if (arg.text === '~') return '~';
  if (arg.text.startsWith('~/')) {
    const suffix = arg.text.slice(2);
    if (
      arg.type === 'word' &&
      !WORD_UNSAFE_CHARS_RE.test(suffix) &&
      !suffix.includes('~') &&
      !suffix.includes('\\')
    ) {
      return arg.text;
    }
    const literal = literalText(arg);
    if (literal !== undefined) return literal;
    return undefined;
  }
  const literal = literalText(arg);
  if (literal === undefined || literal.length === 0 || literal.startsWith('-')) return undefined;
  return literal;
}

function analyzeUnwrappedInvocation(
  name: string,
  args: readonly string[],
  basePaths: readonly string[],
  depth: number,
): AnalyzedCommandResult | undefined {
  if (depth < 2 && name === 'command') {
    if (args.length === 2 && (args[0] === '-v' || args[0] === '-V') && isPlainCommandToken(args[1]!)) {
      return { paths: [...basePaths], readsCwd: false, usesGit: false, isCd: false };
    }
    let idx = 0;
    while (idx < args.length && /^-p+$/.test(args[idx]!)) idx++;
    if (args[idx] === '--') idx++;
    const inner = args[idx];
    if (inner === undefined || inner.startsWith('-')) return undefined;
    return analyzeUnwrappedInvocation(inner, args.slice(idx + 1), basePaths, depth + 1);
  }
  if (depth < 2 && name === 'timeout') {
    const duration = args[0];
    const inner = args[1];
    if (
      duration === undefined ||
      inner === undefined ||
      !TIMEOUT_DURATION_RE.test(duration) ||
      inner.startsWith('-') ||
      TIMEOUT_EXEMPT_BUILTINS.has(inner)
    ) {
      return undefined;
    }
    return analyzeUnwrappedInvocation(inner, args.slice(2), basePaths, depth + 1);
  }
  if (name === 'cd') {
    if (args.length > 1) return undefined;
    const target = args[0] ?? '~';
    if (target.startsWith('-') || (target.startsWith('~') && target !== '~' && !target.startsWith('~/'))) {
      return undefined;
    }
    return { paths: [...basePaths, target], readsCwd: true, usesGit: false, isCd: true };
  }
  const nonEmpty = args.filter((text) => text.length > 0);
  if (EXACT_READ_ONLY_INVOCATIONS.some(
    (invocation) => invocation[0] === name
      && invocation.length === args.length + 1
      && invocation.slice(1).every((expected, index) => expected === args[index]),
  )) {
    return { paths: [...basePaths], readsCwd: false, usesGit: false, isCd: false };
  }
  if (NO_ARG_READ_ONLY_COMMANDS.has(name)) {
    return nonEmpty.length === 0
      ? { paths: [...basePaths], readsCwd: false, usesGit: false, isCd: false }
      : undefined;
  }
  if (name === 'history') {
    return args.length === 0 || (args.length === 1 && /^\d+$/.test(args[0]!))
      ? { paths: [...basePaths], readsCwd: false, usesGit: false, isCd: false }
      : undefined;
  }
  if (name === 'arch') {
    return args.length === 0 || (args.length === 1 && (args[0] === '-h' || args[0] === '--help'))
      ? { paths: [...basePaths], readsCwd: false, usesGit: false, isCd: false }
      : undefined;
  }
  if (name === 'ifconfig') {
    return nonEmpty.length === 0 || (nonEmpty.length === 1 && /^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(nonEmpty[0]!))
      ? { paths: [...basePaths], readsCwd: false, usesGit: false, isCd: false }
      : undefined;
  }
  if (name === 'echo') {
    return { paths: [...basePaths], readsCwd: false, usesGit: false, isCd: false };
  }
  if (name === 'docker') {
    return analyzeDocker(nonEmpty, basePaths);
  }
  if (name === 'git') {
    return analyzeGit(nonEmpty, basePaths);
  }
  if (name === 'sed') {
    return analyzeSed(nonEmpty, basePaths);
  }
  if (name === 'find') {
    return analyzeFind(nonEmpty, basePaths);
  }
  if (name === 'rg') {
    return analyzeRg(nonEmpty, basePaths);
  }
  if (name === 'fd' || name === 'fdfind') {
    return analyzeFd(nonEmpty, basePaths);
  }
  if (name === 'grep' || name === 'egrep' || name === 'fgrep') {
    return analyzeGrep(nonEmpty, basePaths);
  }
  if (name === 'uniq') {
    return analyzeUniq(nonEmpty, basePaths);
  }
  const zeroFileSpec = ZERO_FILE_COMMAND_SPECS[name];
  if (zeroFileSpec !== undefined) {
    return analyzeZeroFileCommand(name, nonEmpty, zeroFileSpec, basePaths);
  }
  const fileSpec = FILE_COMMAND_SPECS[name];
  if (fileSpec !== undefined) {
    return analyzeSpecFileCommand(name, nonEmpty, fileSpec, basePaths);
  }
  if (!BASIC_FILE_READ_COMMANDS.has(name)) return undefined;
  const basicPaths = analyzeBasicFileCommand(name, nonEmpty, basePaths);
  if (basicPaths === undefined) return undefined;
  return {
    paths: basicPaths,
    readsCwd: CWD_READING_COMMANDS.has(name),
    usesGit: false,
    isCd: false,
  };
}

function isPlainCommandToken(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !value.includes('/') && !value.includes('\\') && !value.includes('~');
}

function analyzeZeroFileCommand(
  name: string,
  args: readonly string[],
  spec: (typeof ZERO_FILE_COMMAND_SPECS)[string],
  basePaths: readonly string[],
): AnalyzedCommandResult | undefined {
  const parsed = validateSafeFlags(args, spec);
  if (parsed === undefined) return undefined;
  if (name === 'date') {
    if (parsed.positionals.some((arg) => !arg.startsWith('+'))) return undefined;
  } else if (name === 'which' || name === 'type') {
    if (parsed.positionals.some((arg) => !isPlainCommandToken(arg))) return undefined;
  } else if (name === 'id' || name === 'groups') {
    if (parsed.positionals.length > 1 || parsed.positionals.some((arg) => !/^[A-Za-z0-9_.-]+$/.test(arg))) {
      return undefined;
    }
  } else if (name === 'seq') {
    if (parsed.positionals.length === 0 || parsed.positionals.length > 3) return undefined;
    if (parsed.positionals.some((arg) => !/^-?\d+(?:\.\d+)?$/.test(arg))) return undefined;
  } else if (name !== 'tr') {
    if (parsed.positionals.length > 0) return undefined;
  }
  return { paths: [...basePaths], readsCwd: false, usesGit: false, isCd: false };
}

function analyzeSpecFileCommand(
  name: string,
  args: readonly string[],
  spec: (typeof FILE_COMMAND_SPECS)[string],
  basePaths: readonly string[],
): AnalyzedCommandResult | undefined {
  const parsed = validateSafeFlags(args, spec);
  if (parsed === undefined) return undefined;
  if (name === 'jq') {
    if (parsed.positionals.length === 0) return undefined;
    const filter = parsed.positionals[0]!;
    if (JQ_UNSAFE_FILTER_RE.test(filter)) return undefined;
    return {
      paths: [...basePaths, ...parsed.positionals.slice(1)],
      readsCwd: false,
      usesGit: false,
      isCd: false,
    };
  }
  return {
    paths: [...basePaths, ...parsed.positionals],
    readsCwd: CWD_READING_COMMANDS.has(name),
    usesGit: false,
    isCd: false,
  };
}

function analyzeDocker(
  args: readonly string[],
  basePaths: readonly string[],
): AnalyzedCommandResult | undefined {
  const subcommand = args[0];
  if (subcommand === undefined) return undefined;
  const spec = DOCKER_READ_ONLY_SPECS[subcommand];
  if (spec === undefined) return undefined;
  const parsed = validateSafeFlags(args.slice(1), spec);
  if (parsed === undefined) return undefined;
  if (subcommand === 'ps' && parsed.positionals.length > 0) return undefined;
  if (subcommand === 'images' && parsed.positionals.length > 1) return undefined;
  return { paths: [...basePaths], readsCwd: false, usesGit: false, isCd: false };
}

function analyzeGit(
  args: readonly string[],
  basePaths: readonly string[],
): AnalyzedCommandResult | undefined {
  let startIndex = 0;
  while (startIndex < args.length && args[startIndex] === '--no-pager') {
    startIndex++;
  }
  const first = args[startIndex];
  if (first === undefined || first.startsWith('-')) return undefined;
  const second = args[startIndex + 1];
  const twoWordKey = second !== undefined ? `${first} ${second}` : undefined;
  const subcommandKey =
    twoWordKey !== undefined && Object.hasOwn(GIT_SUBCOMMAND_SPECS, twoWordKey)
      ? twoWordKey
      : Object.hasOwn(GIT_SUBCOMMAND_SPECS, first)
        ? first
        : undefined;
  if (subcommandKey === undefined) return undefined;
  const spec = GIT_SUBCOMMAND_SPECS[subcommandKey]!;
  const restArgs = args.slice(startIndex + (subcommandKey.includes(' ') ? 2 : 1));
  const parsed = validateSafeFlags(restArgs, spec);
  if (parsed === undefined) return undefined;
  if (hasUnsafeGitFormat(parsed.flagValues)) return undefined;
  if (subcommandKey === 'branch' || subcommandKey === 'tag') {
    const isList = parsed.seenFlags.has('-l') || parsed.seenFlags.has('--list');
    if (parsed.positionals.length > 0 && !isList) return undefined;
  }
  if (subcommandKey === 'remote' && parsed.positionals.length > 0) return undefined;
  const paths = [...basePaths];
  if (
    subcommandKey === 'diff' ||
    subcommandKey === 'log' ||
    subcommandKey === 'blame' ||
    subcommandKey === 'ls-files'
  ) {
    paths.push(...parsed.positionals);
  } else if (subcommandKey === 'show') {
    for (const arg of parsed.positionals) {
      const colonIndex = arg.indexOf(':');
      if (colonIndex >= 0 && colonIndex < arg.length - 1) {
        paths.push(arg.slice(colonIndex + 1));
      } else {
        paths.push(arg);
      }
    }
  }
  return { paths, readsCwd: true, usesGit: true, isCd: false };
}

function analyzeSed(
  args: readonly string[],
  basePaths: readonly string[],
): AnalyzedCommandResult | undefined {
  let quiet = false;
  let expression: string | undefined;
  const paths = [...basePaths];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      const remaining = args.slice(index + 1);
      if (expression === undefined) {
        expression = remaining[0];
        paths.push(...remaining.slice(1));
      } else {
        paths.push(...remaining);
      }
      break;
    }
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
      quiet = true;
      continue;
    }
    if ((arg === '-e' || arg === '--expression') && expression === undefined) {
      expression = args[++index];
      if (expression === undefined) return undefined;
      continue;
    }
    if (arg.startsWith('-')) return undefined;
    if (expression === undefined) {
      expression = arg;
    } else {
      paths.push(arg);
    }
  }
  if (!quiet || expression === undefined || !SIMPLE_SED_PRINT_RE.test(expression)) return undefined;
  return { paths, readsCwd: false, usesGit: false, isCd: false };
}

function analyzeFind(
  args: readonly string[],
  basePaths: readonly string[],
): AnalyzedCommandResult | undefined {
  const paths = [...basePaths];
  let inExpressions = false;
  for (const arg of args) {
    if (FIND_DANGEROUS_FLAG_RE.test(arg)) return undefined;
    if (!inExpressions) {
      if (arg === '-H' || arg === '-L' || arg === '-P') continue;
      if (arg === '-f' || arg === '-D' || /^-O\d*$/.test(arg)) return undefined;
      if (arg.startsWith('-') || arg === '!' || arg === '(' || arg === ',') {
        inExpressions = true;
      } else {
        paths.push(arg);
      }
    }
  }
  return { paths, readsCwd: true, usesGit: false, isCd: false };
}

function analyzeRg(
  args: readonly string[],
  basePaths: readonly string[],
): AnalyzedCommandResult | undefined {
  const parsed = validateSafeFlags(args, RG_FLAG_SPEC);
  if (parsed === undefined) return undefined;
  const paths = [...basePaths];
  let patternSeen = parsed.seenFlags.has('-e') || parsed.seenFlags.has('--regexp') || parsed.seenFlags.has('--files');
  for (const [flag, value] of parsed.flagValues) {
    if (flag === '-f' || flag === '--file') {
      patternSeen = true;
      paths.push(value);
    }
  }
  const targetPaths = patternSeen ? parsed.positionals : parsed.positionals.slice(1);
  paths.push(...targetPaths);
  return { paths, readsCwd: targetPaths.length === 0, usesGit: false, isCd: false };
}

function analyzeFd(
  args: readonly string[],
  basePaths: readonly string[],
): AnalyzedCommandResult | undefined {
  const parsed = validateSafeFlags(args, FD_FLAG_SPEC);
  if (parsed === undefined) return undefined;
  const paths = [...basePaths];
  for (const [flag, value] of parsed.flagValues) {
    if (flag === '--search-path') paths.push(value);
  }
  if (parsed.positionals.length > 1) {
    paths.push(...parsed.positionals.slice(1));
  }
  return { paths, readsCwd: true, usesGit: false, isCd: false };
}

function analyzeGrep(
  args: readonly string[],
  basePaths: readonly string[],
): AnalyzedCommandResult | undefined {
  const parsed = validateSafeFlags(args, GREP_FLAG_SPEC);
  if (parsed === undefined) return undefined;
  const paths = [...basePaths];
  let patternSeen = parsed.seenFlags.has('-e') || parsed.seenFlags.has('--regexp');
  let recursive =
    parsed.seenFlags.has('-r') ||
    parsed.seenFlags.has('-R') ||
    parsed.seenFlags.has('--recursive') ||
    parsed.seenFlags.has('--dereference-recursive');
  for (const [flag, value] of parsed.flagValues) {
    if (flag === '-f' || flag === '--file') {
      patternSeen = true;
      paths.push(value);
    } else if (flag === '--exclude-from') {
      paths.push(value);
    } else if ((flag === '-d' || flag === '--directories') && value === 'recurse') {
      recursive = true;
    }
  }
  const targetPaths = patternSeen ? parsed.positionals : parsed.positionals.slice(1);
  paths.push(...targetPaths);
  return {
    paths,
    readsCwd: recursive && targetPaths.length === 0,
    usesGit: false,
    isCd: false,
  };
}

function analyzeUniq(
  args: readonly string[],
  basePaths: readonly string[],
): AnalyzedCommandResult | undefined {
  const inputs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const text = args[index]!;
    if (/^--(?:skip-chars|skip-fields|check-chars)$/.test(text)) {
      index++;
      if (index === args.length) return undefined;
    } else if (/^-[fsw]$/.test(text)) {
      index++;
      if (index === args.length || !/^\d+$/.test(args[index]!)) return undefined;
    } else if (text.startsWith('-')) {
      if (!/^-[a-zA-Z]+$/.test(text) && !/^--[a-zA-Z-]+(?:=\S+)?$/.test(text)) return undefined;
    } else {
      inputs.push(text);
    }
  }
  return inputs.length <= 1
    ? { paths: [...basePaths, ...inputs], readsCwd: false, usesGit: false, isCd: false }
    : undefined;
}

const DANGEROUS_LONG_OPTIONS: readonly string[] = [
  '--output',
  '--exclude',
  '--exclude-from',
  '--files0-from',
  '--from-file',
  '--to-file',
  '--compress-program',
  '--format-file',
];

function isDangerousLongOption(arg: string): boolean {
  if (!arg.startsWith('--') || arg.length <= 2) return false;
  const eqIndex = arg.indexOf('=');
  const name = eqIndex >= 0 ? arg.slice(0, eqIndex) : arg;
  return name.length >= 4 && DANGEROUS_LONG_OPTIONS.some((option) => option.startsWith(name));
}

function analyzeBasicFileCommand(
  name: string,
  operands: readonly string[],
  basePaths: readonly string[],
): string[] | undefined {
  if (name === 'strings' && operands.some((text) => text.startsWith('@'))) return undefined;
  if (name === 'hexdump' && operands.some((text) => /^-[^-]*f/.test(text))) {
    return undefined;
  }
  if (name === 'diff' && operands.some((text) => /^-[^-]*X/.test(text))) {
    return undefined;
  }
  if (
    name === 'tail' &&
    operands.some((text) => text === '--follow' || text.startsWith('--follow=') || /^-[^-]*[fF]/.test(text))
  ) {
    return undefined;
  }
  if (operands.some(isDangerousLongOption)) return undefined;
  const paths = [...basePaths];
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
      if ((name === 'head' || name === 'tail') && (text === '-n' || text === '-c')) index++;
      continue;
    }
    paths.push(text);
  }
  return paths;
}

function literalText(node: BashSyntaxNode): string | undefined {
  switch (node.type) {
    case 'word': {
      const raw = node.text;
      if (/\\\r?\n/.test(raw)) return undefined;
      if (WORD_UNSAFE_CHARS_RE.test(raw) || WORD_TILDE_EXPANSION_RE.test(raw)) return undefined;
      const text = raw.replaceAll(/\\(.)/gs, '$1');
      return WORD_UNSAFE_CHARS_RE.test(text) || WORD_TILDE_EXPANSION_RE.test(text) ? undefined : text;
    }
    case 'number':
      return node.text;
    case 'raw_string': {
      if (node.text.length < 2 || !node.text.startsWith("'") || !node.text.endsWith("'")) {
        return undefined;
      }
      return node.text.slice(1, -1);
    }
    case 'string': {
      let result = '';
      for (const child of node.children) {
        if (child.type === 'string_content') {
          if (/\\\r?\n/.test(child.text)) return undefined;
          result += child.text.replaceAll(/\\(["\\$`])/g, '$1');
        } else if (!child.isNamed && child.text === '$') {
          result += '$';
        } else if (!child.isNamed && child.text === '"') {
          continue;
        } else {
          return undefined;
        }
      }
      return result;
    }
    case 'concatenation': {
      const parts = node.children.map(literalText);
      return parts.every((part) => part !== undefined) ? parts.join('') : undefined;
    }
    default:
      return undefined;
  }
}
