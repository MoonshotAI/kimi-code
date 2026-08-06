/**
 * `media` domain — deprecated alias of the request-time media resolver
 * contract (`mediaResolver`).
 *
 * Kept under the historical name so existing call sites read unchanged. New
 * code should import `IAgentMediaResolverService` from `mediaResolver`
 * directly.
 */

export { IAgentMediaResolverService as IAgentVideoResolverService } from './mediaResolver';
