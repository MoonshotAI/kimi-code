import { parseOrGenerateRequestId } from './protocol/request-id';

const REQUEST_ID_HEADER = 'x-request-id';

export function resolveRequestId(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw = headers[REQUEST_ID_HEADER];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  return parseOrGenerateRequestId(supplied);
}
