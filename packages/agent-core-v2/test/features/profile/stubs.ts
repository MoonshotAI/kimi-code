import type { ThinkingEffort } from '#/kosong/contract/provider';
import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/kosong/contract/capability';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';
import type {
  ProfileData,
  ProfileModelContext,
  ProfileStatus,
} from '#/features/profile/profile';
import type { ProfileRuntime } from '#/features/profile/profileAgentRuntime';

export function stubProfileRuntime(
  input: {
    readonly data?: () => ProfileData;
    readonly model?: () => string;
    readonly systemPrompt?: () => string;
    readonly activeTools?: () => readonly string[] | undefined;
    readonly requestParams?: () => ModelRequestParams;
    readonly modelCapabilities?: () => ModelCapability;
    readonly maxOutputSize?: () => number | undefined;
    readonly modelContext?: () => ProfileModelContext;
    readonly effectiveThinkingLevel?: () => ThinkingEffort;
    readonly agentsMdWarning?: () => string | undefined;
    readonly hasProvider?: () => boolean;
    readonly status?: () => ProfileStatus;
    readonly addActiveTool?: (name: string) => void;
    readonly removeActiveTool?: (name: string) => void;
    readonly republishStatus?: () => void;
  } = {},
): ProfileRuntime {
  return {
    data: input.data ?? (() => ({ modelCapabilities: UNKNOWN_CAPABILITY, thinkingLevel: 'off', systemPrompt: '' })),
    model: input.model ?? (() => ''),
    systemPrompt: input.systemPrompt ?? (() => ''),
    activeTools: input.activeTools ?? (() => undefined),
    requestParams: input.requestParams ?? (() => ({})),
    modelCapabilities: input.modelCapabilities ?? (() => UNKNOWN_CAPABILITY),
    maxOutputSize: input.maxOutputSize ?? (() => undefined),
    modelContext: input.modelContext ?? (() => {
      throw new Error('not exercised');
    }),
    effectiveThinkingLevel: input.effectiveThinkingLevel ?? (() => 'off'),
    agentsMdWarning: input.agentsMdWarning ?? (() => undefined),
    hasProvider: input.hasProvider ?? (() => false),
    status: input.status ?? (() => 'unbound'),
    addActiveTool: input.addActiveTool ?? (() => {}),
    removeActiveTool: input.removeActiveTool ?? (() => {}),
    republishStatus: input.republishStatus ?? (() => {}),
  } as unknown as ProfileRuntime;
}
