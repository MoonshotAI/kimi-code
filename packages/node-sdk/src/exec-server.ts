// Light entry for `kimi exec-server`: never import the SDK root (`#/index`) here,
// or the executor would load the full engine registration at startup.
export { runExecServer } from '@moonshot-ai/agent-core-v2/remote/server';
