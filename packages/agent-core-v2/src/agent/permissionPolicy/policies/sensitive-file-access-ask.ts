import {
  IBashParserService,
  type BashSyntaxNode,
  normalizeBashCommandName,
} from '#/app/bashParser/bashParser';
import { IConfigService } from '#/app/config/config';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { isDangerousCommandGuardEnabled } from '#/agent/permissionRules/configSection';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { isSensitiveFile } from '#/tool/path-access';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { fileAccesses } from './path-utils';

const PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

const DYNAMIC_OPERAND = /[$`*?[\]{}]/;

const SKIPPED_COMMAND_CHILDREN: ReadonlySet<string> = new Set([
  'variable_assignment',
  'file_redirect',
  'heredoc_redirect',
  'herestring_redirect',
]);

const NON_FILE_OPERAND_COMMANDS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'export',
  'readonly',
  'local',
  'declare',
  'typeset',
]);

const PATTERN_FIRST_COMMANDS: ReadonlySet<string> = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'awk',
  'gawk',
  'jq',
  'fd',
  'fdfind',
]);

const PATTERN_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-e',
  '--regexp',
  '--expression',
  '-g',
  '--glob',
  '--iglob',
]);

const SCRIPT_FILE_OPTIONS: ReadonlySet<string> = new Set([
  '-f',
  '--file',
  '--from-file',
  '--files',
]);

const FILE_REDIRECT_OPERATORS: ReadonlySet<string> = new Set([
  '<',
  '>',
  '>>',
  '<>',
  '>|',
  '&>',
  '&>>',
]);

export class SensitiveFileAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'sensitive-file-access-ask';

  constructor(
    @IBashParserService private readonly bashParser: IBashParserService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IConfigService private readonly config: IConfigService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (!isDangerousCommandGuardEnabled(this.config)) return undefined;
    const access = fileAccesses(context).find((fileAccess) => isSensitiveFile(fileAccess.path));
    if (access !== undefined) return { kind: 'ask' };
    if (this.modeService.mode !== 'yolo') return undefined;
    if (context.toolCall.name !== 'Bash') return undefined;
    if (typeof context.args !== 'object' || context.args === null) return undefined;
    const command = (context.args as { readonly command?: unknown }).command;
    if (typeof command !== 'string' || command.length === 0) return undefined;
    const parsed = this.bashParser.parse(command, PARSE_OPTIONS);
    if (!parsed.ok || parsed.hasError) return undefined;
    return hasSensitiveBashPath(parsed.root) ? { kind: 'ask' } : undefined;
  }
}

function hasSensitiveBashPath(root: BashSyntaxNode): boolean {
  const stack: BashSyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'file_redirect' && hasSensitiveRedirect(node)) return true;
    if (node.type === 'command' && hasSensitiveCommand(node)) return true;
    for (const child of node.children) stack.push(child);
  }
  return false;
}

function hasSensitiveRedirect(node: BashSyntaxNode): boolean {
  const operatorIndex = node.children.findIndex((child) => !child.isNamed);
  const operator = node.children[operatorIndex]?.text;
  const target = node.children[operatorIndex + 1];
  if (target !== undefined && isFileRedirectTarget(operator, target)) {
    if (isSensitiveOperand(target)) return true;
  }
  return node.children.slice(operatorIndex + 2).some((child) => isSensitiveOperand(child));
}

function isFileRedirectTarget(operator: string | undefined, target: BashSyntaxNode): boolean {
  if (operator === undefined) return false;
  if (FILE_REDIRECT_OPERATORS.has(operator)) return true;
  return (operator === '>&' || operator === '<&') && target.type !== 'number';
}

function hasSensitiveCommand(node: BashSyntaxNode): boolean {
  const nameIndex = node.children.findIndex((child) => child.type === 'command_name');
  if (nameIndex < 0) return false;
  const nameNode = node.children[nameIndex]!;
  const nameWord = nameNode.children.length === 1 ? nameNode.children[0] : undefined;
  const rawName = nameWord === undefined ? undefined : literalOperand(nameWord);
  if (rawName === undefined || rawName.length === 0) return false;
  const name = normalizeBashCommandName(rawName);
  if (NON_FILE_OPERAND_COMMANDS.has(name)) return false;
  const args = node.children
    .slice(nameIndex + 1)
    .filter((child) => child.isNamed && !SKIPPED_COMMAND_CHILDREN.has(child.type));
  if (name === 'find') {
    for (const arg of args) {
      if (arg.text.startsWith('-') || arg.text === '!' || arg.text === '(' || arg.text === ')') {
        break;
      }
      if (isSensitiveOperand(arg)) return true;
    }
    return false;
  }
  if (!PATTERN_FIRST_COMMANDS.has(name)) {
    return args.some((arg) => isSensitiveOperand(arg, name === 'dd'));
  }
  let patternProvided = false;
  let positionalSeen = false;
  let skipNext = false;
  let optionsEnded = false;
  for (const arg of args) {
    const literal = literalOperand(arg);
    if (!optionsEnded && literal === '--') {
      optionsEnded = true;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!optionsEnded && literal !== undefined && literal.startsWith('-') && literal !== '-') {
      if ((literal.startsWith('--file=') || literal.startsWith('--from-file=')) && isSensitiveOperand(arg)) {
        return true;
      }
      if (PATTERN_VALUE_OPTIONS.has(literal)) {
        skipNext = true;
        if (literal !== '-g' && literal !== '--glob' && literal !== '--iglob') {
          patternProvided = true;
        }
      } else if (
        SCRIPT_FILE_OPTIONS.has(literal) ||
        literal.startsWith('--regexp=') ||
        literal.startsWith('--expression=') ||
        (name !== 'fd' && name !== 'fdfind' && /^-[a-zA-Z]*e/.test(literal))
      ) {
        patternProvided = true;
        if (name !== 'fd' && name !== 'fdfind' && /^-[a-zA-Z]*e$/.test(literal)) {
          skipNext = true;
        }
      }
      continue;
    }
    if (!patternProvided && !positionalSeen) {
      positionalSeen = true;
      continue;
    }
    if (isSensitiveOperand(arg)) return true;
  }
  return false;
}

function isSensitiveOperand(node: BashSyntaxNode, allowBareAssignment = false): boolean {
  if (node.type === 'word' && isSensitiveFile(node.text)) return true;
  const literal = literalOperand(node);
  if (literal === undefined || literal.length === 0) return false;
  if (isSensitiveFile(literal)) return true;
  const eq = literal.indexOf('=');
  if (eq <= 0) return false;
  return (literal.startsWith('--') || allowBareAssignment) && isSensitiveFile(literal.slice(eq + 1));
}

function literalOperand(node: BashSyntaxNode): string | undefined {
  if (node.type === 'word') {
    if (DYNAMIC_OPERAND.test(node.text) || /\\\r?\n/.test(node.text)) return undefined;
    const text = node.text.replaceAll(/\\(.)/gs, '$1');
    return DYNAMIC_OPERAND.test(text) ? undefined : text;
  }
  if (node.type === 'raw_string') {
    if (node.text.length < 2 || !node.text.startsWith("'") || !node.text.endsWith("'")) {
      return undefined;
    }
    return node.text.slice(1, -1);
  }
  if (node.type === 'string') {
    let text = '';
    for (const child of node.children) {
      if (child.type === 'string_content') {
        if (/\\\r?\n/.test(child.text)) return undefined;
        text += child.text.replaceAll(/\\(["\\$`])/g, '$1');
      } else if (child.isNamed) {
        return undefined;
      }
    }
    return text;
  }
  if (node.type === 'concatenation') {
    let text = '';
    for (const child of node.children) {
      const part = literalOperand(child);
      if (part === undefined) return undefined;
      text += part;
    }
    return text;
  }
  return undefined;
}
