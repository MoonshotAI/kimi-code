import type { ServiceRegistration } from '#/_base/di/test';
import type { TelemetryContextPatch, TelemetryProperties } from '#/app/telemetry/context';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { composeTelemetryProperties } from '#/app/telemetry/telemetryService';

export interface TelemetryRecord {
  readonly event: string;
  readonly properties?: TelemetryProperties;
}

export function recordingTelemetry(
  records: TelemetryRecord[],
  context: TelemetryProperties = {},
): ITelemetryService {
  let currentContext = context;
  const service: ITelemetryService = {
    _serviceBrand: undefined,
    track2: (event, properties) => {
      records.push({
        event,
        properties: composeTelemetryProperties(
          currentContext,
          properties as TelemetryProperties | undefined,
        ),
      });
    },
    withContext(patch: TelemetryContextPatch) {
      return recordingTelemetry(records, { ...currentContext, ...patch });
    },
    setContext(patch: TelemetryContextPatch) {
      currentContext = { ...currentContext, ...patch };
    },
    getContext: () => currentContext,
    createScopeBinding: (seed: TelemetryContextPatch) => ({
      telemetry: recordingTelemetry(records, { ...currentContext, ...seed }),
      dispose: () => {},
    }),
  };
  return service;
}

export function registerTelemetryServices(reg: ServiceRegistration): void {
  reg.definePartialInstance(ITelemetryService, {});
}
