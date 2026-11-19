import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyContractChanges, describeContractChanges } from '#/contract/changes';
import { contractSummaryText, expectContractGolden } from '#/contract/golden';
import { summarizeContract } from '#/contract/summary';
import { isolateProcessEnv } from '#/fixtures/env';
import { REFRESH_ENV, stableJson } from '#/fixtures/golden';
import { createTestHome } from '#/fixtures/home';

const envelope = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'msg', 'request_id'],
  properties: { code: { type: 'number' }, msg: { type: 'string' }, request_id: { type: 'string' } },
};

function openapi(overrides: { request?: Record<string, unknown>; required?: string[]; response?: Record<string, unknown>; extraPath?: boolean } = {}): unknown {
  const sessionResponse = {
    oneOf: [
      {
        type: 'object',
        required: ['code', 'data'],
        properties: { code: { enum: [0] }, data: { type: 'object', properties: overrides.response ?? { status: { enum: ['idle', 'running'] }, title: { type: 'string' } } } },
      },
      envelope,
    ],
  };
  const paths: Record<string, unknown> = {
    '/api/v1/sessions': {
      post: {
        description: 'Create a session',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: overrides.required ?? ['cwd'], properties: overrides.request ?? { cwd: { type: 'string' }, mode: { enum: ['manual', 'yolo'] } } } } } },
        responses: { 200: { content: { 'application/json': { schema: sessionResponse } } } },
      },
      get: { parameters: [{ in: 'query', name: 'page_size', required: false, schema: { type: 'number' } }], responses: { 200: { content: { 'application/json': { schema: envelope } } } } },
    },
    '/api/v1/meta': { get: { responses: { 200: { content: { 'application/json': { schema: envelope } } } } } },
  };
  if (overrides.extraPath === true) paths['/api/v1/extra'] = { get: { responses: { 200: { content: { 'application/json': { schema: envelope } } } } } };
  return { openapi: '3.1.0', paths };
}

function asyncapi(extraServerMessage = false): unknown {
  const messages: Record<string, unknown> = {
    subscribe: { payload: { type: 'object', required: ['session_id'], properties: { type: { const: 'subscribe' }, session_id: { type: 'string' } } } },
    turn_ended: { payload: { type: 'object', properties: { type: { const: 'turn.ended' }, turn_id: { type: 'string' } } } },
  };
  if (extraServerMessage) messages['notice'] = { payload: { type: 'object', properties: { type: { const: 'notice' } } } };
  return {
    asyncapi: '3.0.0',
    operations: {
      receiveClientMessages: { action: 'receive', messages: [{ $ref: '#/components/messages/subscribe' }] },
      sendServerMessages: { action: 'send', messages: [{ $ref: '#/components/messages/turn_ended' }, ...(extraServerMessage ? [{ $ref: '#/components/messages/notice' }] : [])] },
    },
    components: { messages },
  };
}

describe('contract summary', () => {
  it('lists one line per field, names union variants and prints a shared shape once', () => {
    const lines = summarizeContract(openapi(), asyncapi()).lines;
    expect(lines).toContain('POST /api/v1/sessions request.cwd: string');
    expect(lines).toContain('POST /api/v1/sessions request.mode: enum "manual"|"yolo" optional');
    expect(lines).toContain('POST /api/v1/sessions response 200<code=0>.data.status: enum "idle"|"running" optional');
    expect(lines).toContain('GET /api/v1/sessions param query:page_size: number optional');
    expect(lines).toContain('ws client message subscribe.session_id: string');
    expect(lines).toContain('ws server message turn_ended.type: const "turn.ended" optional');
    const references = lines.filter((line) => / shape [0-9a-f]{8}$/.test(line));
    expect(references).toHaveLength(3);
    const shape = references[0]!.split(' shape ')[1];
    expect(lines.filter((line) => line.startsWith(`shape ${shape}.`))).toEqual([
      `shape ${shape}.code: number`,
      `shape ${shape}.msg: string`,
      `shape ${shape}.request_id: string`,
    ]);
    expect(lines.join('\n')).not.toContain('Create a session');
  });
});

