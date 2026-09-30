import { uploadFilename } from '#/llm/protocol/kit/media';
import type { LlmFiles } from '#/llm/request';

import { deepseekOpenAIProtocol } from './protocol';

const FILE_LIFETIME_SECONDS = 30 * 24 * 3600;
const EXPIRY_MARGIN_MS = 3600_000;

function createDeepSeekFiles(filesBaseUrl: (baseUrl: string | undefined) => string | undefined): LlmFiles {
  return {
    kinds: new Set(['image']),
    upload: async (file, { endpoint, signal }) => {
      const client = deepseekOpenAIProtocol.client(
        { ...endpoint, baseUrl: filesBaseUrl(endpoint.baseUrl) },
        undefined,
      );
      const body = new File([file.data], uploadFilename(file), {
        type: file.mimeType,
      });
      const uploaded = await client.files.create(
        {
          file: body,
          purpose: 'user_data',
          expires_after: { anchor: 'created_at', seconds: FILE_LIFETIME_SECONDS },
        },
        { signal },
      );
      return {
        source: { kind: 'file', id: uploaded.id, mimeType: file.mimeType },
        expiresAt:
          typeof uploaded.expires_at === 'number' ? uploaded.expires_at * 1000 - EXPIRY_MARGIN_MS : undefined,
      };
    },
  };
}

export const deepseekFiles: LlmFiles = createDeepSeekFiles((baseUrl) => baseUrl);

export const deepseekAnthropicFiles: LlmFiles = createDeepSeekFiles((baseUrl) =>
  baseUrl?.replace(/\/anthropic\/?$/, ''),
);
