---
name: apm-skill-dev
description: Develop and release an APM-managed skill.
---

Resolve the producer, skill, tier, and consumer before editing. Edit only the
authoring source; `.claude/skills`, `.agents/skills`, `.cursor/skills`, and
`apm_modules` are disposable output.

| Tier | Authoring source | Consumer |
|---|---|---|
| personal | `agent-skills/.apm/skills/<name>/` | user-scope `~/.apm` owned by dotfiles |
| org | `<package>/skills/<name>/` | one selected repository or workspace |
| repository | `<consumer>/.apm/skills/<name>/` | that same repository |

If the content is new or changing, run `/create-skill` first. Accept its handoff
only after its baseline, gap filter, linter, and behavioral check pass. This
skill owns what follows: source selection, materialization, provider checks,
release, and promotion. Do not duplicate authoring guidance here.

## APM 0.29.1 constraints

- `--dev` only writes the dependency under `devDependencies`; it is not an
  editable install, watch mode, or override. Bare `apm install` installs both
  dependency sections.
- A local direct dependency is recopied by each bare `apm install`. Use that
  after every source edit; `--refresh` is not part of the inner loop.
- User-scope `path:` values are absolute.
- Dev replaces the package's production Git entry with one local `path:` entry.
  Never leave both sources in either dependency section.
- Package-root dependencies do not travel with an individual skill. Runtime
  entry points must use bundled dependencies or a stable executable on `PATH`
  and must resolve from the loaded skill directory, never `.claude/skills`.

If the installed APM version differs, re-check these facts from `apm install
--help`, the manifest schema, and one isolated probe before mutating a consumer.

Resolve `<skill-dir>` from this loaded skill's catalog path. Never substitute a
provider-specific install path. The bundled helper is
`<skill-dir>/scripts/apm-skill-dev.ts`.

## Test first in isolation

Use isolation for every first materialization and for ordinary edit-test loops:

```sh
bun <skill-dir>/scripts/apm-skill-dev.ts isolated \
  --source <absolute-producer-root> --skill <name> \
  --target claude,codex -- <smoke-command>
```

The helper exposes the temporary consumer as `APM_DEV_ROOT`, checks requested
skills in every selected target, and removes its own temporary root. Run a
second pass with `--target codex`; it must succeed without creating
`.claude/skills`. Invoke scripted entry points from an unrelated cwd inside the
smoke command. Re-run the same command after each source change: each run uses a
fresh bare install.

For a repository-specific skill, pass the consumer itself as `--source`; APM
materializes its local `.apm/skills`. Live materialization is a bare `apm
install` in that consumer. There is no Git-dependency override or package
promotion boundary: the repository commit is the release.

## Scoped live dogfooding

Use live dogfooding only when provider discovery or real interaction cannot be
proved in isolation. The helper holds one consumer lock for the entire child
process, snapshots manifest and lock bytes before mutation, restores them on
success, failure, SIGINT, or SIGTERM, runs a frozen prod materialization, and
removes paths added under allowlisted APM provider/cache roots. The state stores
that surface inventory before mutation, so SIGKILL leaves a complete recovery.

Project or org consumer:

```sh
bun <skill-dir>/scripts/apm-skill-dev.ts with-dev \
  --scope project --consumer <absolute-consumer-root> \
  --source <absolute-producer-root> --dependency <git-entry-selector> \
  -- <provider-or-smoke-command>
```

Personal user scope:

```sh
bun <skill-dir>/scripts/apm-skill-dev.ts with-dev \
  --scope global --consumer "$HOME/.apm" \
  --source <absolute-producer-root> --dependency <git-entry-selector> \
  -- <provider-or-smoke-command>
```

Global mutation is valid only when both live files resolve to
`$DOTFILES/modules/home/apm/config/`. The helper uses `mise run dot:apm`; never
run raw mutating global APM commands. A pre-existing local `path:` is another
owner's dev state, not permission to replace or restore it.

Do not commit a consumer while `with-dev` is active. Diagnose ownership with:

```sh
bun <skill-dir>/scripts/apm-skill-dev.ts status --consumer <absolute-consumer-root>
```

After a killed owner is confirmed dead, recover idempotently:

```sh
bun <skill-dir>/scripts/apm-skill-dev.ts recover --consumer <absolute-consumer-root>
```

`--force` is only for an inspected false-positive live PID. Never force over a
real owner.

## Release and promotion boundary

`create` and `update` end with source plus content gates. `test` may materialize
local source but cannot change a production ref. `release` starts only from a
clean intended producer diff: align package and marketplace versions, run the
producer's full tests and `apm pack` version/clean checks, then commit. Creating
an annotated signed tag or pushing is an external release action and requires
explicit user authorization.

`promote` starts after the tag is remotely available. Keep the consumer on its
Git dependency, preview the lock change with `apm update --dry-run`, apply the
selected version, run frozen install plus provider/runtime smoke tests, and
commit only the consumer manifest/lock that actually changed. For user scope,
run update and frozen install through `mise run dot:apm` and finish by checking
that both `realpath` results still point into canonical dotfiles.

Done means the source diff is committed, isolated Claude+Codex and Codex-only
checks pass, any live child has exited, `status` reports no owned state, the
consumer manifest/lock equal their production state, no dev-only generated path
remains, and no generated provider directory is staged.
