/**
 * Minimal service-identifier primitive (localized from the retired
 * `agent-core-v2` `_base/di/instantiation`). kap-server keeps only the
 * identifier marker — no DI scope container, services are injected directly
 * at the composition root.
 */

// `T` is a phantom type parameter: it exists only to make `ServiceIdentifier<T>`
// nominal across service types (the identifier itself is a bare symbol).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface ServiceIdentifier<T> {
  readonly _serviceBrand: undefined;
}

/** Create a nominal service identifier keyed by `id`. */
export function createDecorator<T>(id: string): ServiceIdentifier<T> {
  return Symbol.for(`kimi-kap-server:${id}`) as unknown as ServiceIdentifier<T>;
}
