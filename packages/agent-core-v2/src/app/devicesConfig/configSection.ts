import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const DEVICES_SECTION = 'devices';

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const deviceEntrySchema = z
  .object({
    host: z.string().min(1).refine((value) => !value.startsWith('-'), 'host must not start with "-"'),
    name: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
    identityFile: z.string().min(1).optional(),
    remoteBin: z.string().min(1).optional(),
  })
  .strict();

export type DeviceEntry = z.infer<typeof deviceEntrySchema>;

export interface DevicesSection {
  [id: string]: DeviceEntry;
}

export const deviceIdSchema = z
  .string()
  .regex(DEVICE_ID_PATTERN, 'device id must be 1-64 letters, digits, ".", "_" or "-"');

export const devicesSectionSchema: z.ZodType<DevicesSection> = z.record(
  deviceIdSchema,
  deviceEntrySchema,
);

const TOML_FIELDS = [
  ['identity_file', 'identityFile'],
  ['remote_bin', 'remoteBin'],
] as const;

function mapEntries(section: unknown, fromToml: boolean): unknown {
  if (typeof section !== 'object' || section === null) return section;
  return Object.fromEntries(
    Object.entries(section).map(([id, entry]) => {
      if (typeof entry !== 'object' || entry === null) return [id, entry];
      const mapped = { ...entry } as Record<string, unknown>;
      for (const [toml, config] of TOML_FIELDS) {
        const from = fromToml ? toml : config;
        if (from in mapped) {
          mapped[fromToml ? config : toml] = mapped[from];
          delete mapped[from];
        }
      }
      return [id, mapped];
    }),
  );
}

registerConfigSection(DEVICES_SECTION, devicesSectionSchema, {
  fromToml: (raw) => mapEntries(raw, true),
  toToml: (value) => mapEntries(value, false),
});
