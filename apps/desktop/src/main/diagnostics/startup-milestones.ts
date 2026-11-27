import { logStartup, uptimeMs } from './log';
import { trackDesktopEvent } from './track';

const BOOT_STAGES = new Set(['auth', 'server', 'config', 'sessions', 'session']);

export type RendererMilestone =
  | { milestone: 'ui-mounted' }
  | { milestone: 'ui-ready' }
  | { milestone: 'boot-stage'; stage: string };

export function asRendererMilestone(value: unknown): RendererMilestone | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { milestone, stage } = value as Record<string, unknown>;
  if (milestone === 'ui-mounted' || milestone === 'ui-ready') return { milestone };
  if (milestone === 'boot-stage' && typeof stage === 'string' && BOOT_STAGES.has(stage)) {
    return { milestone, stage };
  }
  return null;
}

const reportedPhases = new Set<'ui_mounted' | 'ui_ready'>();

export function recordRendererMilestone(value: unknown): RendererMilestone | null {
  const parsed = asRendererMilestone(value);
  if (parsed === null) return null;
  if (parsed.milestone === 'boot-stage') {
    logStartup(`boot-${parsed.stage}`);
    return parsed;
  }
  logStartup(parsed.milestone);
  const phase = parsed.milestone === 'ui-mounted' ? 'ui_mounted' : 'ui_ready';
  if (!reportedPhases.has(phase)) {
    reportedPhases.add(phase);
    trackDesktopEvent('startup_timing', { phase, duration_ms: uptimeMs() });
  }
  return parsed;
}
