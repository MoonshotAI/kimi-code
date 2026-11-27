import { registerBrowserIpc } from './handlers/browserIpc';
import { registerReleaseIpc } from './handlers/releaseIpc';
import { registerSystemTerminalIpc } from './handlers/systemTerminalIpc';
import { registerWindowShellIpc } from './handlers/windowShellIpc';

export function registerIpcHandlers(): void {
  registerWindowShellIpc();
  registerReleaseIpc();
  registerSystemTerminalIpc();
  registerBrowserIpc();
}
