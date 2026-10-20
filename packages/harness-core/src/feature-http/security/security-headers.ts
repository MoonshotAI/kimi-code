import type { Response } from 'express';

const HSTS_VALUE = 'max-age=31536000';
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'self'";

export function applySecurityHeaders(response: Response, tls: boolean): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  if (tls) response.setHeader('Strict-Transport-Security', HSTS_VALUE);
}
