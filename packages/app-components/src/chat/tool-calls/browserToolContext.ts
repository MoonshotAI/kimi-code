import type { ComputedRef, InjectionKey } from 'vue';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import type { BrowserToolContext } from './browserToolPresentation';

export const BrowserToolContextKey: InjectionKey<ComputedRef<ReadonlyMap<ToolCall, BrowserToolContext>>> =
  Symbol('BrowserToolContext');
