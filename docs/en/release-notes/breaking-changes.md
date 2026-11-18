# Breaking changes

## Unreleased

### Remote environments replaced by SSH hosts

**Affected**: Configurations using `[environments]` for SSH, Docker, or custom-command execution, the `--environment` and `--environment-cwd` CLI flags, environment selectors in SDK and REST clients, and `environment_id` in MCP server declarations. Sessions persisted with a non-local environment can no longer be resumed.

**Migration**: Move SSH connection settings to `[hosts]` and use the SSH host controls in the web UI. `remote_bin` is optional; it defaults to `~/.kimi-code/bin/kimi`. Create a new session on the host and select its remote working directory there.

```toml
[hosts.dev-box]
host = "dev-box"
identity_file = "~/.ssh/id_ed25519"
remote_bin = "~/.kimi-code/bin/kimi"
```

Remove the old `[environments]` entries and environment selectors. Existing `[environments]` sections produce a migration warning. Local sessions retain their working directories and can still be resumed and forked.
