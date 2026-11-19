
import { app } from 'electron';

import { isCanaryChannelEnabled, isCanaryDisplay, isCanaryVersion } from './release-channel';

export interface CanaryInfo {
  enabled: boolean;
  isCanaryBuild: boolean;
  isRealCanaryBuild: boolean;
}

export async function getCanaryInfo(): Promise<CanaryInfo> {
  return {
    enabled: isCanaryChannelEnabled(app.getVersion(), app.isPackaged),
    isCanaryBuild: isCanaryDisplay(app.getVersion(), app.isPackaged),
    isRealCanaryBuild: isCanaryVersion(app.getVersion()),
  };
}
