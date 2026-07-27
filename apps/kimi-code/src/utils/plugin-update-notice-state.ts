import { z } from 'zod';

import { getPluginUpdateNoticeStateFile } from '#/utils/paths';
import { readJsonFile, writeJsonFile } from '#/utils/persistence';

/**
 * Records, per plugin, the newest marketplace version an update notice was
 * already shown for. A plugin is re-notified only when the marketplace
 * advertises a version different from the recorded one.
 */
export type PluginUpdateNoticeState = {
  version: 1;
  /** pluginId -> latest marketplace version already notified. */
  notified: Record<string, string>;
};

const PluginUpdateNoticeStateSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null) return value;
    const notified = (value as { notified?: unknown }).notified;
    if (typeof notified !== 'object' || notified === null) {
      return { ...(value as Record<string, unknown>), notified: {} };
    }

    const normalizedNotified: Record<string, string> = {};
    for (const [key, record] of Object.entries(notified)) {
      if (key.length === 0 || typeof record !== 'string' || record.length === 0) continue;
      normalizedNotified[key] = record;
    }

    return { ...(value as Record<string, unknown>), notified: normalizedNotified };
  },
  z
    .object({
      version: z.literal(1),
      notified: z.record(z.string().min(1), z.string().min(1)),
    })
    .strict(),
);

export function emptyPluginUpdateNoticeState(): PluginUpdateNoticeState {
  return {
    version: 1,
    notified: {},
  };
}

export async function readPluginUpdateNoticeState(
  filePath: string = getPluginUpdateNoticeStateFile(),
): Promise<PluginUpdateNoticeState> {
  try {
    return await readJsonFile(
      filePath,
      PluginUpdateNoticeStateSchema,
      emptyPluginUpdateNoticeState(),
    );
  } catch {
    return emptyPluginUpdateNoticeState();
  }
}

export async function writePluginUpdateNoticeState(
  value: PluginUpdateNoticeState,
  filePath: string = getPluginUpdateNoticeStateFile(),
): Promise<void> {
  await writeJsonFile(filePath, PluginUpdateNoticeStateSchema, value);
}
