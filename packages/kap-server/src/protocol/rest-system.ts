import { z } from 'zod';

const ratioSchema = z.number().min(0).max(1);
const bytesSchema = z.number().nonnegative();

export const systemStatsQuerySchema = z.object({
  path: z.string().min(1).optional().describe('Report the file system that holds this absolute path; defaults to the home directory'),
});

export const systemGpuStatsSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  memory_total: bytesSchema.optional(),
  memory_used: bytesSchema.optional(),
  utilization: ratioSchema.optional(),
});

export const systemStatsSchema = z.object({
  cpu: z.object({
    usage: ratioSchema.optional().describe('Share of the available CPU time used since the previous request'),
    cores: z.number().positive().describe('CPU cores this server may use, after container and job limits'),
    limited: z.boolean().describe('True when a container or job limit sets the cores below the machine'),
  }),
  memory: z.object({
    total: bytesSchema,
    used: bytesSchema,
    limited: z.boolean().describe('True when a container or job memory limit replaces the machine total'),
  }),
  disk: z
    .object({ path: z.string(), total: bytesSchema, used: bytesSchema, available: bytesSchema })
    .optional()
    .describe('Omitted when the file system does not answer in time'),
  gpus: z.array(systemGpuStatsSchema).describe('NVIDIA GPUs visible to this server; empty without nvidia-smi'),
});

export type SystemStats = z.infer<typeof systemStatsSchema>;
export type SystemGpuStats = z.infer<typeof systemGpuStatsSchema>;
