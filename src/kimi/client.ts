import type { Config } from '../config.js';

/**
 * Error thrown when the kimi-code REST API returns a non-2xx response.
 */
export class KimiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string
  ) {
    super(message);
    this.name = 'KimiClientError';
  }
}

export interface KimiClient {
  submitPrompt(sessionId: string, text: string, replyToMessageId?: string): Promise<{ id: string }>;
}

/**
 * Creates a lightweight REST client for a running kimi-code server.
 */
export function createKimiClient(config: Config): KimiClient {
  return {
    async submitPrompt(sessionId, text, replyToMessageId) {
      const url = `${config.kimiServerUrl}/api/v1/sessions/${encodeURIComponent(
        sessionId
      )}/prompts`;

      const body: Record<string, string> = { text };
      if (replyToMessageId) {
        body.reply_to_message_id = replyToMessageId;
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.kimiBearerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new KimiClientError(
          `Network error calling kimi-code API: ${message}`,
          0,
          ''
        );
      }

      const responseBody = await response.text();

      if (!response.ok) {
        throw new KimiClientError(
          `kimi-code API error: ${response.status} ${response.statusText}`,
          response.status,
          responseBody
        );
      }

      let data: unknown;
      try {
        data = JSON.parse(responseBody);
      } catch {
        throw new KimiClientError(
          'Invalid JSON response from kimi-code API',
          response.status,
          responseBody
        );
      }

      if (
        typeof data !== 'object' ||
        data === null ||
        !('id' in data) ||
        typeof (data as { id?: unknown }).id !== 'string'
      ) {
        throw new KimiClientError(
          'Invalid response from kimi-code API: missing id',
          response.status,
          responseBody
        );
      }

      return { id: (data as { id: string }).id };
    },
  };
}
