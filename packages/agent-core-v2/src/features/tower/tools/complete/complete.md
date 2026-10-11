Complete the mission owned by the calling tower worker and persist its standard completion notification in one locked protocol flow. The tower and reviewers cannot use this tool.

`report` is required and must contain non-whitespace text. For a build mission, write the full implementation report, reconciled against every mission task; the tool records `completed` and stores a `review-request` to the tower. For a survey mission, report the complete investigation result; the tool records `completed` and stores `survey-summary` instead.

Completion checks are part of the same flow: no open tasks or blockers, every unread inbox page read, a committed build diff, and a zero-diff survey branch. A failed check writes no notification. If notification storage fails after the mission was persisted, the result says so explicitly. Retrying with the same report reuses an already stored notification instead of silently writing a duplicate.

If the tower state was lost (.tower/comms deleted while .tower/ survives), the mission record is gone, so no mission is marked completed: the tool recovers a minimal state stamped recoveredAt, delivers the report to the tower as a degraded completion message, and says so explicitly in the result.
