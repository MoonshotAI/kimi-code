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

  registerTool(key: string, renderer: C): this {
    this.#toolRenderers.set(key.toLowerCase(), renderer);
    return this;
  }

  registerInput(originKind: string, renderer: C): this {
    this.#inputRenderers.set(originKind, renderer);
    return this;
  }

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
