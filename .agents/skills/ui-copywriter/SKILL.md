---
name: ui-copywriter
description: >-
  Write, optimize, or translate UI copy and localization text for Chinese and
  English interfaces. Use when the user needs interface copywriting,
  UI text translation, terminology consistency checks, localization reviews,
  or UX writing for software products.
---

# UI Copywriter & Localization Expert

## Workflow

1. **Identify the task type** from the user's request:
   - **Write/Optimize CN**: Read `references/core-principles.md`, `references/phrasing-rules.md`, `references/sentence-patterns.md`, `references/punctuation.md`, `references/style-guide.md`, `references/numbers-and-units.md`, `references/terminology.md`, `references/writing-patterns.md`
   - **Write/Optimize EN**: Read `references/core-principles.md`, `references/phrasing-rules.md`, `references/sentence-patterns.md`, `references/punctuation.md`, `references/style-guide.md`, `references/numbers-and-units.md`, `references/abbreviations.md`, `references/terminology.md`, `references/writing-patterns.md`, `references/linguistic-logic.md`
   - **Translate (CN↔EN)**: Read all reference files in `references/`
   - **Terminology check only**: Read `references/terminology.md`

2. **Produce the copy** following the loaded references exactly.
   - **If the user provides existing bilingual copy**: Treat the Chinese as the source of truth. Do NOT mechanically mirror the existing English. Instead, rewrite the English from scratch based on the Chinese meaning, following all English UX rules (sentence case, contractions, direct phrasing, no redundant pronouns).

3. **Validate the final copy** with the checker (run from the skill directory, once per language):
   ```
   python3 scripts/validate_copy.py '<CN text>'
   python3 scripts/validate_copy.py '<EN text>'
   ```
   Fix all reported issues before responding. The script only enforces mechanical rules (forbidden terms from `terminology.md`, punctuation width, CJK spacing, dialog question marks, trailing periods); judgment calls stay with you.

4. **Append the Consistency Checklist** at the end of your response. Mark each item [x] or [ ].

## Hard Constraints (Do Not Violate)

<!-- This section is the always-applied summary. Each rule's canonical home is the
     referenced file — make rule edits there, not here, and keep the two in sync. -->

### Universal (Both Languages)

- Always use second person: "你" (CN) / "You" (EN). Never address as 您/亲/User/Dear — pronoun table: `references/core-principles.md`
- Never use absolute words: "永远" / "绝对" / "always" / "never" / "guarantee". ("must" is allowed for hard requirements, e.g. "Password must be at least 8 characters".)
- Never use double negatives in either language — `references/sentence-patterns.md` (Rule 4)
- Never use exclamatory sentences or exclamation marks (`!` / `！`) — `references/sentence-patterns.md` (Rule 3)
- Never use affirmative wording to guide negative actions — `references/sentence-patterns.md` (Rule 6)
- No question marks in dialog titles or descriptions. State the action directly (verb-object phrase): `删除此会话` / `Delete chat`, not `删除此会话？` / `Delete chat?` — `references/sentence-patterns.md` (§2)
- Do NOT invent terminology. Use exact terms from `references/terminology.md`
- Add a half-width space between CJK characters and English words or numbers — `references/style-guide.md` (§2)

### Periods (Both Languages)

Omit the final period in **all short UI copy** (buttons, titles, menus, list items, empty states, toasts, hover text, placeholders, dialog bodies, error messages) — even when the text contains two sentences; periods only separate sentences internally (`Upload failed. Please try again`). **Long explanatory paragraphs** (>15 words) keep full punctuation, including the final period. A CN "cause，action" pair joined by a full-width comma counts as one sentence (`上传失败，请重试`); its EN equivalent is usually two. Full tables: `references/punctuation.md` (§1)

### Chinese-Specific

- Use full-width punctuation (， 。 ：). Never use half-width punctuation in Chinese copy — `references/punctuation.md` (§2)
- Use only canonical character variants (登录 not 登陆, 账号 not 帐号, 请稍候 not 请稍后) — full table: `references/phrasing-rules.md` (§1, §3)
- Never use "是否" in confirmations.
- Reduce overuse of "请": "请点击" → "点击".
- Never use "TA" or "好友" — reference table: `references/core-principles.md`

### English-Specific

- Sentence case only: first word capitalized, rest lowercase. Never Title Case in buttons, titles, menus, or dialogs. Exceptions: branded names in `references/terminology.md` (Kimi+, Deep Research, Saved Prompts) and `App` (`Open App`, `Desktop App`) — details: `references/style-guide.md` (§1)
- Use half-width punctuation (. , :). Never use full-width punctuation in English copy — `references/punctuation.md` (§2)
- Use "Please" sparingly in buttons and toasts.
- Prefer contractions (You're, We'll, Can't, Didn't) for a friendly tone, except in legal text or very formal contexts — `references/abbreviations.md`
- Use direct verb-object phrases for confirmations. Avoid "Are you sure..." or "Do you want to..." padding — `references/sentence-patterns.md` (Rule 5)

## Output Format

For each piece of copy, provide:

```
CN: [Chinese copy]
EN: [English copy]
```

Then append:

```
---
Consistency Checklist:
[ ] CN: Correct pronouns (你/我/他/朋友/用户)?
[ ] EN: Correct pronoun (You, not User/Dear)?
[ ] CN: No forbidden variants (登陆/请稍后/帐号/查阅/查找/增加/发表)?
[ ] EN: Sentence case applied (branded names and "App" keep their capitals)?
[ ] CJK spacing (盘古之白) correct?
[ ] CN: Full-width punctuation?
[ ] EN: Half-width punctuation?
[ ] Periods: short copy omits the final period, even with two sentences (periods only between sentences)?
[ ] Long paragraphs (>15 words) keep full punctuation, including the final period?
[ ] Terminology matches reference table?
[ ] No absolute words / double negatives?
[ ] No exclamation marks?
[ ] CN: No "是否" in confirmations?
[ ] Dialogs: verb-object phrase, no question mark?
[ ] EN: No "Are you sure..." padding in confirmations?
[ ] No affirmative wording for negative actions?
[ ] EN: Contractions preferred for friendly tone (where appropriate)?
[ ] EN: {n} placeholders always plural (no "chat(s)", no singular branching)?
[ ] Branded names keep capitalization in running text (Delete this Saved Prompt)?
```
