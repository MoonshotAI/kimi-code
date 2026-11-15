import type { SurveyEventName, SurveyEventProperties } from './event-properties';
import type { RatingReport, RatingTrackContext } from '../common/types';

export const RATING_REPORT_RETENTION_MS = 10 * 60 * 1000;
export const RATING_REPORT_CAPACITY = 1024;

export type RatingTracker = (
  event: SurveyEventName,
  properties: SurveyEventProperties,
  context: RatingTrackContext,
) => void;

export interface RatingRegistration {
  readonly mount: symbol;
  readonly event: SurveyEventName;
  readonly properties: SurveyEventProperties;
  readonly context: RatingTrackContext;
  readonly track: RatingTracker;
}

interface Entry {
  readonly registration: RatingRegistration;
  shown: boolean;
  expiresAt: number;
  detachedAt?: number;
}

export class SessionRatingLedger {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly deps: {
      readonly telemetryDisabled: () => boolean;
      readonly now?: () => number;
    },
  ) {}

  register(registration: RatingRegistration): void {
    this.prune();
    this.entries.set(registration.properties.appearance_id, {
      registration,
      shown: false,
      expiresAt: this.now() + RATING_REPORT_RETENTION_MS,
    });
    if (this.entries.size > RATING_REPORT_CAPACITY) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  report(sessionId: string, report: RatingReport): void {
    this.prune();
    const entry = this.entries.get(report.appearanceId);
    if (entry === undefined || entry.registration.context.sessionId !== sessionId) return;
    if (this.deps.telemetryDisabled()) {
      this.entries.delete(report.appearanceId);
      return;
    }
    const wasShown = entry.shown;
    if (report.type === 'shown') {
      if (wasShown) return;
      entry.shown = true;
      entry.expiresAt = entry.detachedAt === undefined
        ? Infinity
        : entry.detachedAt + RATING_REPORT_RETENTION_MS;
    } else {
      this.entries.delete(report.appearanceId);
    }
    if (!wasShown) this.track(entry, { ...entry.registration.properties, event_type: 'appeared' });
    if (report.type === 'shown') return;
    this.track(entry, {
      ...entry.registration.properties,
      event_type: report.type === 'respond' ? 'responded' : 'abandoned',
      response: report.type === 'respond' ? report.response : undefined,
    });
  }

  detach(mount: symbol): void {
    this.prune();
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.registration.mount !== mount || entry.detachedAt !== undefined) continue;
      entry.detachedAt = now;
      entry.expiresAt = Math.min(entry.expiresAt, now + RATING_REPORT_RETENTION_MS);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private track(entry: Entry, properties: SurveyEventProperties): void {
    try {
      const { event, context, track } = entry.registration;
      track(event, properties, context);
    } catch {}
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))();
  }
}
