
import { app } from 'electron';

import { createKimiDeviceId, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { DESKTOP_MSH_PLATFORM, DESKTOP_PRODUCT_NAME } from '../../shared/identity';

export interface DesktopHostIdentity {
  readonly identity: KimiHostIdentity;
  readonly deviceId: string;
}

export function resolveDesktopHostIdentity(homeDir: string): DesktopHostIdentity {
  return {
    identity: {
      productName: DESKTOP_PRODUCT_NAME,
      version: app.getVersion(),
      platform: DESKTOP_MSH_PLATFORM,
    },
    deviceId: createKimiDeviceId(homeDir),
  };
}
