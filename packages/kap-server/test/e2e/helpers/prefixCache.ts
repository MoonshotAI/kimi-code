import type { ChatCompletionRequest } from '@copilotkit/aimock';

export interface PrefixUsage {
  readonly input: number;
  readonly cachedInput: number;
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index++;
  return index;
}

function cacheKey(request: ChatCompletionRequest): string {
  const key = request['prompt_cache_key'];
  return `${request.model}:${typeof key === 'string' ? key : ''}`;
}

export class PrefixCache {
  private readonly prompts = new Map<string, string>();

  usageFor(request: ChatCompletionRequest): PrefixUsage {
    const prompt = [request.tools ?? [], ...request.messages]
      .map((part) => JSON.stringify(part))
      .join('\n');
    const key = cacheKey(request);
    const previous = this.prompts.get(key);
    const prefixLength = previous === undefined ? 0 : commonPrefixLength(previous, prompt);
    const input = estimateTokens(prompt);
    const cachedInput = Math.min(input, estimateTokens(prompt.slice(0, prefixLength)));
    this.prompts.set(key, prompt);
    return { input, cachedInput };
  }
}
