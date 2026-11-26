import { computed, inject, watch, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall, ToolStatus } from '@moonshot-ai/app-core/client/types';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { normalizeToolName } from '@moonshot-ai/app-core/lib';
import { useHistoryState } from '../historyState';
import { toolLabel, toolSummary } from '../../lib/toolMeta';
import { argFallbackText, parseArgRecord } from './toolArgs';

export interface ToolCardProps {
  tool: ToolCall;
  mobile?: boolean;
}

export function useToolCard(props: ToolCardProps) {
  const i18n = useI18n();
  const t = i18n.t as (key: string, params?: Record<string, unknown> | number, plural?: number) => string;
  const te = (key: string): boolean => i18n.te(key);
  const panelApi = inject(panelApiKey, undefined);
  const status = computed<ToolStatus>(() => props.tool.status);
  const kind = computed(() => normalizeToolName(props.tool.name));
  const args = computed(() => parseArgRecord(props.tool.arg));
  const argText = computed(() => argFallbackText(props.tool.arg));
  const toolNameLabel = computed(() => toolLabel(props.tool.name));
  const label = computed(() => toolLabel(props.tool.name, props.tool.arg));
  const summary = computed(() => toolSummary(props.tool.name, props.tool.arg));
  const summaryFull = computed(() => toolSummary(props.tool.name, props.tool.arg, true));
  const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);

  return { t, te, panelApi, status, kind, args, argText, toolNameLabel, label, toolLabel, summary, summaryFull, hasOutput };
}

export function useToolCardExpansion(props: ToolCardProps, canExpand: ComputedRef<boolean>) {
  const open = useHistoryState(`tool:${props.tool.id}:open`, props.tool.defaultExpanded === true && canExpand.value);

  watch(
    () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status, props.tool.name] as const,
    () => {
      if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
    },
  );

  return { open };
}