describe('contract change classification', () => {
  const classify = (before: unknown, after: unknown, beforeAsync = asyncapi(), afterAsync = asyncapi()) =>
    classifyContractChanges(summarizeContract(before, beforeAsync), summarizeContract(after, afterAsync)).map(({ kind, key, detail }) => `${kind}: ${key} — ${detail}`);

  it('treats requests and responses in opposite directions', () => {
    expect(classify(openapi(), openapi({ request: { cwd: { type: 'string' }, mode: { enum: ['manual', 'yolo'] }, title: { type: 'string' } } }))).toEqual([
      'non-breaking: POST /api/v1/sessions request.title — new optional input (string)',
    ]);
    expect(classify(openapi(), openapi({ required: ['cwd', 'mode'] }))).toEqual(['breaking: POST /api/v1/sessions request.mode — now required']);
    expect(classify(openapi(), openapi({ request: { cwd: { type: 'string' }, mode: { enum: ['manual'] } } }))).toEqual([
      'breaking: POST /api/v1/sessions request.mode — no longer accepts "yolo"',
    ]);
    expect(classify(openapi(), openapi({ request: { cwd: { type: 'string' } } }))).toEqual([
      'breaking: POST /api/v1/sessions request.mode — input no longer accepted (enum "manual"|"yolo")',
    ]);
    expect(classify(openapi(), openapi({ response: { status: { enum: ['idle', 'running', 'paused'] }, title: { type: 'string' } } }))).toEqual([
      'unclassified: POST /api/v1/sessions response 200<code=0>.data.status — may now send "paused"',
    ]);
    expect(classify(openapi(), openapi({ response: { status: { enum: ['idle', 'running'] } } }))).toEqual([
      'breaking: POST /api/v1/sessions response 200<code=0>.data.title — no longer sent (string)',
    ]);
    expect(classify(openapi(), openapi({ response: { status: { enum: ['idle', 'running'] }, title: { type: 'string', nullable: true } } }))).toEqual([
      'breaking: POST /api/v1/sessions response 200<code=0>.data.title — may now be null',
    ]);
  });

  it('classifies whole operations and server messages, and ignores description-only edits', () => {
    expect(classify(openapi(), openapi({ extraPath: true }))).toEqual(['non-breaking: GET /api/v1/extra — operation added']);
    expect(classify(openapi({ extraPath: true }), openapi())).toEqual(['breaking: GET /api/v1/extra — operation removed']);
    expect(classify(openapi(), openapi(), asyncapi(true), asyncapi())).toEqual(['breaking: ws server message notice — no longer sent (object)']);
    expect(classify(openapi(), openapi(), asyncapi(), asyncapi(true))).toEqual([
      'unclassified: ws server message notice — new server message; clients must ignore message types they do not know',
    ]);
    const reworded = JSON.parse(JSON.stringify(openapi()).replace('Create a session', 'Creates a session')) as unknown;
    expect(classify(openapi(), reworded)).toEqual([]);
  });

  it('classifies tighter and looser constraints by direction', () => {
    const doc = (requestTitle: Record<string, unknown>, responseTitle: Record<string, unknown>): unknown => ({
      openapi: '3.1.0',
      paths: { '/x': { post: {
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string', ...requestTitle } } } } } },
        responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string', ...responseTitle } } } } } } },
      } } },
    });
    const changesOf = (before: unknown, after: unknown): string[] =>
      classifyContractChanges(summarizeContract(before, asyncapi()), summarizeContract(after, asyncapi())).map(({ kind, key, detail }) => `${kind}: ${key} — ${detail}`);
    expect(changesOf(doc({}, {}), doc({ maxLength: 10, pattern: '^a' }, { maxLength: 10 }))).toEqual([
      'breaking: POST /x request.title — now limits maxLength=10',
      'breaking: POST /x request.title — now limits pattern="^a"',
      'non-breaking: POST /x response 200.title — now limits maxLength=10',
    ]);
    expect(changesOf(doc({ maxLength: 10 }, { maxLength: 10 }), doc({ maxLength: 20 }, { maxLength: 20 }))).toEqual([
      'unclassified: POST /x response 200.title — maxLength 10 → 20',
      'non-breaking: POST /x request.title — maxLength 10 → 20',
    ]);
    expect(changesOf(doc({ minLength: 1 }, {}), doc({ minLength: 2 }, {}))).toEqual(['breaking: POST /x request.title — minLength 1 → 2']);
    expect(summarizeContract(doc({ maxLength: 10 }, {}), asyncapi()).lines).toContain('POST /x request.title: string maxLength=10 optional');
  });

  it('includes parameters declared for every operation of a path', () => {
    const doc = (parameters: unknown[]): unknown => ({
      openapi: '3.1.0',
      paths: { '/x/{id}': { parameters, get: { parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { 200: { content: {} } } } } },
    });
    const shared = [{ in: 'query', name: 'version', required: true, schema: { type: 'string' } }];
    expect(summarizeContract(doc(shared), asyncapi()).lines).toContain('GET /x/{id} param query:version: string');
    expect(classifyContractChanges(summarizeContract(doc([]), asyncapi()), summarizeContract(doc(shared), asyncapi()))).toEqual([
      { kind: 'breaking', key: 'GET /x/{id} param query:version', detail: 'new required input (string)' },
    ]);
  });

  it('keeps variants with the same discriminator apart', () => {
    const twin = { openapi: '3.1.0', paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { oneOf: [
      { type: 'object', properties: { type: { const: 'a' }, left: { type: 'string' } } },
      { type: 'object', properties: { type: { const: 'a' }, right: { type: 'number' } } },
    ] } } } } } } } } };
    const lines = summarizeContract(twin, asyncapi()).lines;
    expect(lines).toContain('GET /x response 200<a#0>.left: string optional');
    expect(lines).toContain('GET /x response 200<a#1>.right: number optional');
  });

  it('summarizes counts before listing the changes', () => {
    const changes = classifyContractChanges(summarizeContract(openapi({ extraPath: true }), asyncapi()), summarizeContract(openapi(), asyncapi()));
    expect(describeContractChanges(changes)[0]).toMatch(/^\d+ contract change\(s\): \d+ breaking, 0 unclassified, 0 non-breaking$/);
  });
});

