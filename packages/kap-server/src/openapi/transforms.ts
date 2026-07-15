/**
 * `openapi` transforms — post-process the `@fastify/swagger` document so the
 * routes that swagger cannot describe from static schemas (multipart upload,
 * binary download, and the `{tail}` dispatchers) are represented accurately.
 *
 * Tailored to the route subset `server-v2` actually registers. Notably, the
 * session-action dispatcher only serves `::archive` in v2, so this module
 * projects `/sessions/{tail}` into a single `/sessions/{session_id}:archive`
 * operation — unlike v1, which clones it into fork / compact / undo. Wire
 * schemas are re-used from the local `protocol/` tree and `@moonshot-ai/agent-core-v2`; none are re-declared here.
 */

import {
  fsDiffRequestSchema,
  fsDiffResponseSchema,
  fsGitStatusRequestSchema,
  fsGitStatusResponseSchema,
} from '@moonshot-ai/agent-core-v2/app/git/git';
import {
  fsGrepRequestSchema,
  fsGrepResponseSchema,
  fsListManyRequestSchema,
  fsListManyResponseSchema,
  fsListRequestSchema,
  fsListResponseSchema,
  fsMkdirRequestSchema,
  fsMkdirResponseSchema,
  fsReadRequestSchema,
  fsReadResponseSchema,
  fsSearchRequestSchema,
  fsSearchResponseSchema,
  fsStatManyRequestSchema,
  fsStatManyResponseSchema,
  fsStatRequestSchema,
  fsStatResponseSchema,
} from '@moonshot-ai/agent-core-v2/session/sessionFs/fs';
import { z } from 'zod';

import {
  openApiDocumentEnvelopeJsonSchema,
  openApiDocumentJsonSchema,
} from '../middleware/schema';
import {
  fsOpenInRequestSchema,
  fsOpenInResponseSchema,
  fsOpenRequestSchema,
  fsOpenResponseSchema,
  fsRevealRequestSchema,
  fsRevealResponseSchema,
} from '../protocol/rest-fs';
import {
  questionDismissResultSchema,
  questionResolveRequestSchema,
  questionResolveResultSchema,
} from '../protocol/rest-question';
import { archiveSessionResponseSchema } from '../protocol/rest-session';

const binarySchema = {
  type: 'string',
  format: 'binary',
} as const;

const fileUploadMultipartSchema = {
  type: 'object',
  properties: {
    file: binarySchema,
    name: { type: 'string' },
    expires_in_sec: { type: 'number', minimum: 0 },
  },
  required: ['file'],
} as const;

const errorEnvelopeSchema = openApiDocumentEnvelopeJsonSchema(z.null());

const fsActionRequestSchema = {
  oneOf: [
    openApiDocumentJsonSchema(fsListRequestSchema),
    openApiDocumentJsonSchema(fsReadRequestSchema),
    openApiDocumentJsonSchema(fsListManyRequestSchema),
    openApiDocumentJsonSchema(fsStatRequestSchema),
    openApiDocumentJsonSchema(fsStatManyRequestSchema),
    openApiDocumentJsonSchema(fsMkdirRequestSchema),
    openApiDocumentJsonSchema(fsSearchRequestSchema),
    openApiDocumentJsonSchema(fsGrepRequestSchema),
    openApiDocumentJsonSchema(fsGitStatusRequestSchema),
    openApiDocumentJsonSchema(fsDiffRequestSchema),
    openApiDocumentJsonSchema(fsOpenRequestSchema),
    openApiDocumentJsonSchema(fsOpenInRequestSchema),
    openApiDocumentJsonSchema(fsRevealRequestSchema),
  ],
} as const;

const fsActionResponseSchema = {
  oneOf: [
    openApiDocumentEnvelopeJsonSchema(fsListResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsReadResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsListManyResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsStatResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsStatManyResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsMkdirResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsSearchResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsGrepResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsGitStatusResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsDiffResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsOpenResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsOpenInResponseSchema),
    openApiDocumentEnvelopeJsonSchema(fsRevealResponseSchema),
  ],
} as const;

const questionResponseSchema = {
  oneOf: [
    openApiDocumentEnvelopeJsonSchema(questionResolveResultSchema),
    openApiDocumentEnvelopeJsonSchema(questionDismissResultSchema),
  ],
} as const;

export function transformOpenApiDocument(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const paths = asRecord(document['paths']);
  if (paths === undefined) return document;

  patchFileUpload(paths);
  patchFileDownload(paths);
  patchSessionExport(paths);
  patchSessionAction(paths);
  patchFsAction(paths);
  patchFsDownload(paths);
  patchQuestionResolveOrDismiss(paths);

  return document;
}

function patchSessionExport(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/sessions/{session_id}/export', 'post');
  if (operation === undefined) return;

  setResponse(operation, '200', {
    description: 'Session export archive or JSON error envelope',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      'cache-control': headerString(),
    },
    content: {
      'application/zip': {
        schema: binarySchema,
      },
      ...jsonContent(errorEnvelopeSchema),
    },
  });
}

