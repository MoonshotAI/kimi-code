import { describe, expect, it } from 'vitest';

import { metaResponseSchema, type MetaResponse } from '../rest/meta';

describe('metaResponseSchema', () => {
  const sample = {
    server_version: '0.1.0',
    capabilities: {
      websocket: true,
      file_upload: true,
      fs_query: true,
      mcp: true,
      background_tasks: true,
      terminal: true,
    },
    server_id: '01HXYZABCDEFGHJKMNPQRSTVWX',
    started_at: '2026-06-04T10:30:00.000Z',
    open_in_apps: ['finder', 'vscode'] as const,
  };

  it('round-trips a well-formed payload', () => {
    const parsed: MetaResponse = metaResponseSchema.parse(sample);
    expect(parsed.server_version).toBe('0.1.0');
    expect(parsed.capabilities.websocket).toBe(true);
    expect(parsed.server_id).toBe('01HXYZABCDEFGHJKMNPQRSTVWX');
    expect(parsed.started_at).toBe('2026-06-04T10:30:00.000Z');
  });

  it('normalizes started_at to UTC Z with millisecond precision', () => {
    const offsetForm = {
      ...sample,
      started_at: '2026-06-04T18:30:00+08:00',
    };
    const parsed = metaResponseSchema.parse(offsetForm);
    expect(parsed.started_at).toBe('2026-06-04T10:30:00.000Z');
  });

  it('rejects missing server_version', () => {
    const { server_version: _omit, ...rest } = sample;
    expect(metaResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing capabilities', () => {
    const { capabilities: _omit, ...rest } = sample;
    expect(metaResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing server_id', () => {
    const { server_id: _omit, ...rest } = sample;
    expect(metaResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing started_at', () => {
    const { started_at: _omit, ...rest } = sample;
    expect(metaResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a capability set with the wrong boolean literal', () => {
    const bad = {
      ...sample,
      capabilities: { ...sample.capabilities, websocket: false },
    };
    expect(metaResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty server_version string', () => {
    const bad = { ...sample, server_version: '' };
    expect(metaResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a malformed started_at (no timezone marker)', () => {
    const bad = { ...sample, started_at: '2026-06-04T10:30:00' };
    expect(metaResponseSchema.safeParse(bad).success).toBe(false);
  });
});
