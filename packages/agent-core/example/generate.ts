import {
  anthropicRequester,
  deepseekAnthropicRequester,
  deepseekRequester,
  glmRequester,
  googleGenAIRequester,
  kimiAnthropicRequester,
  kimiRequester,
  openAIRequester,
  openAIResponsesRequester,
} from '#/llm/builtin/provider/index';
import { createUserMessage, extractText, type Message } from '#/llm/message';
import type { LlmModelSpec } from '#/llm/request';
import { endpointFromEnv, PROVIDER_ENV } from '#/node/env';

const requesters = {
  openai: openAIRequester.with({ endpoint: endpointFromEnv(PROVIDER_ENV.openai) }),
  'openai-responses': openAIResponsesRequester.with({ endpoint: endpointFromEnv(PROVIDER_ENV.openai) }),
  anthropic: anthropicRequester.with({ endpoint: endpointFromEnv(PROVIDER_ENV.anthropic) }),
  google: googleGenAIRequester.with({ endpoint: endpointFromEnv(PROVIDER_ENV.google) }),
  kimi: kimiRequester.with({ endpoint: endpointFromEnv(PROVIDER_ENV.kimi) }),
  'kimi-anthropic': kimiAnthropicRequester.with({ endpoint: endpointFromEnv(PROVIDER_ENV.kimiAnthropic) }),
  deepseek: deepseekRequester.with({ endpoint: endpointFromEnv(PROVIDER_ENV.deepseek) }),
  'deepseek-anthropic': deepseekAnthropicRequester.with({
    endpoint: endpointFromEnv(PROVIDER_ENV.deepseekAnthropic),
  }),
  glm: glmRequester.with({ endpoint: endpointFromEnv(PROVIDER_ENV.glm) }),
};

function pickProvider(name: string): keyof typeof requesters {
  if (name in requesters) return name as keyof typeof requesters;
  throw new Error(`EXAMPLE_PROVIDER must be one of: ${Object.keys(requesters).join(', ')}`);
}

const provider = pickProvider(process.env['EXAMPLE_PROVIDER'] ?? 'openai');
const requester = requesters[provider];
const spec: LlmModelSpec = {
  provider,
  name: process.env['EXAMPLE_MODEL'] ?? 'gpt-4.1-mini',
};
const prompt = process.argv.slice(2).join(' ') || 'Introduce yourself in one sentence.';
const messages: readonly Message[] = [createUserMessage(prompt)];

async function streamExample(): Promise<void> {
  console.log(`--- stream (${provider}/${spec.name}) ---`);
  const result = await requester.generate(
    { model: { spec }, content: { messages } },
    {
      signal: AbortSignal.timeout(60_000),
      onEvent: (event) => {
        switch (event.type) {
          case 'llm.streaming.part':
            if (event.part.type === 'text') process.stdout.write(event.part.text);
            return;
          case 'llm.streaming.finish':
            process.stdout.write(`\n[finish] ${event.finish.finishReason ?? 'unknown'}\n`);
            return;
          case 'llm.retrying':
            console.error(`[retrying:${event.reason}] ${event.error.kind}: ${event.error.message}`);
            return;
          default:
            return;
        }
      },
    },
  );
  if (result.type === 'failed') {
    console.error(`[failed] ${result.error.kind}: ${result.error.message}`);
  }
}

async function completeExample(): Promise<void> {
  console.log(`--- non-stream (${provider}/${spec.name}) ---`);
  const result = await requester.generate(
    {
      protocol: { stream: false },
      model: { spec },
      content: { messages },
      policy: { retry: { maxAttemptsPerStep: 2 } },
    },
    { signal: AbortSignal.timeout(60_000) },
  );
  switch (result.type) {
    case 'done':
      console.log(extractText(result.message));
      console.log('[usage]', result.usage);
      console.log('[finish]', result.finish?.finishReason ?? 'unknown');
      return;
    case 'failed':
      console.error(`[failed] ${result.error.kind}: ${result.error.message}`);
      return;
    case 'aborted':
      console.error('[aborted]');
      return;
  }
}

await streamExample();
await completeExample();
