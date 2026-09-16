import { runExecServer } from './entry';

// Standalone executor bundle entry (tsdown.executor.config.ts). Accepts the
// stock `exec-server --listen stdio` argv shape so the ssh/docker launcher
// lowering can invoke this bundle as <remoteBin> unchanged.
function readVersion(): string {
  const argv = process.argv;
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === '--executor-version') {
      const value = argv[i + 1];
      if (value !== undefined && value.length > 0) return value;
    }
  }
  return process.env['EXEC_SERVER_VERSION'] ?? '0.0.0-standalone';
}

process.exitCode = await runExecServer({ version: readVersion() });
