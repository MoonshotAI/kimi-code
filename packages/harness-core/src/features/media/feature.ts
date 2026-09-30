import {
  ConfigRef,
  Providers,
  createFeature,
  createMediaDegradeRecovery,
  useAgent,
  useAgentTools,
  useConfigSection,
  useInject,
  useLlmRecovery,
  useMediaLower,
  useMessageResolver,
  usePromptGate,
  type FeatureSpec,
  type MediaStore,
  type MediaUploadCache,
} from '@moonshot-ai/agent-core';
import { useCollection } from '@moonshot-ai/agent-core/kernel/index';

import type { OsHost } from '#/features/os/host/types';

import { createMediaBudgetResolver } from './deliver/budget';
import {
  IMAGE_CONFIG_SECTION,
  imageConfigSection,
  resolveImageLimits,
  type ImageConfig,
} from './state/configSection';
import { createMediaPromptGate } from './deliver/intake';
import { createReadMediaFileTool } from './deliver/tool';

export interface CreateMediaProps {
  readonly workDir: string;
  readonly store: MediaStore;
  readonly cache: MediaUploadCache;
  readonly host?: OsHost;
  readonly originalsDir?: string;
}

export function createMedia(props: CreateMediaProps): FeatureSpec {
  return createFeature('media', {
    app() {
      useConfigSection(imageConfigSection);
    },
    agent() {
      const agent = useAgent();
      const config = useInject(ConfigRef);
      const limits = () =>
        resolveImageLimits(
          config.value?.get<ImageConfig>(IMAGE_CONFIG_SECTION) ?? {},
        );
      const contributed = useCollection(Providers);
      useMediaLower({
        source: props.store,
        cache: props.cache,
        providers: () => contributed.value.map((item) => item.provider),
      });
      useLlmRecovery(createMediaDegradeRecovery());
      useAgentTools(
        createReadMediaFileTool({
          store: props.store,
          workDir: props.workDir,
          host: props.host,
          agent,
          limits,
        }),
      );
      usePromptGate(
        createMediaPromptGate({
          store: props.store,
          limits,
          originalsDir: props.originalsDir,
          fs: props.host?.fs,
        }),
      );
      useMessageResolver(createMediaBudgetResolver());
    },
  });
}
