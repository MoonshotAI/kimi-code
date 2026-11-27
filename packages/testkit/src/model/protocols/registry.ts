import { anthropicCodec } from '#/model/protocols/anthropic';
import type { ProtocolCodec } from '#/model/protocols/codec';
import { googleCodec } from '#/model/protocols/google';
import { openaiCodec } from '#/model/protocols/openai';
import { openaiResponsesCodec } from '#/model/protocols/openai-responses';

const CODECS: readonly ProtocolCodec[] = [openaiCodec, openaiResponsesCodec, anthropicCodec, googleCodec];

export function codecForPath(path: string): ProtocolCodec | undefined {
  return CODECS.find((codec) => codec.matches(path));
}
