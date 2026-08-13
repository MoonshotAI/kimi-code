# Deep Linguistic Logic (CN vs EN)

## 1. Topic-Prominence vs Subject-Prominence

- **Chinese**: Topic-first, subject often omitted.
  - Logic: [Object] + [State/Action]
  - Example: "文件已保存" (Topic: 文件 | State: 已保存)
- **English**: Requires explicit subject-verb structure or passive voice.
  - Logic: [Subject] + [Verb] + [Object]
  - Example: "File saved" (passive implied)

**Rule**: When translating EN→CN, reconstruct sentence order. Do NOT force-add subjects like "你" or "系统" unless emphasizing responsibility.

## 2. Aspect vs Tense

- **Chinese**: No tense inflection. Uses aspect markers (了, 着, 过).
  - Example: "正在保存…" (progressive) / "保存成功" (perfective)
- **English**: Verb inflection expresses time.
  - Example: "Saving…" (present participle) / "Saved" (past participle)

**Rule**: For status copy in English, use participle forms (Verb-ing / Verb-ed), not full sentences.
- Bad: "Save is successful"
- Good: "Saved"

## 3. Macro-to-Micro vs Micro-to-Macro

- **Chinese**: Macro → Micro (big to small, general to specific)
  - Date: 年 → 月 → 日
  - Name: 姓 → 名
  - UI: Filters go category first, then sub-category
- **English**: Micro → Macro (small to big, specific to general)
  - Date: Day → Month → Year
  - Name: First Name → Last Name
  - Address: Street number first, country last

**Rule**: Adjust information ordering for dates, names, addresses, and breadcrumb navigation based on target language.
