// apps/kimi-web/src/components/chat/tool-calls/toolRegistry.ts
import type { Component } from 'vue';
import type { ToolCall } from '../../../types';
import { normalizeToolName } from '../../../lib/toolMeta';
import AgentTool from './AgentTool.vue';
import AskUserTool from './AskUserTool.vue';
import BashTool from './BashTool.vue';
import EditTool from './EditTool.vue';
import GenericTool from './GenericTool.vue';
import GlobTool from './GlobTool.vue';
import GoalTool from './GoalTool.vue';
import GrepTool from './GrepTool.vue';
import MediaTool from './MediaTool.vue';
import PlanTool from './PlanTool.vue';
import ReadTool from './ReadTool.vue';
import SwarmTool from './SwarmTool.vue';
import TodoTool from './TodoTool.vue';
import WebFetchTool from './WebFetchTool.vue';

type ToolRenderer = Component;

/** Pick the bespoke renderer for a tool call. Every common tool kind has its
    own line design; anything unrecognized falls back to GenericTool. */
export function resolveToolRenderer(tool: ToolCall): ToolRenderer {
  if (tool.media && tool.status === 'ok') return MediaTool;
  switch (normalizeToolName(tool.name)) {
    case 'bash':
      return BashTool;
    case 'read':
      return ReadTool;
    case 'edit':
    case 'write':
    case 'multi_edit':
      return EditTool;
    case 'grep':
    case 'search':
      return GrepTool;
    case 'glob':
    case 'ls':
      return GlobTool;
    case 'web_fetch':
      return WebFetchTool;
    case 'todo':
      return TodoTool;
    // NOTE: normalizeToolName() folds `agent`/`subagent` into the canonical
    // `task` kind (see lib/toolMeta.ts NAME_ALIASES), so the match must be on
    // `task` — `agent` here would be dead code and route subagent calls to
    // GenericTool, dropping the inline "Open" button for the detail panel.
    case 'task':
      return AgentTool;
    case 'agentswarm':
      return SwarmTool;
    case 'askuserquestion':
      return AskUserTool;
    case 'exitplanmode':
      return PlanTool;
    case 'creategoal':
    case 'getgoal':
    case 'setgoalbudget':
    case 'updategoal':
      return GoalTool;
    default:
      return GenericTool;
  }
}
