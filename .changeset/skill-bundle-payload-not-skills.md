---
"@moonshot-ai/agent-core": patch
---

Stop registering auxiliary docs inside a skill bundle as skills: the bundle scanner now only treats the skill entrypoint as a skill, so payload files no longer appear as phantom skills in the catalog.
