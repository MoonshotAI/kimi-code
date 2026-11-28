import { registerBrowserIpc } from './handlers/browserIpc';
import { registerReleaseIpc } from './handlers/releaseIpc';
import { registerSystemPermissionsIpc } from './handlers/systemPermissionsIpc';
import { registerSystemTerminalIpc } from './handlers/systemTerminalIpc';
import { registerWindowShellIpc } from './handlers/windowShellIpc';

export function registerIpcHandlers(): void {
  registerWindowShellIpc();
  registerReleaseIpc();
  registerSystemTerminalIpc();
  registerSystemPermissionsIpc();
  registerBrowserIpc();
}
