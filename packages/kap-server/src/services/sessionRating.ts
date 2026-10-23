import { IBootstrapService, type Scope } from '@moonshot-ai/agent-core-v2';
import { SESSION_RATING_PREVIEW_ENV, SessionRatingHost } from '@moonshot-ai/kimi-code-product/session-rating/node';
import type { ServerLogger } from './pinoLoggerService';
import { isEnvFlagEnabled, isServerTelemetryDisabled } from './telemetry';

export interface ServerSessionRatingOptions {
  readonly debugEndpoints: boolean;
  readonly logger: ServerLogger;
}

export function createServerSessionRating(
  core: Scope,
  options: ServerSessionRatingOptions,
): SessionRatingHost {
  const previewRequested = isEnvFlagEnabled(
    core.accessor.get(IBootstrapService).getEnv(SESSION_RATING_PREVIEW_ENV),
  );
  return new SessionRatingHost(core, {
    preview: options.debugEndpoints && previewRequested,
    telemetryDisabled: () => isServerTelemetryDisabled(core),
    log: (message, properties) => {
      options.logger.info(properties, message);
    },
  });
}
