/**
 * `faultInjection` domain (L4) — deterministic provider-failure simulation
 * for testing the requester's recovery projections over a live channel.
 *
 * The turn-loop recovery resends (media-degraded after an HTTP 413 body-size
 * rejection, media-stripped after an image-format rejection) are
 * deterministic given a provider error, but a real provider cannot be asked
 * to produce one on demand. Arming a one-shot fault makes the next LLM
 * request attempt raise the chosen error BEFORE the provider is contacted,
 * so the recovery path — projection rebuild, per-turn stickiness, wire
 * records — runs end-to-end while the (successful) resend still goes to the
 * real provider.
 *
 * `arm` is refused unless the `fault-injection` experimental flag is enabled
 * (see ./flag); `take` is the requester's consumption point and stays inert
 * otherwise.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type FaultKind = 'request-too-large' | 'image-format';

export interface FaultInjectionStatus {
  readonly armed: FaultKind | undefined;
  readonly fired: readonly FaultKind[];
}

export interface IFaultInjectionService {
  readonly _serviceBrand: undefined;

  arm(kind: FaultKind): void;

  status(): FaultInjectionStatus;

  clear(): void;

  take(): FaultKind | undefined;
}

export const IFaultInjectionService: ServiceIdentifier<IFaultInjectionService> =
  createDecorator<IFaultInjectionService>('faultInjectionService');
