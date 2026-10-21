import { createFeature, useMessageAppending, type Feature } from '#/app/index';
import type { BlobCache } from '@moonshot-ai/agent-core/blob/index';
import { useInject } from '#/kernel/index';
import { createMediaDegradeRecovery } from '@moonshot-ai/agent-core/llm/builtin/policy/media-degrade';
import {
  createBlobUploadCache,
  createStoreRefResolver,
  type Placeholder,
  type UploadCache,
} from '@moonshot-ai/agent-core/llm/builtin/policy/store-ref/index';
import type { LlmModelSpec, UploadedMedia } from '@moonshot-ai/agent-core/llm/request';

import { ConfigRef, useConfigSection } from '#/features/config/index';
import {
  KimiFileRegistryRef,
  type KimiFileRegistry,
} from '#/features/files/index';
import type { OsHost } from '#/features/os/host/index';
import {
  useAgentRuntime,
  useAgentTools,
  useLlmRecovery,
  useMessageResolver,
} from '#/runtime/index';

import { createMediaIntake } from './deliver/intake';
import { createReadMediaFileTool } from './deliver/tool';
import {
  IMAGE_CONFIG_SECTION,
  imageConfigSection,
  resolveImageLimits,
  type ImageConfig,
} from './state/configSection';
import type { MediaContent } from './store';

export interface CreateMediaProps {
  readonly workDir: string;
  readonly host?: OsHost;
  readonly originalsDir?: string;
  readonly cache?: BlobCache;
  readonly placeholder?: Placeholder;
}

function memoryUploadCache(): UploadCache {
  const entries = new Map<string, UploadedMedia>();
  return {
    get: (ref, accountKey) => Promise.resolve(entries.get(`${ref}\0${accountKey}`)),
    put: (ref, accountKey, uploaded) => {
      entries.set(`${ref}\0${accountKey}`, uploaded);
      return Promise.resolve();
    },
  };
}

export function createMedia(props: CreateMediaProps): Feature {
  return createFeature('media', {
    app() {
      useConfigSection(imageConfigSection);
    },
    agent() {
      const runtime = useAgentRuntime();
      const registryRef = useInject(KimiFileRegistryRef);
      const registry = (): KimiFileRegistry => {
        const current = registryRef.value;
        if (current === undefined) throw new Error('media feature requires the files feature');
        return current;
      };
      const config = useInject(ConfigRef);
      const limits = () =>
        resolveImageLimits(config.value?.get<ImageConfig>(IMAGE_CONFIG_SECTION) ?? {});
      const putMedia = async (content: MediaContent): Promise<string> =>
        (await registry().put(content)).ref;
      const modelSpec = (): LlmModelSpec | undefined => {
        const request = runtime.requester?.request({ content: { messages: [] } });
        return request?.model.spec;
      };
      useMessageResolver(
        createStoreRefResolver({
          store: { get: (reference) => registry().get(reference) },
          cache:
            props.cache === undefined
              ? memoryUploadCache()
              : createBlobUploadCache(props.cache),
          placeholder: props.placeholder,
        }),
      );
      useLlmRecovery(createMediaDegradeRecovery());
      useAgentTools(
        createReadMediaFileTool({
          workDir: props.workDir,
          putMedia,
          modelSpec,
          limits,
          host: props.host,
          files: registry,
        }),
      );
      useMessageAppending(
        createMediaIntake({
          putMedia,
          materialize: async (reference) => {
            await registry().materialize(reference);
          },
          limits,
          originalsDir: props.originalsDir,
          fs: props.host?.fs,
        }),
      );
    },
  });
}
