import type { Component } from 'vue';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { normalizeToolName } from '@moonshot-ai/app-components';
import AgentTool from './AgentTool.vue';
import AskUserTool from './AskUserTool.vue';
import BashTool from './BashTool.vue';
import EditTool from './EditTool.vue';
import GenericTool from './GenericTool.vue';
import BrowserTool from './BrowserTool.vue';
import { isBrowserTool } from './browserToolPresentation';
import CronTool from './CronTool.vue';
import GlobTool from './GlobTool.vue';
import GoalTool from './GoalTool.vue';
import GrepTool from './GrepTool.vue';
import MediaTool from './MediaTool.vue';
import NotifyUserTool from './NotifyUserTool.vue';
import PlanTool from './PlanTool.vue';
import ReadTool from './ReadTool.vue';
import SkillTool from './SkillTool.vue';
import SwarmTool from './SwarmTool.vue';
import TodoTool from './TodoTool.vue';
import WaitForTool from './WaitForTool.vue';
import BackgroundTaskTool from './BackgroundTaskTool.vue';
import WebFetchTool from './WebFetchTool.vue';
import SelectToolsTool from './SelectToolsTool.vue';

type ToolRenderer = Component;

export function resolveToolRenderer(tool: ToolCall, options?: { notifyUserEnabled?: boolean }): ToolRenderer {
  if (isBrowserTool(tool)) return BrowserTool;
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
    case 'waitfor':
      return WaitForTool;
    case 'tasklist':
    case 'taskoutput':
    case 'taskstop':
      return BackgroundTaskTool;
    case 'croncreate':
    case 'cronlist':
    case 'crondelete':
      return CronTool;
    case 'notifyuser':
      return tool.status === 'error' || options?.notifyUserEnabled === false ? GenericTool : NotifyUserTool;
    case 'skill':
      return SkillTool;
    case 'select_tools':
      return SelectToolsTool;
    default:
      return GenericTool;
  }
}
