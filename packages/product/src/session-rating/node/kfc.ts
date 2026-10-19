import { isManagedKimiCodeBaseUrl } from '@moonshot-ai/kimi-code-oauth';

export interface RatingModelRoute {
  readonly modelId: string | undefined;
  readonly baseUrl: string | undefined;
}

export function kfcModelIdOf(route: RatingModelRoute): string | undefined {
  if (route.modelId === undefined || !isManagedKimiCodeBaseUrl(route.baseUrl)) return undefined;
  return route.modelId;
}
