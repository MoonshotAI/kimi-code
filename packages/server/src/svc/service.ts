

import { createLaunchdManager } from './launchd';
import { createSchtasksManager } from './schtasks';
import { createSystemdManager } from './systemd';
import { ServiceUnsupportedError, type ServiceManager } from './types';

export function resolveServiceManager(platform: NodeJS.Platform = process.platform): ServiceManager {
  switch (platform) {
    case 'darwin':
      return createLaunchdManager();
    case 'linux':
      return createSystemdManager();
    case 'win32':
      return createSchtasksManager();
    default:
      return createUnsupportedManager(platform);
  }
}


function createUnsupportedManager(platform: string): ServiceManager {
  const fail = (): never => {
    throw new ServiceUnsupportedError(platform);
  };
  return {
    install: async () => fail(),
    uninstall: async () => fail(),
    start: async () => fail(),
    stop: async () => fail(),
    restart: async () => fail(),
    status: async () => fail(),
  };
}
