import { readToolLifecycleMeta, type ToolDescription } from '#/llm/message';
import { log } from '#/utils/log';

import type { PassContext } from '../pipeline';
import type { LlmModule } from '../protocol';

export function legalizeTools<TOptions>(
  module: LlmModule<TOptions>,
  ctx: PassContext,
): LlmModule<TOptions> {
  const dynamic = module.model.spec.capability?.dynamically_loaded_tools === true;
  let changed = false;
  const normalize = (tool: ToolDescription): ToolDescription => {
    if (dynamic || tool.deferred !== true) return tool;
    changed = true;
    const { deferred: _deferred, ...description } = tool;
    return description;
  };
  const seen = new Map<string, string>();
  const duplicates = new Map<string, { kept: string; dropped: number }>();
  const drop = (name: string): void => {
    const kept = seen.get(name)!;
    duplicates.set(name, { kept, dropped: (duplicates.get(name)?.dropped ?? 0) + 1 });
    changed = true;
  };
  const tools: ToolDescription[] = [];
  const profileTools = module.profile.tools ?? [];
  for (let index = profileTools.length - 1; index >= 0; index -= 1) {
    const tool = normalize(profileTools[index]!);
    if (seen.has(tool.name)) {
      drop(tool.name);
      continue;
    }
    seen.set(tool.name, `profile.tools[${index}]`);
    tools.unshift(tool);
  }
  const messages = [...module.content.messages];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    for (const part of message.content) {
      const lifecycle = readToolLifecycleMeta(part);
      if (lifecycle === undefined) continue;
      for (const name of lifecycle.removed) seen.delete(name);
    }
    if (message.role !== 'system' || message.tools === undefined) continue;
    const kept: ToolDescription[] = [];
    let messageChanged = false;
    for (let toolIndex = message.tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const original = message.tools[toolIndex]!;
      const tool = normalize(original);
      if (tool !== original) messageChanged = true;
      if (seen.has(tool.name)) {
        drop(tool.name);
        messageChanged = true;
        continue;
      }
      seen.set(tool.name, `messages[${index}].tools[${toolIndex}]`);
      kept.unshift(tool);
    }
    if (kept.length === message.tools.length && !messageChanged) continue;
    messages[index] = { ...message, tools: kept };
    changed = true;
  }
  for (const [name, { kept, dropped }] of duplicates) {
    const message = `Dropped ${dropped} older duplicate declaration(s) for tool '${name}'; kept ${kept}.`;
    log.warn({ name, kept, dropped }, message);
    ctx.report({
      code: 'duplicate_tool_declaration',
      message,
      data: { name, kept, dropped },
    });
  }
  if (!changed) return module;
  return {
    ...module,
    profile: { ...module.profile, tools: module.profile.tools === undefined ? undefined : tools },
    content: { ...module.content, messages },
  };
}
