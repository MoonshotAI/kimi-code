/**
 * `media` domain — deprecated alias of the request-time media resolver
 * implementation (`mediaResolverService`).
 *
 * Kept under the historical names so existing call sites read unchanged. New
 * code should import `AgentMediaResolverService` / `mediaResolvedKey` from
 * `mediaResolverService` directly.
 */

export {
  AgentMediaResolverService as AgentVideoResolverService,
  mediaResolvedKey,
} from './mediaResolverService';
