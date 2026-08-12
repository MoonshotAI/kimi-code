---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Remove the agent-core-v2 `AgentRPCService` aggregation layer (`agent/rpc/`); orchestration now lives in the owning domain services (`agentPromptService.submit`/`submitSteer`, `agentSkillService.activate`, the new `agentPluginCommandService`, `agentLoopService.cancelFromUser`, `agentPermissionModeService.setModeAndBroadcast`, `agentFullCompactionService.cancel`). Two externally visible changes:

- Debug surface: the `agentRPCService` channel is gone; the same operations are served by per-domain channels. `agentPromptService.submit` does not take `disabledTools` — session tool gating is applied via `agentToolPolicyService.setSessionDisabledTools` before submitting (the SDK/klient facade `prompt({ disabledTools })` does this composition for you; over klient, a profile-less engine now surfaces the raw profile error instead of `request.invalid`).
- Session metadata writes (title/lastPrompt derivation) are now MAIN-agent-only across prompt/steer/skill/pluginCommand; node-sdk and kap-server no longer write them at the edge for skill activation.
