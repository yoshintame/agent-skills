---
name: nix-style
description: User's Nix conventions and tooling.
---

# Nix style

Patch to default Nix generation in the user's flakes (dotfiles, lasthaze-homelab, nix-stencil and their consumers). A project's own `CLAUDE.md` wins over this file.

## Rules (DO / DON'T)

| Area | DO | DON'T |
|---|---|---|
| Scripts | the script is its own file beside the module (`homelab-restore.sh`, `healthcheck.pl`), wired in Nix | a shell body inline in `''…''` of a `.nix` file |
| Secret files | nix-stencil: `stencil.files`, `stencil.namespaces`, `stencil.refs` | `sops.templates` / `sops.placeholder` by hand |
| Services | the nixpkgs module first (`services.restic.backups`, `services.restic.server`); override its units only for what it lacks | own `systemd.services` that redo what a module already does |
| Many similar units | one data table, units derived from it with `lib.mapAttrs'` | near-identical unit literals; reading data back out of an argv list |
| `ExecStart` from a list | `utils.escapeSystemdExecArgs [ … ]` — escapes `%` and `$` | `lib.escapeShellArgs` or hand-joined strings (`5%` is a systemd specifier) |
| Binaries | `lib.getExe pkgs.curl`, `lib.getExe' pkgs.util-linux "flock"` | `"${pkgs.curl}/bin/curl"` |
| Data of another host | `hosts/<host>/facts.nix`, imported once in the flake `let`, passed through `specialArgs` | `import ./facts.nix` inside a host, or a second import per consumer |
| Formatting | `nix fmt` (treefmt: nixfmt-rfc-style, deadnix, statix) | formatting by hand |

## Scripts as files

```nix
pkgs.writeShellApplication {
  name = "homelab-restore";
  runtimeInputs = [ pkgs.jq pkgs.coreutils ];
  runtimeEnv = { SPEC = spec; };
  text = builtins.readFile ./homelab-restore.sh;
}
```

Values the script needs go in `runtimeEnv` or arguments, not through string interpolation into the script body. `writeShellApplication` runs shellcheck at build and `set -euo pipefail`, so read optional systemd variables as `${SERVICE_RESULT:-}`.

## nix-stencil

`github:yoshintame/nix-stencil`, module `nixosModules.default` (and the Home Manager one in dotfiles). A template is the app's config file as is, with holes:

| Hole | Becomes |
|---|---|
| `${KEY}` | secret `KEY` of the file's namespace (`sopsFile`) |
| `${ns.KEY}` | secret `KEY` of namespace `ns` |
| `$${KEY}` | literal `${KEY}` |
| `@var@` | Nix value from `vars`, camelCase name |

```nix
stencil.files."~/.config/resticprofile/homelab.env" = {
  template = ./config/homelab.env.tmpl;
  sopsFile = ./secrets.yaml;
  vars.hubClient = cfg.hub.client;
};
services.foo.passwordFile = config.stencil.refs.app.API_TOKEN;
```

- A hole that names a key missing from the sops file fails evaluation, not activation. A branch that adds a hole does not pass `nix flake check` until the user adds the key; the agent never creates or decrypts secrets.
- Keys of a namespace file are `[A-Z_][A-Z0-9_]*` (`B2_KEY_ID`); a kebab-case key (`restic-homelab-b2-key-id`) is skipped with a warning, so a new sops file for stencil uses upper snake case.
- Values are inserted verbatim. A secret with quotes or backslashes goes by path through `stencil.refs`, not into a template.
- `stencil.namespaces.<ns>.env.enable` gives an env file of every key of the namespace (`.env.path`).

## nix-link (dotfiles)

`lib/nix-link.nix`: configs are live symlinks into the repo, not store copies.

```nix
nixLink.links = {
  "~/.config/x" = "modules/home/x/config";
  "~/.config/y/conf.d" = { path = "modules/home/y/config/conf.d/**"; glob = true; };
};
```

- A folder link sees new files at once; a glob link needs `mise run dot:link` for a new file.
- Do not put an editable config through `home.file.<x>.source = ./x`: it lands read-only in the store.

## Modules

- dotfiles: `myLib.mkModule config "<name>" { … }` declares `my.<name>.enable`; the host turns it on in `hosts/<host>/manifest.nix` with `myLib.enableList [ … ]`.
- lasthaze-homelab: options under `homelab.*`, off by default (`lib.mkEnableOption`), the host enables them in dotfiles; schema tests in `tests/schema/<area>.nix` with `expect` and `rejects`, registered in `parts/checks.nix`.

## Gates

- A new `.nix` file is invisible to the flake until tracked: `git add -N` before eval.
- `nix flake check` is the gate (dotfiles: `--impure`). On darwin it omits `x86_64-linux`, so evaluate a NixOS host explicitly: `nix eval --raw .#nixosConfigurations.<host>.config.system.build.toplevel.drvPath`.
- Run nix outside the agent sandbox: inside it nix fails on the read-only cache.
- Git hooks are hk with the shared preset `yoshintame/hk-config` (`hk.pkl`); commit messages are Conventional Commits.
