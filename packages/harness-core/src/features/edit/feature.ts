import { createFeature, useAgentTools, type FeatureSpec } from '@moonshot-ai/agent-core';

import type { OsHost } from '#/features/os/host/index';

import { createEditTool, type CreateEditToolProps } from './tool';

export type CreateEditProps = Omit<CreateEditToolProps, 'host'> & { readonly host?: OsHost };

export function createEdit(props: CreateEditProps): FeatureSpec {
  return createFeature('edit', {
    agent() {
      const host = props.host;
      if (host === undefined) return;
      useAgentTools(createEditTool({ ...props, host }));
    },
  });
}
