---
"@moonshot-ai/kap-server": patch
---

Reject a missing web asset build and a non-loopback bind without TLS before the server registers an instance or writes to the home directory, and release the instance registration and the agent engine when any later startup step fails, so a failed start no longer leaves a live instance entry or background writers in the home directory.