function patchFileUpload(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/files', 'post');
  if (operation === undefined) return;

  operation['requestBody'] = {
    required: true,
    content: {
      'multipart/form-data': {
        schema: fileUploadMultipartSchema,
      },
    },
  };
}

function patchFileDownload(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/files/{file_id}', 'get');
  if (operation === undefined) return;

  setResponse(operation, '200', {
    description: 'Binary file download',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      etag: headerString(),
    },
    content: {
      'application/octet-stream': {
        schema: binarySchema,
      },
    },
  });
  setResponse(operation, '404', {
    description: 'File not found',
    content: jsonContent(errorEnvelopeSchema),
  });
}

function patchSessionAction(paths: Record<string, unknown>): void {
  const internalPath = '/api/v1/sessions/{tail}';
  const pathItem = asRecord(paths[internalPath]);
  const operation = asRecord(pathItem?.['post']);
  if (pathItem === undefined || operation === undefined) return;

  const cloned = cloneRecord(pathItem);
  replacePathParamName(cloned, 'tail', 'session_id');
  const clonedOperation = asRecord(cloned['post']);
  if (clonedOperation !== undefined) {
    clonedOperation['operationId'] = 'runSessionArchiveAction';
    setResponse(clonedOperation, '200', {
      description: 'Session archive response',
      content: jsonContent(openApiDocumentEnvelopeJsonSchema(archiveSessionResponseSchema)),
    });
  }
  paths['/api/v1/sessions/{session_id}:archive'] = cloned;
  delete paths[internalPath];
}

function patchFsAction(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/sessions/{session_id}/{tail}', 'post');
  if (operation === undefined) return;

  operation['description'] = appendDescription(
    operation['description'],
    'The request and response schemas depend on the `fs:<action>` path tail and are represented as OpenAPI `oneOf` unions.',
  );
  operation['requestBody'] = {
    required: true,
    content: jsonContent(fsActionRequestSchema),
  };
  setResponse(operation, '200', {
    description: 'Filesystem action response',
    content: jsonContent(fsActionResponseSchema),
  });
}

function patchFsDownload(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/sessions/{session_id}/fs/{*}', 'get');
  if (operation === undefined) return;

  setResponse(operation, '200', {
    description: 'Binary workspace file download',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      etag: headerString(),
      'last-modified': headerString(),
    },
    content: {
      'application/octet-stream': {
        schema: binarySchema,
      },
    },
  });
  setResponse(operation, '206', {
    description: 'Partial binary workspace file download',
    headers: {
      'content-disposition': headerString(),
      'content-length': headerInteger(),
      'content-range': headerString(),
      etag: headerString(),
      'last-modified': headerString(),
    },
    content: {
      'application/octet-stream': {
        schema: binarySchema,
      },
    },
  });
  setResponse(operation, '304', {
    description: 'Not modified',
    headers: {
      etag: headerString(),
    },
  });
}

function patchQuestionResolveOrDismiss(paths: Record<string, unknown>): void {
  const operation = getOperation(paths, '/api/v1/sessions/{session_id}/questions/{tail}', 'post');
  if (operation === undefined) return;

  operation['description'] = appendDescription(
    operation['description'],
    'Resolve uses the question response body; `:dismiss` sends an empty body.',
  );
  operation['requestBody'] = {
    required: false,
    content: jsonContent(openApiDocumentJsonSchema(questionResolveRequestSchema)),
  };
  setResponse(operation, '200', {
    description: 'Question resolved or dismissed',
    content: jsonContent(questionResponseSchema),
  });
}

function getOperation(
  paths: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> | undefined {
  const pathItem = asRecord(paths[path]);
  if (pathItem === undefined) return undefined;
  return asRecord(pathItem[method]);
}

function setResponse(
  operation: Record<string, unknown>,
  statusCode: string,
  response: Record<string, unknown>,
): void {
  const responses = asRecord(operation['responses']) ?? {};
  responses[statusCode] = response;
  operation['responses'] = responses;
}

function jsonContent(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    'application/json': {
      schema,
    },
  };
}

function headerString(): Record<string, unknown> {
  return {
    schema: {
      type: 'string',
    },
  };
}

function headerInteger(): Record<string, unknown> {
  return {
    schema: {
      type: 'integer',
    },
  };
}

function appendDescription(existing: unknown, extra: string): string {
  if (typeof existing !== 'string' || existing.length === 0) return extra;
  return `${existing} ${extra}`;
}

function replacePathParamName(
  container: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const params = container['parameters'];
  if (Array.isArray(params)) {
    for (const param of params) {
      const record = asRecord(param);
      if (record?.['in'] === 'path' && record['name'] === from) {
        record['name'] = to;
      }
    }
  }

  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const operation = asRecord(container[method]);
    if (operation !== undefined) {
      replacePathParamName(operation, from, to);
    }
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}
