/**
 * Rust engine integration surface — the SDK's engine-facing layer.
 *
 * The Rust agent engine (`@moonshot-ai/kimi-agent/rust-loop`) owns the loop,
 * context, goal driving, and persistence. This module packages the pieces a
 * host needs to drive a session-owned engine session through the SDK `Event`
 * union and approval seam, without touching the engine wire protocol.
 */
export {
  SessionEngineController,
  type SessionClientFactory,
  type SessionClientFactoryOptions,
  type SessionClientHandle,
  type SessionEngineControllerOptions,
  type SessionEngineStartOptions,
  type SessionPromptOutcome,
  type ToolApprovalRequest,
} from './controller';
export {
  RustRpcClient,
  type RustLoopApi,
  type RustRpcClientOptions,
} from './rpc-client';
export {
  mapBackgroundTask,
  mapContextMessage,
  mapCronTaskSnapshot,
  mapMcpServer,
  mapMcpStartupMetrics,
  mapPluginInfo,
  mapPluginSummary,
  mapSkill,
  mapStatus,
  mapUsage,
  nativeUnavailable,
  promptText,
} from './wire';
export type {
  EngineMcpServerInfo,
  EnginePluginInfo,
  EnginePluginSummary,
  EngineSessionRecord,
  EngineSessionStatus,
  EngineSessionUsage,
  EngineSessionWarning,
  EngineSkillSummary,
  EngineTaskInfo,
} from './wire';
