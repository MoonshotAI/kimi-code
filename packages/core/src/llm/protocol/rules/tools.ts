import { scanToolDeclarations, type ToolDescription } from '#/llm/message';
import { log } from '#/utils/log';

import type { PassContext } from '../pipeline';
import type { LlmModule } from '../protocol';

export function legalizeTools<TOptions>(
  module: LlmModule<TOptions>,
  ctx: PassContext,
): LlmModule<TOptions> {
  const dynamic = module.model.spec.capability?.dynamically_loaded_tools === true;
  const profileTools = module.profile.tools ?? [];
  const scan = scanToolDeclarations(profileTools, module.content.messages);
  let changed = scan.droppedProfileIndexes.size > 0;
  const normalize = (tool: ToolDescription): ToolDescription => {
    if (dynamic || tool.deferred !== true) return tool;
    changed = true;
    const { deferred: _deferred, ...description } = tool;
    return description;
  };
  const tools: ToolDescription[] = [];
  for (let index = 0; index < profileTools.length; index += 1) {
    if (scan.droppedProfileIndexes.has(index)) continue;
    tools.push(normalize(profileTools[index]!));
  }
  const messages = [...module.content.messages];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'system' || message.tools === undefined) continue;
    const dropped = scan.droppedMessageToolIndexes.get(index);
    const kept: ToolDescription[] = [];
    let messageChanged = false;
    for (let toolIndex = 0; toolIndex < message.tools.length; toolIndex += 1) {
      if (dropped?.has(toolIndex) === true) {
        messageChanged = true;
        continue;
      }
      const original = message.tools[toolIndex]!;
      const tool = normalize(original);
      if (tool !== original) messageChanged = true;
      kept.push(tool);
    }
    if (!messageChanged) continue;
    messages[index] = { ...message, tools: kept };
    changed = true;
  }
  for (const [name, { kept, dropped }] of scan.duplicates) {
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
