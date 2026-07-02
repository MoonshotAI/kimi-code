/**
 * `background` domain barrel — re-exports the background contract
 * (`background`) and its scoped service (`backgroundService`). Importing this
 * barrel registers the `IAgentBackgroundService` binding into the scope registry.
 */

import './configSection';

export * from './background';
export * from './backgroundService';
