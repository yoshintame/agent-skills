---
name: apm-deps
description: Manage global MCP servers and skill packages through APM.
---

Global MCP servers and skill packages for Claude Code and Codex have one source: `$DOTFILES/modules/home/apm/config/apm.yml` (`targets: [claude, codex]`). Change them there only. Not `claude mcp add`, not `codex mcp add`, not a claude.ai connector, not hand edits to `~/.claude.json` or `~/.codex/config.toml`: the server lands in one provider, and `~/.codex/config.toml` is relinked on every switch, dropping hand edits.

## MCP server

Entry under `dependencies.mcp`, always `registry: false`:

```yaml
- name: example
  registry: false
  transport: stdio
  command: bunx            # one binary; every argument goes to args
  args: [-y, 'example-mcp@1.2.3']
  env:
    EXAMPLE_TOKEN: ${EXAMPLE_TOKEN}
- name: example-remote
  registry: false
  transport: http
  url: https://example.com/mcp
```

- **Secret** — only `${VAR}` in `apm.yml`; the value lives in SOPS `$DOTFILES/modules/home/apm/secrets.yaml`. Don't read or print it: the user adds it with `sops <file>`, or pipe it from 1Password (resolve the `op://` reference via `/op-secrets`, run outside the sandbox):

  ```
  VAR="op://<vault>/<item>/<field>" op run -- sh -c 'printf %s "$VAR" | jq -Rs . | sops set --value-stdin "$DOTFILES/modules/home/apm/secrets.yaml" "[\"VAR\"]"'
  ```

  `dot:mcp` aborts when a `${VAR}` is missing from SOPS.
- **Secret in an HTTP header** — the Codex adapter writes `${VAR}` in headers literally. Map it for Codex under `extra:` (`bearer_token_env_var` for `Authorization: Bearer`, `env_http_headers` for any other header), and export the variable for Codex at runtime with a `set -gx VAR ${VAR}` line in `$DOTFILES/modules/home/apm/config/mcp-secrets.fish.tmpl`. Codex sees it only when launched from a fish shell opened after the render, not from a GUI.

  ```yaml
    headers:
      Authorization: Bearer ${EXAMPLE_TOKEN}
    extra:
      bearer_token_env_var: EXAMPLE_TOKEN
  ```
- **OAuth server** — `url` only. APM does not log in: after install the user logs in once per provider, Claude `/mcp` → Authenticate, Codex `codex mcp login <name>`.
- **Transport change** (stdio ↔ http) — first `claude mcp remove <name> -s user` and `codex mcp remove <name>`; otherwise APM merges the new fields into the old entry and the server fails to start.
- **Removal** — delete the entry, apply, then remove any leftover from `claude mcp list` / `codex mcp list` with the same two commands.

Apply in `$DOTFILES`, outside the sandbox, with `mise run dot:mcp`: it decrypts SOPS into the env of a single `apm install` and relinks `~/.apm/apm.lock.yaml` back into dotfiles. If `mcp-secrets.fish.tmpl` changed, run `mise run dot:link` instead: it renders the template without sudo and calls `dot:mcp` itself. Not `dot:rebuild`: it needs sudo and runs `git add -A` over the whole dirty tree. Check with `claude mcp get <name>` and `codex mcp list`. Tools appear only in sessions started after the install; tell the user to open a new one instead of looking for the tools in the current session.

## Skill packages

`dependencies.apm` holds git deps (`git:`, `ref:`, optional `skills:` subset). Apply with `mise run dot:apm install`, never bare `apm install --global`: the wrapper keeps the lock linked into dotfiles.

Switching which package provides a skill of the same name needs the full `mise run dot:apm install`. A scoped `apm update <pkg>` deletes the old provider's files without deploying the newly unshadowed one, and the skill silently disappears.

## Commit

In `$DOTFILES`: `apm.yml`, `apm.lock.yaml`, plus `secrets.yaml` and `mcp-secrets.fish.tmpl` if touched.
