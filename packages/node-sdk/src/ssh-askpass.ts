// Light entry for the SSH askpass helper: like `./exec-server`, never import the
// SDK root (`#/index`) here — the CLI process entry loads this statically.
export { isSshAskpassEnvironment, runSshAskpass } from '@moonshot-ai/agent-core-v2/remote/askpass';
