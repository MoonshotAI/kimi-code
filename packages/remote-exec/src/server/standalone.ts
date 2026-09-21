import { runExecServer } from './entry';

// Standalone executor bundle entry (tsdown.executor.config.ts). Accepts the
// stock `exec-server --listen stdio` argv shape so the ssh/docker launcher
// lowering can invoke this bundle as <remoteBin> unchanged.
process.exitCode = await runExecServer({ version: '0.0.0-standalone' });
