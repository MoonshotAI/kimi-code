export function isOfficialOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  const optIn = process.env['KIMI_CODE_OPENAI_PROMPT_CACHE_KEY'];
  if (optIn === '1' || optIn === 'true') {
    return true;
  }
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