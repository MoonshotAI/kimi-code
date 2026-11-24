import { ConfigTarget, type IConfigService } from '#/app/config/config';

import { DEVICES_SECTION, LEGACY_HOSTS_SECTION, type DevicesSection } from './configSection';

export async function migrateLegacyHosts(config: IConfigService): Promise<boolean> {
  await config.ready;
  try {
    return await moveLegacyHosts(config);
  } catch {
    await config.reload();
    return moveLegacyHosts(config);
  }
}

async function moveLegacyHosts(config: IConfigService): Promise<boolean> {
  const legacy = config.inspect<DevicesSection | undefined>(LEGACY_HOSTS_SECTION).userValue;
  if (legacy === undefined) return false;
  const current = config.inspect<DevicesSection | undefined>(DEVICES_SECTION).userValue;
  await config.replaceSections(
    { [DEVICES_SECTION]: { ...legacy, ...current }, [LEGACY_HOSTS_SECTION]: null },
    ConfigTarget.User,
    { expectedValues: { [DEVICES_SECTION]: current ?? null, [LEGACY_HOSTS_SECTION]: legacy } },
  );
  return true;
}
