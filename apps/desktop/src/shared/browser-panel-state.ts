import type { BrowserPanelSession } from '@moonshot-ai/app-core/browser-panel-state';
import { Type } from 'typebox';

import { BrowserIdSchema } from './browser-schema';
import { defineBrowserValidator } from './browser-validator';

const Title = Type.String({ maxLength: 512 });

export const BrowserPanelSessionsSchema = Type.Array(Type.Object({
  sessionId: BrowserIdSchema,
  tabs: Type.Array(Type.Object({
    browserId: BrowserIdSchema,
    title: Type.Optional(Title),
    customTitle: Type.Optional(Title),
  })),
  activeBrowserId: Type.Union([BrowserIdSchema, Type.Null()]),
  visible: Type.Boolean(),
}));

export const browserValidators = {
  BrowserPanelSessionsSchema: defineBrowserValidator(BrowserPanelSessionsSchema),
};

const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export function asBrowserPanelSessions(value: unknown): BrowserPanelSession[] | null {
  const parsed = browserValidators.BrowserPanelSessionsSchema.Parse(value);
  if (parsed === null) return null;
  const sessions = new Set<string>();
  const browsers = new Set<string>();
  const result: BrowserPanelSession[] = [];
  for (const item of parsed) {
    if (RESERVED_IDS.has(item.sessionId) || sessions.has(item.sessionId)) return null;
    sessions.add(item.sessionId);
    const tabs: BrowserPanelSession['tabs'] = [];
    for (const tab of item.tabs) {
      if (RESERVED_IDS.has(tab.browserId) || browsers.has(tab.browserId)) return null;
      browsers.add(tab.browserId);
      tabs.push({
        browserId: tab.browserId,
        ...(tab.title === undefined ? {} : { title: tab.title }),
        ...(tab.customTitle === undefined ? {} : { customTitle: tab.customTitle }),
      });
    }
    if (item.activeBrowserId !== null && !tabs.some((tab) => tab.browserId === item.activeBrowserId)) return null;
    result.push({ sessionId: item.sessionId, tabs, activeBrowserId: item.activeBrowserId, visible: item.visible });
  }
  return result;
}
