import { isValid, ulid } from 'ulid';

export const ulidRegex = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function parseOrGenerateRequestId(headerValue: string | undefined): string {
  if (typeof headerValue === 'string' && isValid(headerValue)) {
    return headerValue;
  }
  return ulid();
}

export function isUlid(value: string): boolean {
  return isValid(value);
}
