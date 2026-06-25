import { registerSingleton, SyncDescriptor } from '../../../di';
import {
  noopTelemetryClient,
  withTelemetryContext,
  type TelemetryClient,
  type TelemetryContextPatch,
  type TelemetryProperties,
} from '../../../telemetry';
import {
  ITelemetryService,
  type TelemetryServiceOptions,
} from './telemetry';

export class TelemetryService implements ITelemetryService {
  private readonly client: TelemetryClient;

  constructor(options: TelemetryServiceOptions = {}) {
    this.client = options.client ?? noopTelemetryClient;
  }

  track(event: string, properties?: TelemetryProperties): void {
    this.client.track(event, properties);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetryService({ client: withTelemetryContext(this.client, patch) });
  }

  setContext(patch: TelemetryContextPatch): void {
    this.client.setContext?.(patch);
  }
}

registerSingleton(
  ITelemetryService,
  new SyncDescriptor(TelemetryService, [{}], true),
);
