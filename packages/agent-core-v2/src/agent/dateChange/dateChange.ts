/**
 * `dateChange` domain (L4) — `IAgentDateChangeService` contract.
 *
 * Defines the Agent-scope marker service that announces calendar-date changes
 * through a `date_change` context-injection reminder when a session outlives
 * the date rendered into its system prompt.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/**
 * Typed disclosure recorded on `date_change` injections: the render baseline
 * the model has most recently seen, handed back to the provider on the next
 * reconciliation.
 */
export interface DateInjectionDisclosure {
  readonly kind: 'date';
  readonly renderGeneration: number;
  readonly localDate: string;
  readonly timeZone: string;
}

export interface IAgentDateChangeService {
  readonly _serviceBrand: undefined;
}

export const IAgentDateChangeService: ServiceIdentifier<IAgentDateChangeService> =
  createDecorator<IAgentDateChangeService>('agentDateChangeService');
