# Feedback and uploads

Set `KIMI_CODE_EXPERIMENTAL_DESKTOP_FEEDBACK=1` before starting the desktop app or `kimi web` to enable feedback.

Sign in to Kimi Code and choose **Send feedback** in the sidebar, or enter `/feedback` in the message input. To rate an individual reply, use the thumbs-up or thumbs-down button beneath it. Feedback helps the team diagnose issues and improve Kimi Code.

## What gets sent

Clicking a rating sends your choice, the session and turn identifiers for the selected reply, and any available model and request identifiers. Click the same button again to undo the rating. Reloading the page or restarting the desktop app clears the highlight. After a thumbs-down, click **Submit** to send your selected reasons and any additional details.

General feedback includes the category, your description, where you opened the form, and client information such as the version and operating system. A draft started in a conversation keeps its session identifier when you close the form and reopen it in the same window. If you select conversation history in a different conversation, the feedback and its attachment both refer to that newly selected conversation. You can copy the feedback ID from the receipt for follow-up.

## Choose what to attach

Conversation history and diagnostic logs are both unchecked by default. You can select either before submitting.

| Option | What gets uploaded |
| --- | --- |
| Conversation history | Messages, tool calls and their results, and attachments stored in the conversation associated with this feedback. These may contain code snippets and file paths. |
| Diagnostic logs | Desktop app logs, app version, operating system, and processor architecture. This option is available in the desktop app. |
| Images and videos | Files you select, paste, or drop into the general feedback form. You can attach up to five files, including one video. Each image can be up to 10 MB and the video can be up to 100 MB. |

Selected attachments upload in the background after you submit. If an upload fails, choose **Retry upload** in the separate notification to resend the failed attachments. Your description and successful uploads are already saved.
