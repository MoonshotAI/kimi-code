import { createFeature, useAgentTools, type FeatureSpec } from '@moonshot-ai/agent-core';

import { createEditTool, type CreateEditToolProps } from './tool';

export type CreateEditProps = CreateEditToolProps;

export function createEdit(props: CreateEditProps): FeatureSpec {
  return createFeature('edit', {
    agent() {
      useAgentTools(createEditTool(props));
    },
  });
}
