import { z } from 'zod';

const towerMissionStatusSchema = z.enum([
  'planned',
  'active',
  'completed',
  'blocked',
  'paused',
  'merged',
  'abandoned',
]);

const towerMissionKindSchema = z.enum(['build', 'survey', 'artifact']);

export const towerMissionCountsSchema = z.object({
  planned: z.number(),
  active: z.number(),
  completed: z.number(),
  blocked: z.number(),
  paused: z.number(),
  merged: z.number(),
  abandoned: z.number(),
});
export type TowerMissionCounts = z.infer<typeof towerMissionCountsSchema>;

export const towerOpenMissionSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: towerMissionKindSchema,
  status: towerMissionStatusSchema,
  owner: z.string().optional(),
  branch: z.string(),
  scope: z.array(z.string()),
  tasks_done: z.number(),
  tasks_total: z.number(),
  blockers: z.number(),
  latest_note_preview: z.string().optional(),
  live_workers: z.number(),
});
export type TowerOpenMission = z.infer<typeof towerOpenMissionSchema>;

export const towerRecentClosedMissionSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['merged', 'abandoned']),
  closed_at: z.string().optional(),
});
export type TowerRecentClosedMission = z.infer<typeof towerRecentClosedMissionSchema>;

export const towerActivityEventSchema = z.object({
  at: z.string(),
  actor: z.string(),
  kind: z.string(),
  fields: z.record(z.string(), z.string()),
});
export type TowerActivityEvent = z.infer<typeof towerActivityEventSchema>;

export const towerProjectionResponseSchema = z.object({
  status: z.enum(['uninitialized', 'lost', 'off', 'active']),
  has_content: z.boolean(),
  base: z.string().optional(),
  mode: z.enum(['branch', 'pr']).optional(),
  recovered_at: z.string().optional(),
  mission_counts: towerMissionCountsSchema,
  workers_live: z.number(),
  reviewers_live: z.number(),
  roster_total: z.number(),
  open_missions: z.array(towerOpenMissionSchema),
  recent_closed: z.array(towerRecentClosedMissionSchema),
  events: z.array(towerActivityEventSchema),
  log_offset: z.number(),
});
export type TowerProjectionResponse = z.infer<typeof towerProjectionResponseSchema>;
