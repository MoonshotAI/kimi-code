import { registerConfigSection, registerFlagDefinition } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

export const HOSTS_SECTION = 'hosts';
export const SSH_FULL_REMOTE_FLAG_ID = 'ssh_full_remote';

registerFlagDefinition({
  id: SSH_FULL_REMOTE_FLAG_ID,
  title: 'SSH Full-Remote',
  description: 'Run a complete kap-server on SSH hosts and reach it through an SSH tunnel.',
  env: 'KIMI_CODE_EXPERIMENTAL_SSH_FULL_REMOTE',
  default: false,
  surface: 'both',
});

const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const hostEntrySchema = z
  .object({
    host: z.string().min(1).refine((value) => !value.startsWith('-'), 'host must not start with "-"'),
    identityFile: z.string().min(1).optional(),
    remoteBin: z.string().min(1).optional(),
    name: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type HostEntry = z.infer<typeof hostEntrySchema>;

export const hostsSectionSchema = z.record(
  z.string().regex(HOST_ID_PATTERN, 'host id must be 1-64 letters, digits, ".", "_" or "-"'),
  hostEntrySchema,
);

export type HostsSection = z.infer<typeof hostsSectionSchema>;

export function isValidHostId(id: string): boolean {
  return HOST_ID_PATTERN.test(id);
}

const TOML_FIELDS: readonly (readonly [string, string])[] = [
  ['identity_file', 'identityFile'],
  ['remote_bin', 'remoteBin'],
];

function mapEntries(section: unknown, from: 0 | 1): unknown {
  if (typeof section !== 'object' || section === null) return section;
  const to = from === 0 ? 1 : 0;
  return Object.fromEntries(
    Object.entries(section).map(([id, entry]) => {
      if (typeof entry !== 'object' || entry === null) return [id, entry];
      const mapped: Record<string, unknown> = { ...entry };
      for (const field of TOML_FIELDS) {
        if (field[from] in mapped) {
          mapped[field[to]] = mapped[field[from]];
          delete mapped[field[from]];
        }
      }
      return [id, mapped];
    }),
  );
}

registerConfigSection(HOSTS_SECTION, hostsSectionSchema, {
  fromToml: (raw) => mapEntries(raw, 0),
  toToml: (value) => mapEntries(value, 1),
});
