export const CHANGE_ENVIRONMENT_TOOL_NAME = 'change_environment';
export const CONNECT_ENVIRONMENT_TOOL_NAME = 'connect';

export const ENVIRONMENT_TOOLS_MAIN_AGENT_ONLY =
  'Environment switching tools are only supported by the main agent.';

export const ENVIRONMENT_TOOLS_PLAN_MODE_UNAVAILABLE =
  'Environment switching is not available in plan mode. Call ExitPlanMode to exit plan mode before switching environments.';

export const ENVIRONMENT_SWITCH_TOOL_NAMES: readonly string[] = [
  CHANGE_ENVIRONMENT_TOOL_NAME,
  CONNECT_ENVIRONMENT_TOOL_NAME,
];
