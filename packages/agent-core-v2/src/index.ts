// agent-core-v2 public surface.
//
// Re-exports every domain barrel so that importing the package loads all
// scoped-registry registrations (each domain self-registers at the bottom of
// its impl file). Domains are grouped by layer; see plan/PLAN.md §3.

// L0 — base infrastructure (DI Scope foundation)
export * from './_base/di/index';

// L1 — abstraction bridges
export * from './log/index';
export * from './telemetry/index';
export * from './environment/index';
export * from './kaos/index';
export * from './kosong/index';

// L2 — data
export * from './records/index';
export * from './config/index';

// L3 — registries
export * from './tool/index';
export * from './skill/index';
export * from './permission/index';

// L4 — agent behaviour
export * from './context/index';
export * from './message/index';
export * from './turn/index';
export * from './injection/index';
export * from './compaction/index';
export * from './plan/index';
export * from './goal/index';
export * from './swarm/index';
export * from './usage/index';
export * from './tooldedup/index';

// L5 — async lifecycle
export * from './background/index';
export * from './cron/index';
export * from './mcp/index';

// L6 — coordination
export * from './agent-lifecycle/index';
export * from './session-context/index';
export * from './session-activity/index';
export * from './session/index';
export * from './hooks/index';

// L7 — boundary
export * from './event/index';
export * from './approval/index';
export * from './question/index';
export * from './gateway/index';

// cross-cutting capabilities
export * from './terminal/index';
export * from './fs/index';
export * from './workspace/index';
export * from './filestore/index';
export * from './auth/index';
