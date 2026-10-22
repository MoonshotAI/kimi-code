import { createFeature } from '#/app/index';
import type { Feature } from '#/app/index';

import { useAgentTools } from '#/runtime/index';

import { createEditTool } from './tool';
import type { CreateEditToolProps } from './tool';

export type CreateEditProps = CreateEditToolProps;

export function createEdit(props: CreateEditProps): Feature<void> {
  return createFeature('edit', {
    agent() {
      useAgentTools(createEditTool(props));
    },
  });
}
