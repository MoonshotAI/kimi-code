import { runExecServer } from './entry';

process.exitCode = await runExecServer({ version: '0.0.0-standalone' });
