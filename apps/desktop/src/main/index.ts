// Electron main entry. The file logger + crash guards must be installed
// BEFORE loading the rest of the main process: a static `import './app'`
// would execute that module and its whole dependency tree (kap-server,
// agent-core, native modules) before any statement here runs, leaving
// load-time crashes with neither a log line nor the crash guard.
import { app } from 'electron';

import { initMainLogging } from './log';
import { registerRendererScheme } from './protocol';
import { startShellEnvProbe } from './shell-env';

initMainLogging();
// registerSchemesAsPrivileged is a no-op once Electron is ready, so this
// cannot wait for the async work below. protocol.ts's import graph is just
// electron + node builtins, safe to load here.
registerRendererScheme();

// Warm up the shell env probe in parallel with the module load below;
// connect.ts awaits it before starting the embedded server.
void startShellEnvProbe();

// Linux Wayland sessions: globalShortcut only reaches the app through the
// XDG GlobalShortcuts portal, which Electron wires up via this feature
// switch. Must be appended before the app is ready; X11 and other platforms
// are unaffected.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}

// Loaded dynamically so the import graph above stays minimal; a load-time
// failure in ./app rejects this promise and lands in the crash guard's
// unhandledRejection handler (logged + surfaced).
void import('./app').then(({ main }) => main());
