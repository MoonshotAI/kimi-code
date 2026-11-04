Send an asynchronous message to another independent session in the same daemon and return immediately after delivery.

When to use:
- Peer collaboration that needs a separate conversation, workspace, or context.
- Asynchronous work that should start a turn in another existing session.
- Notifications or requests between sessions; use session_list first when you do not know the target id or title.

When not to use:
- Use the Agent tool for a lightweight subtask that shares the parent's context and returns one result.
- Use Agent with fork for a child that should inherit the current conversation context.
- Do not use this for a new subagent or a child session; this tool addresses existing peer sessions.

The target can be a session id or an exact title. Duplicate titles return candidates; retry with the chosen id. If the target is idle its turn starts immediately; if it is busy the message is queued without interrupting its current turn. Archived sessions and sessions occupied by another process return errors. The immediate result contains only the messageId and delivery status, or a structured error.

Delivery defaults to queue. queue does not interrupt the recipient's current work: a running recipient handles the message in a later turn. delivery=steer uses the engine's active-turn steering and returns steered when the message was actually injected into the current turn; use it only when real-time correction is explicitly required. An idle target starts a new turn for either delivery mode. If steering is unavailable for the active prompt, the message falls back to queued.

Send and continue your own work or end the current turn; do not wait for the recipient. Replies arrive later as messages in your session and automatically start a turn when you are idle or queue behind your current work when busy. Results are obtained only from those incoming messages, never by blocking on session_send.

expectReply defaults to false: the message is a notification and no answer is required. Set it to true only when the recipient should answer. This does not delay the immediate return and does not guarantee when a reply will arrive. Do not request replies to routine notifications; unnecessary acknowledgements can create polite reply loops.

Orchestration pattern:
- A manager uses session_list to discover peers, then session_send with expectReply=true to assign work. After replies wake the manager, it aggregates results and schedules next steps. Use delivery=steer only for urgent correction of an active worker.
- A worker answers an assignment with session_send, setting to to the sender's session id and replyTo to the received envelope's messageId. This delivers the result without starting a new chain.

replyTo is optional. Omit it to start a new chainId. When present, it must be the exact messageId from a message received by this session, otherwise an error asks for the received envelope's messageId. The explicit to always controls routing; replyTo only records correlation and preserves the original chainId. Each send creates a new messageId for later threading.

The recipient sees an envelope containing [message_id][from: title(sessionId)] and instructions to answer with session_send using the sender's id and that messageId.
