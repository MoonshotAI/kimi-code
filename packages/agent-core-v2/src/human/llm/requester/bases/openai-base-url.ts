export function isOfficialOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) {
    return true;
  }
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === 'api.openai.com' || hostname.endsWith('.api.openai.com');
  } catch {
    return false;
  }
}