---
name: homelab-deploy
description: Deploy the lasthaze-homelab NixOS box.
---

# homelab-deploy

`lasthaze-homelab` (NixOS OptiPlex, tailnet-only) is built from two repos (dotfiles is public, homelab is private):

- **dotfiles** — `~/.dotfiles`, `git@github.com:yoshintame/dotfiles`. Owns the host: `hosts/lasthaze-homelab/` (`disko.nix`, `deploy.nix`, base). Flake attr `.#lasthaze-homelab`.
- **homelab** — `~/Development/personal/lasthaze-homelab`, `git@github.com:yoshintame/lasthaze-homelab`. Owns services + infra, consumed by dotfiles as `inputs.homelab`. dotfiles **floats** this input (no pin): every deploy runs `nix flake update homelab`, so the box always rides fresh homelab `main`.

Box addresses: tailnet `lasthaze-homelab.alpine-ulmer.ts.net` / `100.123.237.27`, LAN `192.168.1.48`. Root SSH is keyless from the Mac.

## Routing

All `just` commands run from the homelab repo (`~/Development/personal/lasthaze-homelab`).

| Invocation | Recipe | What happens |
|---|---|---|
| `/homelab-deploy <filter>` | `just deploy-wait <filter>` | push + trigger + stream build output + container status + logs |
| `/homelab-deploy dev` | `just dev` | push nixos-rebuild from Mac, no git commit needed |
| `/homelab-deploy dev test` | `just dev test` | same but `test` instead of `switch` (reverts on reboot) |
| `/homelab-deploy status` | `just deploy-status` | inspect the last deploy run |

Without args: check `git -C ~/Development/personal/lasthaze-homelab status --porcelain`. If there are uncommitted changes in the homelab repo, warn and suggest `just dev`. If clean, ask for a filter (service name like `powersync`, `adguard`) and run `just deploy-wait <filter>`.

## Pull deploy — `just deploy-wait <filter>`

Routine service changes. Pushes to `main`, triggers the box's `homelab-deploy.service` (oneshot), streams build journal until completion, then reports container status and recent logs for the filtered service.

The box builds from `origin/main`, not the working tree. Only committed+pushed code deploys.

- `just deploy` — push + trigger without waiting (legacy, no feedback).
- `just trigger` — trigger without pushing (already pushed from GitHub UI / iPhone).
- `homelab-deploy.timer` fires hourly (safety net for pushes made without a trigger).

## Push deploy — `just dev [action]`

Dev iteration without committing: builds from the Mac's working tree via `nixos-rebuild --override-input homelab path:.`, offloading the build to the box via `--build-host`.

The recipe handles the **1Password store-ssh gotcha** automatically: `nix run …nixos-rebuild` uses SSH from the nix store, but 1Password ties signing approval to the binary path → `Permission denied`. The recipe opens a system-SSH ControlMaster first and makes nixos-rebuild reuse it via `NIX_SSHOPTS`.

`action` defaults to `switch`. Use `test` for networking/ssh/firewall changes — reverts on next boot (manual magic-rollback).

## One change, one topology

Service change → pull only (float, no Mac lock to diverge from `main`). Push is for base/dev iteration with an explicit `--override-input`. Don't drive one homelab change through both — a stale Mac `flake.lock` will silently roll homelab back, and the next timer tick rolls it forward again.

## Rollback

`nixos-rebuild --rollback` on the box, or pick a prior generation in systemd-boot. Faster than a version pin (no rebuild); this is why the homelab input floats instead of pinning.

## Bootstrap facts (for debugging a broken deploy, not routine)

- The box pulls both repos with two read-only **deploy keys** in sops `secrets/homelab/deploy.yaml`, routed by ssh host alias on the box: `github.com` → homelab key, `dotfiles.github.com` → dotfiles key (one deploy key can't cover two repos on GitHub).
- Trigger auth: Tailscale SSH (`--ssh` on the box) + a tailnet ACL `accept` rule for `autogroup:self` + NOPASSWD sudo scoped to exactly `systemctl start homelab-deploy.service`.
- age identity is the box's SSH host key (`age1u83d9…`); a reinstall must preserve `/etc/ssh/ssh_host_ed25519_key` via `nixos-anywhere --extra-files`, or the sops enrollment breaks.
