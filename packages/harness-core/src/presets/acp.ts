import {
  acpStdioStreams,
  createAcp,
  type AcpHostOptions,
  type AcpStreamPair,
} from '#/feature-acp/index';

import { createDefaultApp, type CreateDefaultAppOptions, type DefaultApp } from './base';

export interface CreateDefaultAcpOptions extends CreateDefaultAppOptions, AcpHostOptions {
  readonly streams?: AcpStreamPair;
}

export function createDefaultAcp(options: CreateDefaultAcpOptions = {}): DefaultApp {
  const base = createDefaultApp(options);
  base.app.features.add(
    createAcp({ ...options, streams: options.streams ?? acpStdioStreams() }),
  );
  return base;
}
