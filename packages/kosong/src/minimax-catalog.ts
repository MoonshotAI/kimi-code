import type { Catalog, CatalogModelEntry } from './catalog';

const CURRENT_TEXT_MODEL = /^(?:minimax(?:ai)?\/)?minimax-(?:m3\.1-flash|m3)(?::free|-free)?$/i;
const MINIMAX_TEXT_MODEL = /^(?:minimax(?:ai)?\/)?minimax-(?:m\d|text-)/i;

/** Apply release defaults only to the public catalog, never a custom registry or saved config. */
export function withCurrentMiniMaxModels(catalog: Catalog): Catalog {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, provider]) => {
      if (provider.models === undefined) return [key, provider];
      const models = Object.fromEntries(
        Object.entries(provider.models ?? {}).filter(([id, model]) => {
          const modelId = model.id ?? id;
          if (model.modalities?.output && !model.modalities.output.includes('text')) return true;
          return !MINIMAX_TEXT_MODEL.test(modelId) || CURRENT_TEXT_MODEL.test(modelId);
        }),
      );
      // Gateway model IDs and metadata belong to that gateway. Only official direct
      // providers receive the documented direct models when the catalog is stale.
      if (
        (provider.id === 'minimax' || provider.id === 'minimax-cn') &&
        /^https:\/\/api\.(?:minimax\.io|minimaxi\.com)(?:\/|$)/.test(provider.api ?? '')
      ) {
        const current: Record<string, CatalogModelEntry> = {};
        for (const id of ['MiniMax-M3.1-Flash', 'MiniMax-M3']) {
          const existing = Object.values(models).find((model) => model.id === id) ?? models[id];
          current[id] = {
            ...existing,
            id,
            name: id,
            tool_call: true,
            reasoning: true,
            modalities: { input: ['text', 'image', 'video'], output: ['text'] },
            limit: {
              ...existing?.limit,
              context: 1_000_000,
              ...(id === 'MiniMax-M3.1-Flash' ? { output: 524_288 } : {}),
            },
          };
        }
        for (const [id, model] of Object.entries(models)) {
          if (
            !MINIMAX_TEXT_MODEL.test(model.id ?? id) ||
            (model.modalities?.output && !model.modalities.output.includes('text'))
          ) {
            current[id] = model;
          }
        }
        return [key, { ...provider, models: current }];
      }
      // Reorder only MiniMax slots, preserving unrelated gateway defaults.
      const entries = Object.entries(models);
      const current = entries.filter(([id, model]) => CURRENT_TEXT_MODEL.test(model.id ?? id));
      current.sort(([a, ma], [b, mb]) =>
        Number(/m3\.1-flash/i.test(mb.id ?? b)) - Number(/m3\.1-flash/i.test(ma.id ?? a)),
      );
      let index = 0;
      const sorted = entries.map((entry) =>
        CURRENT_TEXT_MODEL.test(entry[1].id ?? entry[0]) ? current[index++]! : entry,
      );
      return [key, { ...provider, models: Object.fromEntries(sorted) }];
    }),
  );
}