describe('expectContractGolden', () => {
  it('writes the documents and the summary on refresh, then reports field changes and stale summaries', async () => {
    const home = await createTestHome('testkit-contract');
    const options = { kind: 'schema', refreshCommand: 'pnpm qa:refresh schema' };
    const paths = { openapi: join(home.root, 'openapi.json'), asyncapi: join(home.root, 'asyncapi.json'), summary: join(home.root, 'contract.txt') };
    const restore = isolateProcessEnv({ set: { [REFRESH_ENV]: 'schema', CI: undefined } });
    try {
      await expectContractGolden(paths, { openapi: openapi(), asyncapi: asyncapi() }, options);
      await expect(readFile(paths.summary, 'utf8')).resolves.toBe(contractSummaryText(openapi(), asyncapi()));
      await expect(readFile(paths.openapi, 'utf8')).resolves.toBe(stableJson(openapi()));
      process.env[REFRESH_ENV] = '';
      await expect(expectContractGolden(paths, { openapi: openapi(), asyncapi: asyncapi() }, options)).resolves.toEqual([]);
      await expect(expectContractGolden(paths, { openapi: openapi({ extraPath: true }), asyncapi: asyncapi() }, options)).rejects.toThrow(
        /The published KAP contract differs from the committed one\.\n\d+ contract change\(s\)[^\n]*\n- non-breaking: GET \/api\/v1\/extra — operation added/,
      );
      const reworded = JSON.parse(JSON.stringify(openapi()).replace('Create a session', 'Creates a session')) as unknown;
      await expect(expectContractGolden(paths, { openapi: reworded, asyncapi: asyncapi() }, options)).rejects.toThrow(/Only descriptions, examples or formatting changed/);
      const deprecated = JSON.parse(JSON.stringify(openapi()).replace('"cwd":{"type":"string"}', '"cwd":{"type":"string","deprecated":true}')) as unknown;
      expect(JSON.stringify(deprecated)).toContain('"deprecated":true');
      await expect(expectContractGolden(paths, { openapi: deprecated, asyncapi: asyncapi() }, options)).rejects.toThrow(/schema details this summary does not model; read the JSON diff/);
      await writeFile(paths.summary, `${contractSummaryText(openapi(), asyncapi())}stale line\n`);
      await expect(expectContractGolden(paths, { openapi: openapi(), asyncapi: asyncapi() }, options)).rejects.toThrow(/contract\.txt differs from the committed golden in 1 line\(s\):\n- stale line/);
    } finally {
      restore();
      await home.remove();
    }
  });
});
