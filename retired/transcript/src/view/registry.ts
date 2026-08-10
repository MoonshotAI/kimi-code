/**
 * L4 view layer — framework-free renderer registry.
 *
 * The schema only says *what* something is; how it renders is decided here,
 * by key dispatch:
 *  - tool frames:       `frame.view ?? frame.name`   → toolRenderers
 *  - turn origins:      `origin.kind`                → inputRenderers
 *  - timeline markers:  `marker.marker`              → markerRenderers
 *  - task entities:     `task.kind` (+ `detached`)    → taskRenderers
 *
 * `C` is the host framework's component type (Vue component, React component,
 * ink renderer, …). This package never imports a UI framework; clients
 * instantiate `ViewRegistry<TheirComponent>` and register their own widgets.
 */

import type { ToolCallFrame } from '../model/frame';
import type { TranscriptTask } from '../model/task';
import type { TurnOrigin } from '../model/turn';

export interface ToolViewContext {
  readonly frame: ToolCallFrame;
  readonly task?: TranscriptTask;
}

export interface InputViewContext {
  readonly origin: TurnOrigin;
  readonly prompt?: string;
}

export interface MarkerViewContext {
  readonly marker: string;
  readonly payload?: unknown;
}

export interface ViewRegistryOptions<C> {
  readonly fallbackTool?: C;
}

export class ViewRegistry<C = unknown> {
  readonly #toolRenderers = new Map<string, C>();
  readonly #inputRenderers = new Map<string, C>();
  readonly #markerRenderers = new Map<string, C>();
  readonly #fallbackTool: C | undefined;

  constructor(options: ViewRegistryOptions<C> = {}) {
    this.#fallbackTool = options.fallbackTool;
  }

  /** Key: view hint or tool name (`frame.view ?? frame.name`, lower-cased). */
  registerTool(key: string, renderer: C): this {
    this.#toolRenderers.set(key.toLowerCase(), renderer);
    return this;
  }

  /** Key: origin kind ('user' | 'cron' | 'task' | …). */
  registerInput(originKind: string, renderer: C): this {
    this.#inputRenderers.set(originKind, renderer);
    return this;
  }

  /** Key: marker key ('compaction' | 'goal' | 'notice' | …). */
  registerMarker(marker: string, renderer: C): this {
    this.#markerRenderers.set(marker, renderer);
    return this;
  }

  resolveTool(frame: ToolCallFrame): C | undefined {
    const key = (frame.view ?? frame.name).toLowerCase();
    return this.#toolRenderers.get(key) ?? this.#fallbackTool;
  }

  resolveInput(origin: TurnOrigin): C | undefined {
    return this.#inputRenderers.get(origin.kind);
  }

  resolveMarker(marker: string): C | undefined {
    return this.#markerRenderers.get(marker);
  }
}
