/**
 * `media` domain — deprecated alias of the request-time media resolver
 * implementation (`mediaResolverService`).
 *
 * Kept under the historical names so existing call sites read unchanged. New
 * code should import `AgentMediaResolverService` / `mediaResolvedKey` from
 * `mediaResolverService` directly. Only the class is re-exported here:
 * re-exporting `mediaResolvedKey` too would make the package root's
 * `export *` of both modules ambiguous and silently drop the name.
 */

export { AgentMediaResolverService as AgentVideoResolverService } from './mediaResolverService';
