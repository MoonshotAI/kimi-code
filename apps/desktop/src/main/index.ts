// Electron main entry. The file logger + crash guards must be installed
// BEFORE loading the rest of the main process: a static `import './app'`
// would execute that module and its whole dependency tree (kap-server,
// agent-core, native modules) before any statement here runs, leaving
// load-time crashes with neither a log line nor the crash guard.
import { initMainLogging } from './log';

initMainLogging();

// Loaded dynamically so the import graph above stays minimal; a load-time
// failure in ./app rejects this promise and lands in the crash guard's
// unhandledRejection handler (logged + surfaced).
void import('./app').then(({ main }) => main());
