export function withQuestionIds<TPayload>(payload: TPayload): TPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const raw = (payload as { questions?: unknown })['questions'];
  if (!Array.isArray(raw)) return payload;
  let changed = false;
  const questions = raw.map((value, questionIndex) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    let item = value as { [key: string]: unknown };
    if (typeof item['id'] !== 'string') {
      item = { ...item, id: `q_${questionIndex}` };
      changed = true;
    }
    const optionsRaw = item['options'];
    if (Array.isArray(optionsRaw)) {
      let optionsChanged = false;
      const options = optionsRaw.map((option, optionIndex) => {
        if (option === null || typeof option !== 'object' || Array.isArray(option)) return option;
        const record = option as { [key: string]: unknown };
        if (typeof record['id'] === 'string') return record;
        optionsChanged = true;
        return { ...record, id: `opt_${questionIndex}_${optionIndex}` };
      });
      if (optionsChanged) {
        item = { ...item, options };
        changed = true;
      }
    }
    if (item['allow_other'] === undefined) {
      item = { ...item, allow_other: true };
      changed = true;
    }
    return item;
  });
  if (!changed) return payload;
  return { ...(payload as Record<string, unknown>), questions } as TPayload;
}
