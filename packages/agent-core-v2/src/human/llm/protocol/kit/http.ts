import { headerValue } from '#/llm/endpoint';

export function requestIdFromHeader(
  name: string,
): (headers: Readonly<Record<string, string>>) => string | undefined {
  return (headers) => headerValue(headers, name);
}
