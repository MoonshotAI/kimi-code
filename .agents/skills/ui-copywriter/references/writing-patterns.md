# Writing Patterns by Scenario

## 1. Error Messages

Structure: Specific cause + Solution. Never say just "error".

Omit the final period in error messages, even with two sentences — periods only separate sentences internally.

| CN | EN |
|----|-----|
| 密码长度必须至少为 8 个字符 | Password must be at least 8 characters |
| 提交失败，请重试 | Submission failed. Please try again |

Note: CN "cause，action" pairs joined by a full-width comma are one sentence (no 。 at all); the EN equivalent is two sentences joined by an internal period, no final period.

## 2. Confirmation Dialogs

- **Title**: Verb-object phrase. **No question mark, no period.**
- **Body**: State the consequence (especially for irreversible actions). Omit periods for single-sentence body text. Don't say 永久 / "permanently" — 不可恢复 / "can't be recovered" already conveys it.
- **Buttons**: canonical table in `sentence-patterns.md` (§2 Button Actions) — right button reuses the verb from the title, left is usually 取消 / Cancel.

| | CN | EN |
|---|----|-----|
| Title | 删除此会话 | Delete chat |
| Body | 这条会话将被删除，不可恢复及撤销 | This chat will be deleted and can't be recovered |

## 3. Empty States

Structure: State description + Call to action.
**No period** — empty state text is typically a fragment.

| CN | EN |
|----|-----|
| 暂无收藏 | No favorites yet |
| 暂未连接到网络 | No internet connection |

## 4. Button Text

Rule: Verb-first, keep it short.
**No period** — buttons are always fragments.

| CN | EN |
|----|-----|
| 保存 | Save |
| 确定 | OK |
| 删除 | Delete |

Avoid "Yes/No" in confirmation buttons. Use action verbs instead.

## 5. Avoid Redundant Pronouns

In buttons, links, and short UI copy, the verb alone is sufficient. Do not add pronouns like *one / it / them*.

| ❌ Redundant | ✅ Clean |
|-------------|----------|
| Create one | Create |
| Add one | Add |
| Delete it | Delete |
| View all | View |

## 6. Toast / Feedback

Provide timely and clear feedback after user actions.
Toasts always omit the final period, even with two sentences — periods only separate sentences internally.

| CN | EN |
|----|-----|
| 已保存 | Saved |
| 上传失败，请重试 | Upload failed. Please try again |

## 7. Plurals with {n} Placeholders

EN: Always use the **plural** form with variable `{n}` placeholders — do not branch on the singular and never write "chat(s)". CN has no plural inflection; no change needed.

| CN | EN |
|----|-----|
| 已选择 {n} 个会话 | {n} chats selected |
| 删除 {n} 个会话 | Delete {n} chats |
| 上传文件最多支持 {n} 个 | You can upload up to {n} files |

Fixed counts still use the singular: `删除 1 条消息` / `Delete 1 message`.
