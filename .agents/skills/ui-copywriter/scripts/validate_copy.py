#!/usr/bin/env python3
"""Validate UI copy against references/terminology.md and the skill's style rules.

Usage: validate_copy.py '<text>'
Checks are heuristics — treat the output as review prompts, not hard errors.
"""

import re
import sys
from pathlib import Path

TERMINOLOGY = Path(__file__).resolve().parent.parent / "references" / "terminology.md"


def load_forbidden_terms() -> list[str]:
    """Pull 'Never use "X"' / 'Do NOT use "X"' / 'Avoid "X"' terms from terminology.md notes.

    Scoped prohibitions ("Avoid X unless ...", "Do NOT use X for ...") are skipped —
    they need human judgment.
    """
    terms = []
    if not TERMINOLOGY.exists():
        return terms
    for line in TERMINOLOGY.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        # Capture slash/顿号-joined quote clusters: Never use "A" / "B" / "C"
        # loads A, B and C. Scope window is a lookahead so nothing is consumed early.
        for m in re.finditer(r'(?:Never use|Do NOT use|Avoid)\s+("(?:[^"]+)"(?:\s*[/、]\s*"[^"]+")*)(?=([^"|]{0,30}))', line):
            cluster, trailing = m.group(1), m.group(2)
            if " unless " in trailing or re.match(r"\s+for\s", trailing):
                continue
            terms.extend(re.findall(r'"([^"]+)"', cluster))
    return terms


def has_cjk(text: str) -> bool:
    return any("一" <= c <= "鿿" for c in text)


