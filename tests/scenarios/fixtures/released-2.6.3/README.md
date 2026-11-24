# Released conversation fixture

The npm distribution of @moonshot-ai/kimi-code 2.6.3 wrote this session. The package integrity in manifest.json comes from its registry entry. The release tag is @moonshot-ai/kimi-code@2.6.3 at b0de2fbd2de04d87689225aafd3912e5d193b62d.

Capture used Node 24, an empty temporary workspace and HOME, a separate KIMI_CODE_HOME and a loopback OpenAI-compatible testkit provider. The CLI was invoked through its published dist/main.mjs with `-p 'Remember this greeting.'` and answered `Hello from the released writer.` in a single completed turn. Only the project registry, session index, session state and main agent wire were retained. No config, API keys, device data or logs are needed.

The capture replaces the two temporary absolute path prefixes with {{DATA_DIR}} and {{WORKSPACE}}, and the captured timezone with UTC. Record types, IDs, references, order and the original workspace directory key are preserved. Each manifest digest covers the committed template bytes. The cold-recovery test copies and relocates these files into its own test home. Preserve this generation when introducing another writer version.
