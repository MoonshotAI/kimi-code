/**
 * `provider` domain barrel — re-exports the provider contract (`provider`) and
 * its scoped service (`providerService`). Importing this barrel registers the
 * `IProviderService` binding into the scope registry.
 */

import './configSection';

export * from './provider';
export * from './providerService';