def validate(text: str) -> list[str]:
    issues: list[str] = []

    def flag(msg: str) -> None:
        if msg not in issues:
            issues.append(msg)

    lower = text.lower()
    stripped = text.strip()

    # ── Universal ──

    if "!" in text or "！" in text:
        flag("Exclamation mark detected (avoid exclamatory sentences)")

    # Forbidden terms declared in terminology.md (auto-synced)
    for term in load_forbidden_terms():
        if has_cjk(term):
            if term in text:
                flag(f"Forbidden term from terminology.md: '{term}'")
        elif re.search(r"\b" + re.escape(term) + r"\b", text, re.IGNORECASE):
            flag(f"Forbidden term from terminology.md: '{term}'")

    # ── Chinese-Specific ──

    # Hardcoded set: terms not declared in terminology.md notes
    # (登陆/帐号/对话/社区/笔记/回忆/好友/清除/查阅/查找/增加/发表 are auto-loaded from terminology.md)
    for word in ("您", "亲", "粉丝", "请稍后"):
        if word in text:
            flag(f"CN Forbidden term: '{word}'")
    if re.search(r"\bTA\b", text):  # \bTA\b avoids matching META/DATA/TARGET
        flag("CN Forbidden term: 'TA'")

    # Absolute terms (CN)
    for word in ("永远", "绝对"):
        if word in text:
            flag(f"CN Absolute term (avoid): '{word}'")

    # Double negatives (CN)
    for pat in ("不是不", "不能不", "没有不", "不得不", "非不"):
        if pat in text:
            flag(f"CN Double negative: '{pat}'")

    # "是否" — confirmations state the action directly; no longer tied to question marks
    if "是否" in text:
        flag("CN: '是否' detected — confirmations state the action directly (删除此会话), no 是否")

    # 永久 in deletion copy — 不可恢复 already conveys it
    if re.search(r"永久.{0,4}(删除|删掉|清除|移除)", text):
        flag("CN: 删除确认文案不提「永久」—「不可恢复」已足够（这条会话将被删除，不可恢复及撤销）")

    # Dialog question mark (CN): verb-led line ending with ？
    for line in text.splitlines():
        if re.search(r"^\s*(删除|退出|修改|注销|清空|保存|更换|移除|停用).{0,20}？\s*$", line):
            flag(f"CN Dialog question mark: '{line.strip()}' — dialogs use verb-object phrase, no ？")

    # Trailing 。 on short copy — short UI text omits the final period even with
    # multiple sentences; long paragraphs (>30 chars) keep full punctuation
    if stripped.endswith("。") and len(stripped) <= 30:
        flag("CN: trailing 。 — short UI copy omits the final period (periods only between sentences)")

    # Half-width punctuation adjacent to CJK
    if re.search(r"[一-鿿][,.;:?]", text) or re.search(r"[,.;:?][一-鿿]", text):
        flag("CN: half-width punctuation adjacent to Chinese — use full-width")

    # ── English-Specific ──

    # Forbidden English phrases
    for phrase in ("please click", "login success", "save is successful"):
        if phrase in lower:
            flag(f"EN Forbidden phrase: '{phrase}'")

    # "User" as address — allowed only in whitelisted generic references
    masked = lower.replace("user feedback", "")
    if re.search(r"\buser\b", masked):
        flag("EN: 'User' detected — address the user as 'You' ('User feedback' is allowed)")
    if re.search(r"\bdear\b", lower):
        flag("EN Forbidden phrase: 'dear'")

    # Absolute terms (EN)
    for word in ("always", "absolutely", "never", "guarantee"):
        if re.search(r"\b" + word + r"\b", lower):
            flag(f"EN Absolute term (avoid): '{word}'")

    # Double negatives (EN)
    for pat in (r"don't\s+not", r"cannot\s+not", r"no\s+not", r"never\s+not"):
        if re.search(pat, lower):
            flag(f"EN Double negative: matches '{pat}'")

    # "permanently" in deletion copy — "can't be recovered" already conveys it
    if re.search(r"\bpermanently\s+(?:delete|remove|erase|clear)\w*", lower):
        flag("EN: don't say 'permanently' in deletion copy — 'can't be recovered' already conveys it")

    # "Are you sure..." / "Do you want to..." padding
    if re.search(r"are\s+you\s+sure", lower) or re.search(r"do\s+you\s+want\s+to", lower):
        flag("EN: 'Are you sure...' / 'Do you want to...' padding — use direct verb-object phrase")

    # Dialog question mark (EN): verb-led line ending with ?
    for line in text.splitlines():
        if re.search(
            r"^\s*(Delete|Remove|Exit|Log out|Save|Discard|Change|Edit|Deactivate|Clear|Stop)\b.{0,40}\?\s*$",
            line,
            re.IGNORECASE,
        ):
            flag(f"EN Dialog question mark: '{line.strip()}' — dialogs use verb-object phrase, no ?")

    # Trailing period on short copy — short UI text omits the final period even
    # with two sentences; long paragraphs (>15 words) keep full punctuation
    if re.search(r"[a-zA-Z0-9)\]]\.$", stripped) and len(stripped.split()) <= 15:
        flag("EN: trailing period — short UI copy omits the final period (periods only between sentences)")

    # Brand casing (WiFi is auto-loaded from terminology.md's Never-use note)
    if re.search(r"\b(?:KIMI|kimi)\b", text):
        flag("Brand casing: use 'Kimi'")

    # Full-width punctuation in English copy
    en_chars = len(re.findall(r"[a-zA-Z]", text))
    cn_chars = len(re.findall(r"[一-鿿]", text))
    if en_chars > cn_chars and en_chars > 5:
        if "。" in text or "，" in text or "：" in text:
            flag("EN: full-width punctuation detected in English copy")

    # Sentence case check for standalone English
    for line in text.splitlines():
        line_stripped = line.strip()
        if not line_stripped:
            continue
        en_portion = re.sub(r"[^\x00-\x7F\s]", "", line_stripped).strip()
        if en_portion and len(en_portion) > 3:
            words = en_portion.split()
            if words:
                first = words[0]
                if first.isupper() and len(first) > 1 and first not in ("I", "OK", "AI", "PPT", "PDF", "APP", "CN", "EN"):
                    continue
                if first[0].islower() and first.lower() not in ("a", "an", "the", "in", "on", "to", "of"):
                    flag(f"EN Possible sentence case violation: '{en_portion[:40]}...'")

    # ── Mixed / CJK spacing (盘古之白) ──

    if re.search(r"[一-鿿][a-zA-Z0-9]", text):
        flag("Missing CJK spacing (Chinese char adjacent to EN/number)")
    if re.search(r"[a-zA-Z0-9][一-鿿]", text):
        flag("Missing CJK spacing (EN/number adjacent to Chinese char)")

    return issues


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: validate_copy.py '<text>'")
        sys.exit(1)

    text = sys.argv[1]
    issues = validate(text)
    if issues:
        print("Issues found:")
        for i in issues:
            print(f"  - {i}")
        sys.exit(1)
    else:
        print("Validation passed.")
