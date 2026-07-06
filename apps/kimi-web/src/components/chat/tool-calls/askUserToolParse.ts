// Pure parsers for the AskUserQuestion tool card. Kept separate from the SFC so
// the index-zip / id-decode logic is unit-testable without a DOM.
//
// Wire shape (from agent-core SCHEMAS §6.4):
//   tool.arg      : JSON { questions: [{ question, header, options[{label,description}], multi_select }] }
//                   Input questions carry NO id — order === broker order.
//   tool.output[0]: on a successful answer, JSON { answers: Record<qid, string|true>, note? }
//                   qid  = `q_<index>`; value = `opt_<q>_<o>` (single),
//                   `opt_<q>_<o>,opt_<q>_<o>` (multi, comma-joined), free-text
//                   (Other), or `opt_…,<text>` (multi+Other). skipped → omitted.
//                   Dismissed → { answers: {}, note }.
//                 : on a background launch, plain text (`task_id: …\nstatus: …`);
//                   on an error (e.g. unsupported interactive questions), plain
//                   text. Those are NOT the answer payload and must be shown raw.

export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect: boolean;
}

export interface AskOutput {
  /** True only when the output parsed as the answer payload (`{ answers: {...} }`).
   *  False for background / error plain-text output, which the card must show raw. */
  recognized: boolean;
  answers: Record<string, string | true>;
  note: string;
}

export interface Resolved {
  /** Option indices picked for this question. */
  selected: Set<number>;
  /** Free-text "Other" segment, when the answer carried one. */
  otherText: string;
  /** The flattened value was the literal `true` — answered, but no concrete
      option to echo back onto the list. */
  indeterminate: boolean;
}

export function parseAskInput(arg: string): AskQuestion[] {
  if (!arg) return [];
  try {
    const obj = JSON.parse(arg) as Record<string, unknown>;
    const raw = obj['questions'];
    if (!Array.isArray(raw)) return [];
    const out: AskQuestion[] = [];
    for (const q of raw) {
      if (!q || typeof q !== 'object') continue;
      const qr = q as Record<string, unknown>;
      const opts: AskOption[] = Array.isArray(qr['options'])
        ? (qr['options'] as unknown[]).map(o => {
            const or = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
            return {
              label: typeof or['label'] === 'string' ? or['label'] : '',
              description: typeof or['description'] === 'string' ? or['description'] : '',
            };
          })
        : [];
      out.push({
        question: typeof qr['question'] === 'string' ? qr['question'] : '',
        header: typeof qr['header'] === 'string' ? qr['header'] : '',
        options: opts,
        multiSelect: qr['multi_select'] === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

const EMPTY: AskOutput = { recognized: false, answers: {}, note: '' };

export function parseAskOutput(output: string[] | undefined): AskOutput {
  const line = output?.[0];
  if (!line) return EMPTY;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    // Plain-text output (background `task_id/status`, error message) — show raw.
    return EMPTY;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return EMPTY;
  const raw = (obj as Record<string, unknown>)['answers'];
  // The answer payload is the only shape we render specially; anything else
  // (a JSON object without an `answers` record) falls back to raw output.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY;
  const answers: Record<string, string | true> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') answers[k] = v;
    else if (v === true) answers[k] = true;
  }
  return {
    recognized: true,
    answers,
    note: typeof (obj as Record<string, unknown>)['note'] === 'string'
      ? ((obj as Record<string, unknown>)['note'] as string)
      : '',
  };
}

const OPT_ID = /^opt_\d+_(\d+)$/;

/** Decode one question's flattened answer into picked option indices plus any
 *  free-text "Other" segment. Option ids carry their own index, so this is
 *  exact rather than a label match; non-`opt_` segments are treated as the
 *  Other text (joined back with `,` in case the free text itself contained one). */
export function resolveAnswer(value: string | true | undefined): Resolved {
  if (value === undefined) return { selected: new Set(), otherText: '', indeterminate: false };
  if (value === true) return { selected: new Set(), otherText: '', indeterminate: true };
  const selected = new Set<number>();
  const others: string[] = [];
  for (const seg of value.split(',')) {
    const m = OPT_ID.exec(seg);
    if (m) selected.add(Number(m[1]));
    else if (seg.length > 0) others.push(seg);
  }
  return { selected, otherText: others.join(','), indeterminate: false };
}
