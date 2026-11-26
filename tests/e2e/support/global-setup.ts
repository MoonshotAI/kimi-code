import type { FullConfig } from '@playwright/test';

import { chooseWebPortBase } from '../surfaces/web-port';

export default function globalSetup(config: FullConfig): void {
  chooseWebPortBase(config.workers);
}
