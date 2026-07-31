/**
 * tui-session.ts — the session contract the interactive TUI depends on.
 *
 * The TUI and its controllers/commands used to annotate `this.session` as the
 * SDK `Session` *concrete class*. That class carries private fields, so
 * TypeScript's structural rules forbid assigning any non-`Session` value to it
 * — which blocks swapping in a native-engine facade.
 *
 * `TuiSession` is derived with `Pick` from the concrete `Session`, so:
 *  - every member signature stays exactly in sync with the SDK (no drift), and
 *  - the derived type is a plain structural object type (no private brand), so
 *    the SDK `Session` satisfies it *and* an alternative implementation (the
 *    native-engine {@link NativeSession} facade) can satisfy it too.
 *
 * The member set below is the full surface the TUI, its controllers, and its
 * slash commands touch. Adding a new `session.<member>` call in the TUI means
 * adding the member here (the compiler enforces it once files annotate against
 * `TuiSession`).
 */
import type { Session } from '@moonshot-ai/kimi-code-sdk';

export type TuiSession = Pick<
  Session,
  // Identity / metadata
  | 'id'
  | 'workDir'
  | 'summary'
  // Events + reverse-RPC handlers
  | 'onEvent'
  | 'setApprovalHandler'
  | 'setQuestionHandler'
  // Resume / reload
  | 'getResumeState'
  | 'reloadSession'
  // Turn driving
  | 'prompt'
  | 'steer'
  | 'swarm'
  | 'cancel'
  // Shell
  | 'runShellCommand'
  | 'cancelShellCommand'
  // Session-level actions
  | 'init'
  | 'getSessionWarnings'
  | 'addAdditionalDir'
  | 'startBtw'
  // Runtime mode / config
  | 'setModel'
  | 'setThinking'
  | 'setPermission'
  | 'updateMetadata'
  | 'setPlanMode'
  | 'setSwarmMode'
  // Plan
  | 'getPlan'
  | 'clearPlan'
  // Context
  | 'compact'
  | 'cancelCompaction'
  | 'undoHistory'
  | 'clearContext'
  | 'importContext'
  | 'getContext'
  // Status / usage
  | 'getUsage'
  | 'getStatus'
  // Skills
  | 'listSkills'
  | 'activateSkill'
  // Plugin commands (model-facing)
  | 'listPluginCommands'
  | 'activatePluginCommand'
  // Goal lifecycle
  | 'createGoal'
  | 'getGoal'
  | 'pauseGoal'
  | 'resumeGoal'
  | 'cancelGoal'
  // Cron
  | 'getCronTasks'
  // MCP
  | 'listMcpServers'
  | 'getMcpStartupMetrics'
  | 'reconnectMcpServer'
  // Plugin management
  | 'listPlugins'
  | 'installPlugin'
  | 'setPluginEnabled'
  | 'setPluginMcpServerEnabled'
  | 'removePlugin'
  | 'reloadPlugins'
  | 'getPluginInfo'
  // Background tasks
  | 'listBackgroundTasks'
  | 'getBackgroundTaskOutput'
  | 'stopBackgroundTask'
  | 'detachBackgroundTask'
  | 'waitForBackgroundTasksOnPrint'
  | 'handlePrintMainTurnCompleted'
  // Lifecycle
  | 'close'
>;
