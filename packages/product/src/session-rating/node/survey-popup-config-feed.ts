import type { ClientConfigClient, ClientConfigFetchOptions } from '#/client-configs/node/client-configs';

import {
  surveyPopupConfigSchema,
  withDefaults,
  type SurveyPopupPayload,
} from '../common/survey-popup-config';

const CONFIG_NAME = 'survey_popup';

export async function getSurveyPopupConfig(
  client: SurveyPopupConfigClient,
  options: ClientConfigFetchOptions = {},
): Promise<SurveyPopupPayload> {
  return withDefaults(await client.get(CONFIG_NAME, surveyPopupConfigSchema, options));
}

export function peekSurveyPopupConfig(
  client: SurveyPopupConfigClient,
  now?: number,
): SurveyPopupPayload {
  return withDefaults(client.peek(CONFIG_NAME, surveyPopupConfigSchema, now));
}

export function isSurveyPopupConfigFresh(client: SurveyPopupConfigClient, now?: number): boolean {
  return client.peek(CONFIG_NAME, surveyPopupConfigSchema, now) !== undefined;
}

export function resetSurveyPopupConfigCache(client: SurveyPopupConfigClient): void {
  client.reset(CONFIG_NAME);
}

export const SURVEY_POPUP_CONFIG_REFRESH_INTERVAL_MS = 3_600_000;

export interface SurveyPopupConfigFeedDeps {
  readonly peek: () => SurveyPopupPayload;
  readonly isFresh: () => boolean;
  readonly region: () => string;
  readonly refresh?: () => unknown;
  readonly now?: () => number;
}

export class SurveyPopupConfigFeed {
  private ready = false;
  private refreshedAt = 0;
  private coldRefreshAttemptedAt = 0;
  private refreshedRegion: string | undefined;

  constructor(private readonly deps: SurveyPopupConfigFeedDeps) {
    this.refresh();
    this.coldRefreshAttemptedAt = this.now();
  }

  payload(): SurveyPopupPayload {
    return this.deps.peek();
  }

  readyForEvaluation(): boolean {
    if (!this.ready) return false;
    const now = this.now();
    if (
      !this.deps.isFresh() &&
      now - this.coldRefreshAttemptedAt >= SURVEY_POPUP_CONFIG_REFRESH_INTERVAL_MS
    ) {
      this.coldRefreshAttemptedAt = now;
      return !this.refresh();
    }
    if (
      this.deps.region() !== this.refreshedRegion ||
      now - this.refreshedAt >= SURVEY_POPUP_CONFIG_REFRESH_INTERVAL_MS
    ) {
      return !this.refresh();
    }
    return true;
  }

  private refresh(): boolean {
    this.refreshedAt = this.now();
    this.refreshedRegion = this.deps.region();
    const refresh = this.deps.refresh;
    if (refresh === undefined) {
      this.ready = true;
      return false;
    }
    this.ready = false;
    void new Promise((resolve) => {
      resolve(refresh());
    })
      .catch(() => undefined)
      .finally(() => {
        this.ready = true;
      });
    return true;
  }

  private now(): number {
    return (this.deps.now ?? (() => performance.now()))();
  }
}

export type SurveyPopupConfigClient = Pick<ClientConfigClient, 'get' | 'peek' | 'region' | 'reset'>;

export function cloudSurveyPopupConfigFeed(
  client: SurveyPopupConfigClient,
  accessToken: (() => Promise<string | undefined>) | undefined,
): SurveyPopupConfigFeed {
  return new SurveyPopupConfigFeed({
    peek: () => peekSurveyPopupConfig(client),
    isFresh: () => isSurveyPopupConfigFresh(client),
    region: () => client.region(),
    refresh:
      accessToken === undefined
        ? undefined
        : async () => {
            const token = await accessToken();
            await getSurveyPopupConfig(client, { accessToken: token });
          },
  });
}
