import { uploadFilename } from '#/llm/protocol/kit/media';
import type { LlmFiles, UploadedMedia } from '#/llm/request';

import { kimiOpenAIProtocol } from './protocol';

const READY_FILE_OBJECT_STATUSES = new Set(['ready', 'ok', 'processed']);

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readUploadFailureDetail(record: Record<string, unknown>): string | undefined {
  const statusDetails = readNonEmptyString(record['status_details']);
  if (statusDetails !== undefined) return statusDetails;
  const extractError = record['extract_error'];
  const directExtractError = readNonEmptyString(extractError);
  if (directExtractError !== undefined) return directExtractError;
  if (extractError !== undefined) {
    const serialized = JSON.stringify(extractError);
    if (serialized !== undefined) return serialized;
  }
  const rawError = record['error'];
  const directError = readNonEmptyString(rawError);
  if (directError !== undefined) return directError;
  if (typeof rawError === 'object' && rawError !== null) {
    const nestedMessage = readNonEmptyString((rawError as Record<string, unknown>)['message']);
    if (nestedMessage !== undefined) return nestedMessage;
  }
  return readNonEmptyString(record['message']);
}

function formatUploadStatusError(
  id: string,
  field: 'extract_status' | 'status',
  value: unknown,
  detail: string | undefined,
): Error {
  const rendered = String(value);
  const summary =
    value === 'error'
      ? `Kimi file upload failed for file "${id}" (${field}=${rendered})`
      : `Kimi file upload for file "${id}" is not ready (${field}=${rendered})`;
  return new Error(detail === undefined ? summary : `${summary}: ${detail}`);
}

function parseUploadedKimiFile(uploaded: unknown): UploadedMedia {
  if (typeof uploaded !== 'object' || uploaded === null) {
    throw new Error('Kimi file upload returned an invalid response payload');
  }
  const record = uploaded as Record<string, unknown>;
  const rawId = record['id'];
  const id = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId : undefined;
  if (id === undefined) {
    throw new Error('Kimi file upload returned an empty file id');
  }
  const extractStatus = record['extract_status'];
  if (extractStatus !== undefined && extractStatus !== null && extractStatus !== 'ready') {
    throw formatUploadStatusError(
      id,
      'extract_status',
      extractStatus,
      readUploadFailureDetail(record),
    );
  }
  const status = record['status'];
  const allowUploadedWithReadyExtract = extractStatus === 'ready' && status === 'uploaded';
  if (
    status !== undefined &&
    status !== null &&
    !allowUploadedWithReadyExtract &&
    (typeof status !== 'string' || !READY_FILE_OBJECT_STATUSES.has(status))
  ) {
    throw formatUploadStatusError(id, 'status', status, readUploadFailureDetail(record));
  }
  return { url: `ms://${id}`, id };
}

function createKimiFiles(filesBaseUrl: (baseUrl: string | undefined) => string | undefined): LlmFiles {
  return {
    kinds: new Set(['image', 'video']),
    upload: async (file, { endpoint, signal }) => {
      if (!file.mimeType.startsWith(`${file.kind}/`)) {
        throw new Error(`Expected a ${file.kind} mime type, got ${file.mimeType}`);
      }
      const client = kimiOpenAIProtocol.client(
        { ...endpoint, baseUrl: filesBaseUrl(endpoint.baseUrl) },
        undefined,
      );
      const body = new File([new Uint8Array(file.data)], uploadFilename(file), {
        type: file.mimeType,
      });
      const uploaded = await client.files.create({ file: body, purpose: file.kind as never }, { signal });
      return parseUploadedKimiFile(uploaded);
    },
  };
}

export const kimiFiles: LlmFiles = createKimiFiles((baseUrl) => baseUrl);

export const kimiAnthropicFiles: LlmFiles = createKimiFiles((baseUrl) => {
  if (baseUrl === undefined) return undefined;
  return /\/v1\/?$/.test(baseUrl) ? baseUrl : `${baseUrl.replace(/\/$/, '')}/v1`;
});
