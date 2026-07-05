#!/usr/bin/env node

/**
 * CLI helper to list active kimi-code sessions so the user can pick an ID
 * for `npm run pair -- <session-id>`.
 *
 * Usage:
 *   npm run sessions
 *   npx tsx scripts/list-sessions.ts
 */

import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

interface SessionLike {
  id?: string;
  sessionId?: string;
  created_at?: string;
  updated_at?: string;
  status?: string;
  [key: string]: unknown;
}

async function fetchSessions(serverUrl: string, token: string): Promise<unknown> {
  const response = await fetch(`${serverUrl}/api/v1/sessions`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`kimi-code returned ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

function extractSessions(payload: unknown): SessionLike[] {
  if (Array.isArray(payload)) return payload as SessionLike[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['sessions', 'data', 'items', 'results']) {
      const value = obj[key];
      if (Array.isArray(value)) return value as SessionLike[];
    }
  }
  return [];
}

function getSessionId(session: SessionLike): string | undefined {
  return session.id ?? session.sessionId;
}

async function discoverSessionPaths(serverUrl: string, token: string): Promise<void> {
  try {
    const response = await fetch(`${serverUrl}/openapi.json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return;

    const spec = (await response.json()) as { paths?: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});
    const sessionPaths = paths.filter((p) => p.includes('session'));

    if (sessionPaths.length > 0) {
      console.log('Session-related paths found in OpenAPI spec:');
      sessionPaths.forEach((p) => console.log(`  ${p}`));
    }
  } catch {
    // Ignore discovery errors.
  }
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);

  try {
    const payload = await fetchSessions(config.kimiServerUrl, config.kimiBearerToken);
    const sessions = extractSessions(payload);

    if (sessions.length === 0) {
      console.log('No sessions returned by kimi-code.');
      return;
    }

    console.log('Active kimi-code sessions:');
    for (const session of sessions) {
      const id = getSessionId(session);
      if (!id) continue;

      const status = session.status ?? 'unknown';
      const created = session.created_at ?? '';
      const line = [`- ${id}`, status && `status=${status}`, created && `created=${created}`]
        .filter(Boolean)
        .join(' ');
      console.log(line);
    }

    console.log('\nPair a session with Telegram:');
    console.log('  npm run pair -- <session-id>');
  } catch (error) {
    logger.error({ error }, 'Failed to list sessions from kimi-code');
    console.error('\nCould not fetch sessions. Make sure kimi-code is running and the bearer token is valid.');
    console.error(`Tried: GET ${config.kimiServerUrl}/api/v1/sessions`);
    await discoverSessionPaths(config.kimiServerUrl, config.kimiBearerToken);
    process.exit(1);
  }
}

main();
