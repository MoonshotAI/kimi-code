import { useCallback, useEffect, useMemo, useState } from "react";
import { IconChartBar, IconLoader2, IconRefresh } from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import { bridge, Events, type PlanUsageResult } from "@/services";
import { getModelById, useSettingsStore } from "@/stores";
import type { PlanUsageMetric, UIStreamEvent } from "shared/types";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const MANAGED_KIMI_CODE_PROVIDER = "managed:kimi-code";
const REFRESH_INTERVAL_MS = 60_000;

type UsageViewState = PlanUsageResult | { kind: "loading" };

function metricTone(percentLeft: number): string {
  if (percentLeft <= 5) return "text-destructive";
  if (percentLeft <= 20) return "text-amber-700 dark:text-amber-300";
  return "text-foreground";
}

function metricState(percentLeft: number): "Critical" | "Low" | null {
  if (percentLeft <= 5) return "Critical";
  if (percentLeft <= 20) return "Low";
  return null;
}

function formatReset(resetAt: string | undefined): string {
  if (resetAt === undefined) return "Reset time unavailable";
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}`;
}

function UsageMetricRow({ metric, fallbackLabel }: { metric: PlanUsageMetric | undefined; fallbackLabel: string }) {
  if (metric === undefined) {
    return (
      <div className="space-y-1" aria-label="Usage limit unavailable">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">{fallbackLabel}</span>
          <span>—</span>
        </div>
      </div>
    );
  }

  const state = metricState(metric.percentLeft);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{metric.label}</span>
        <span className={cn("tabular-nums", metricTone(metric.percentLeft))}>
          {metric.percentLeft}% left{state === null ? "" : ` · ${state}`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${metric.label} usage remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={metric.percentLeft}
        aria-valuetext={`${metric.percentLeft}% left${state === null ? "" : `, ${state}`}`}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full bg-primary motion-reduce:transition-none",
            metric.percentLeft <= 20 && "bg-amber-700 dark:bg-amber-300",
            metric.percentLeft <= 5 && "bg-destructive",
          )}
          style={{ width: `${metric.percentLeft}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground">{formatReset(metric.resetAt)}</div>
    </div>
  );
}

export function UsageStatus() {
  const { currentModel, models, isLoggedIn } = useSettingsStore();
  const provider = getModelById(models, currentModel)?.provider;
  const enabled = isLoggedIn && provider === MANAGED_KIMI_CODE_PROVIDER;
  const [state, setState] = useState<UsageViewState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (force = false) => {
    if (!enabled) return;
    setRefreshing(true);
    try {
      setState(await bridge.getPlanUsage(MANAGED_KIMI_CODE_PROVIDER, force));
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRefreshing(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    setState({ kind: "loading" });
    void refresh();

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribe = bridge.on<UIStreamEvent>(Events.StreamEvent, (event) => {
      if (event.type === "stream_complete") void refresh();
    });
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribe();
    };
  }, [enabled, refresh]);

  const accessibleLabel = useMemo(() => {
    if (state.kind === "loading") return "Kimi plan usage loading";
    if (state.kind === "error" || state.kind === "unavailable") return `Kimi plan usage unavailable: ${state.message}`;
    const metrics = [state.overall, state.fiveHour]
      .filter((metric): metric is PlanUsageMetric => metric !== undefined)
      .map((metric) => `${metric.label} ${metric.percentLeft}% left`)
      .join(", ");
    return `Kimi plan usage: ${metrics}${state.stale ? ", stale" : ""}`;
  }, [state]);

  if (!enabled) return null;

  const available = state.kind === "ok";
  return (
    <Popover onOpenChange={(open) => open && void refresh()}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="order-3 ml-auto h-6 min-w-0 gap-1.5 border border-border/40 px-2! text-[10px] @max-[500px]:basis-full @max-[500px]:justify-center @max-[500px]:ml-0"
          aria-label={accessibleLabel}
        >
          {state.kind === "loading" ? (
            <>
              <IconLoader2 className="size-3 animate-spin motion-reduce:animate-none" />
              <span>Usage…</span>
            </>
          ) : available ? (
            <>
              <IconChartBar className="size-3 opacity-70" />
              <span className={cn("tabular-nums", state.overall && metricTone(state.overall.percentLeft))}>
                {state.overall?.label ?? "Overall"} {state.overall ? `${state.overall.percentLeft}%` : "—"}
                <span className="@max-[400px]:hidden"> left</span>
              </span>
              <span aria-hidden="true" className="text-border">·</span>
              <span className={cn("tabular-nums", state.fiveHour && metricTone(state.fiveHour.percentLeft))}>
                5h {state.fiveHour ? `${state.fiveHour.percentLeft}%` : "—"}
                <span className="@max-[400px]:hidden"> left</span>
              </span>
              {state.stale && <span className="text-amber-700 dark:text-amber-300">Stale</span>}
            </>
          ) : (
            <>
              <IconChartBar className="size-3 opacity-70" />
              <span>Usage unavailable</span>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-1rem)] space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Plan usage</div>
            <div className="text-[10px] text-muted-foreground">Remaining quota</div>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh plan usage"
            disabled={refreshing}
            onClick={() => void refresh(true)}
          >
            <IconRefresh className={cn("size-3.5", refreshing && "animate-spin motion-reduce:animate-none")} />
          </Button>
        </div>

        {available ? (
          <>
            <UsageMetricRow metric={state.overall} fallbackLabel="Overall" />
            <UsageMetricRow metric={state.fiveHour} fallbackLabel="5h" />
            {state.warning && <div role="status" className="text-[10px] text-amber-700 dark:text-amber-300">{state.warning}</div>}
            <div className="text-[10px] text-muted-foreground">
              Updated {new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(state.fetchedAt))}
            </div>
          </>
        ) : state.kind === "loading" ? (
          <div role="status" className="text-xs text-muted-foreground">Loading plan usage…</div>
        ) : (
          <div role="alert" className="space-y-2 text-xs">
            <div className="text-destructive">{state.message}</div>
            <Button size="sm" onClick={() => void refresh(true)} disabled={refreshing}>
              Retry
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
