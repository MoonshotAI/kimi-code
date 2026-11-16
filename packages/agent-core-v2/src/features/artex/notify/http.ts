import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

import {
  createSafeLookup,
  redactRequestTarget,
  redactTransportError,
  snippet,
  validateHttpUrl,
} from './ssrf';
import { permanentError, type NotifyTransportOptions } from './types';

export const NOTIFY_HTTP_TIMEOUT_MS = 15_000;
export const NOTIFY_RESP_BODY_LIMIT = 8 << 10;
export const NOTIFY_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface HttpReply {
  readonly statusCode: number;
  readonly location?: string;
  readonly body: Buffer;
}

function sendSingleRequest(
  method: string,
  targetUrl: URL,
  headers: Readonly<Record<string, string>>,
  bodyBuf: Buffer | undefined,
  options?: NotifyTransportOptions,
): Promise<HttpReply> {
  const timeoutMs = options?.timeoutMs ?? NOTIFY_HTTP_TIMEOUT_MS;
  const safeLookup = createSafeLookup(options) as unknown as LookupFunction;
  const isHttps = targetUrl.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = { ...headers };
    if (bodyBuf !== undefined) {
      reqHeaders['Content-Length'] = String(bodyBuf.length);
    }

    const req = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port === '' ? undefined : Number(targetUrl.port),
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers: reqHeaders,
        lookup: safeLookup,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;

        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const remaining = NOTIFY_RESP_BODY_LIMIT - total;
          if (chunk.length > remaining) {
            chunks.push(chunk.subarray(0, remaining));
            total += remaining;
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });

        res.on('end', () => {
          const locationHeader = res.headers.location;
          const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
          resolve({
            statusCode: res.statusCode ?? 0,
            location,
            body: Buffer.concat(chunks),
          });
        });

        res.on('close', () => {
          if (!truncated) return;
          const locationHeader = res.headers.location;
          const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
          resolve({
            statusCode: res.statusCode ?? 0,
            location,
            body: Buffer.concat(chunks),
          });
        });

        res.on('error', (err) => {
          reject(new Error(`failed to read response: ${err.message}`));
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`request timed out after ${String(timeoutMs)}ms`));
    });

    req.on('error', (err) => {
      reject(new Error(`request failed: ${redactTransportError(method, targetUrl.toString(), err)}`));
    });

    if (bodyBuf !== undefined) {
      req.write(bodyBuf);
    }
    req.end();
  });
}

export async function doHttpJson(
  method: string,
  rawUrl: string,
  headers: Readonly<Record<string, string>> | undefined,
  payload: unknown,
  options?: NotifyTransportOptions & { readonly preSerializedJson?: string },
): Promise<Buffer> {
  let initialUrl: URL;
  try {
    initialUrl = validateHttpUrl(rawUrl, options);
  } catch (error) {
    throw permanentError(
      `invalid request URL: ${redactRequestTarget(rawUrl)} (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  let bodyBuf: Buffer | undefined;
  const reqHeaders: Record<string, string> = {};
  if (options?.preSerializedJson !== undefined) {
    bodyBuf = Buffer.from(options.preSerializedJson, 'utf8');
    reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
  } else if (payload !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch (error) {
      throw permanentError(
        `failed to build request body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    bodyBuf = Buffer.from(serialized, 'utf8');
    reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
  }

  if (headers !== undefined) {
    for (const [k, v] of Object.entries(headers)) {
      reqHeaders[k] = v;
    }
  }

  let currentUrl = initialUrl;
  let currentMethod = method.toUpperCase();
  let currentBody = bodyBuf;

  for (let hop = 0; hop <= NOTIFY_MAX_REDIRECTS; hop += 1) {
    const reply = await sendSingleRequest(currentMethod, currentUrl, reqHeaders, currentBody, options);
    if (REDIRECT_STATUSES.has(reply.statusCode) && reply.location !== undefined && reply.location !== '') {
      if (hop >= NOTIFY_MAX_REDIRECTS) {
        throw new Error('request failed: too many redirects');
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(reply.location, currentUrl);
      } catch (error) {
        throw new Error('request failed: invalid redirect URL', { cause: error });
      }
      if (nextUrl.host !== initialUrl.host) {
        throw new Error(
          `request failed: refusing cross-host redirect (${initialUrl.host} → ${nextUrl.host})`,
        );
      }
      try {
        validateHttpUrl(nextUrl.toString(), options);
      } catch (error) {
        throw new Error(
          `request failed: redirect target rejected (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
      if (reply.statusCode === 301 || reply.statusCode === 302 || reply.statusCode === 303) {
        currentMethod = 'GET';
        currentBody = undefined;
        delete reqHeaders['Content-Type'];
      }
      currentUrl = nextUrl;
      continue;
    }

    if (reply.statusCode >= 200 && reply.statusCode < 300) {
      return reply.body;
    }
    if (reply.statusCode === 429 || reply.statusCode === 408) {
      throw new Error(`peer rate limit or timeout (HTTP ${String(reply.statusCode)}): ${snippet(reply.body)}`);
    }
    if (reply.statusCode >= 500) {
      throw new Error(`peer server error (HTTP ${String(reply.statusCode)}): ${snippet(reply.body)}`);
    }
    throw permanentError(
      `peer rejected the request (HTTP ${String(reply.statusCode)}): ${snippet(reply.body)}`,
    );
  }

  throw new Error('request failed: too many redirects');
}
