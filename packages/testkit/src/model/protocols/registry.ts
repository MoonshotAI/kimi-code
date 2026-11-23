import { anthropicCodec } from '#/model/protocols/anthropic';
import type { ProtocolCodec } from '#/model/protocols/codec';
import { googleCodec } from '#/model/protocols/google';
import { openaiCodec } from '#/model/protocols/openai';

const CODECS: readonly ProtocolCodec[] = [openaiCodec, anthropicCodec, googleCodec];

export function codecForPath(path: string): ProtocolCodec | undefined {
  return CODECS.find((codec) => codec.matches(path));
}
