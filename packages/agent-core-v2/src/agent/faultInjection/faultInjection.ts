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

/** The deterministic failures the requester can be armed to raise. */
export type FaultKind = 'request-too-large' | 'image-format';

export interface FaultInjectionStatus {
  /** The armed one-shot fault, if any (consumed by the next request attempt). */
  readonly armed: FaultKind | undefined;
  /** Faults that actually fired, in fire order. */
  readonly fired: readonly FaultKind[];
}

export interface IFaultInjectionService {
  readonly _serviceBrand: undefined;

  /**
   * Arm a one-shot fault: the next LLM request attempt raises it before
   * hitting the provider. Refused unless the `fault-injection` experimental
   * flag is enabled.
   */
  arm(kind: FaultKind): void;

  /** Current arming and fire history. */
  status(): FaultInjectionStatus;

  /** Clear the armed fault and the fire history. */
  clear(): void;

  /**
   * Consume the armed one-shot fault — the requester's consumption point,
   * called once per request attempt. Returns undefined when nothing is
   * armed; a consumed fault is recorded in {@link FaultInjectionStatus.fired}.
   */
  take(): FaultKind | undefined;
}

export const IFaultInjectionService: ServiceIdentifier<IFaultInjectionService> =
  createDecorator<IFaultInjectionService>('faultInjectionService');
