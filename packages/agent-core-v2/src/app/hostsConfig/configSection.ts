import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const HOSTS_SECTION = 'hosts';

const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const hostEntrySchema = z
  .object({
    host: z.string().min(1).refine((value) => !value.startsWith('-'), 'host must not start with "-"'),
    name: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
    identityFile: z.string().min(1).optional(),
    remoteBin: z.string().min(1).optional(),
  })
  .strict();

export type HostEntry = z.infer<typeof hostEntrySchema>;

export interface HostsSection {
  [id: string]: HostEntry;
}

export const hostIdSchema = z
  .string()
  .regex(HOST_ID_PATTERN, 'host id must be 1-64 letters, digits, ".", "_" or "-"');

export const hostsSectionSchema: z.ZodType<HostsSection> = z.record(
  hostIdSchema,
  hostEntrySchema,
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

registerConfigSection(HOSTS_SECTION, hostsSectionSchema, {
  fromToml: (raw) => mapEntries(raw, true),
  toToml: (value) => mapEntries(value, false),
});
