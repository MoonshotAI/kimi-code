// apps/kimi-web/src/components/chat/tool-calls/toolRegistry.ts
import type { Component } from 'vue';
import type { ToolCall } from '../../../types';
import { normalizeToolName } from '../../../lib/toolMeta';
import AgentTool from './AgentTool.vue';
import EditTool from './EditTool.vue';
import GenericTool from './GenericTool.vue';
import MediaTool from './MediaTool.vue';

type ToolRenderer = Component;

/** Pick the renderer for a tool call. */
export function resolveToolRenderer(tool: ToolCall): ToolRenderer {
  if (tool.media && tool.status === 'ok') return MediaTool;
  const name = normalizeToolName(tool.name);
  if (name === 'edit' || name === 'write' || name === 'multi_edit') return EditTool;
  if (name === 'agent') return AgentTool;
  return GenericTool;
}
