// Desktop host identity — resolved ONCE here and consumed by every channel:
// the embedded server (kap-server derives the outbound User-Agent + X-Msh-*
// headers and the bootstrap client identity from it), and telemetry (deviceId).
// Nothing HTTP-shaped is produced here; headers are derived downstream.

import { app } from 'electron';

import { createKimiDeviceId, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { DESKTOP_MSH_PLATFORM, DESKTOP_PRODUCT_NAME } from '../shared/identity';

export interface DesktopHostIdentity {
  /** Transport identity: product token, app version, X-Msh-Platform value. */
  readonly identity: KimiHostIdentity;
  /** Stable per-device id from `<home>/device_id` (minted on first call). */
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
