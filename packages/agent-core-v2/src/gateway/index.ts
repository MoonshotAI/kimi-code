/**
 * `gateway` domain barrel — re-exports the gateway contract (`gateway`) and its
 * scoped services (`gatewayService`). Importing this barrel registers the
 * `IScopeRegistry`, `IRestGateway`, and `IWSGateway` bindings into the scope
 * registry.
 */

export * from './gateway';
export * from './gatewayService';
