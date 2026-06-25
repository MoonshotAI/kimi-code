import { createDecorator } from '../../../di';
import type {
  TelemetryClient,
  TelemetryContextPatch,
  TelemetryProperties,
} from '../../../telemetry';

export interface TelemetryServiceOptions {
  readonly client?: TelemetryClient;
}

export interface ITelemetryService {
  track(event: string, properties?: TelemetryProperties): void;
  withContext(patch: TelemetryContextPatch): ITelemetryService;
  setContext(patch: TelemetryContextPatch): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ITelemetryService = createDecorator<ITelemetryService>(
  'agentTelemetryService',
);
