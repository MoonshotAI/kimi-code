import { TODO_LIST_ENABLED_BY_DEFAULT } from './configSection';
import { TODO_LIST_TOOL_NAME } from './todoItem';

export interface TodoListOptInInput {
  readonly enabled?: boolean;
  readonly allowlist?: readonly string[];
  readonly profileTools?: readonly string[];
  readonly builtinTools?: readonly string[];
  readonly builtinSource: boolean;
}

export function isTodoListOptedIn(input: TodoListOptInInput): boolean {
  if (input.allowlist?.includes(TODO_LIST_TOOL_NAME) === true) return true;
  if (!input.builtinSource && namesTodoList(input.profileTools, input.builtinTools)) return true;
  return input.enabled ?? TODO_LIST_ENABLED_BY_DEFAULT;
}

function namesTodoList(
  tools: readonly string[] | undefined,
  builtinTools: readonly string[] | undefined,
): boolean {
  if (tools?.includes(TODO_LIST_TOOL_NAME) !== true) return false;
  if (builtinTools === undefined) return true;
  return tools.length !== builtinTools.length || tools.some((name) => !builtinTools.includes(name));
}
