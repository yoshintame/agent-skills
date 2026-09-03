---
name: homelab-deploy
description: Deploy the lasthaze-homelab NixOS box.
---

# homelab-deploy

`lasthaze-homelab` (NixOS OptiPlex, tailnet-only) is built from two repos (dotfiles is public, homelab is private):

- **dotfiles** — `~/.dotfiles`, `git@github.com:yoshintame/dotfiles`. Owns the host: `hosts/lasthaze-homelab/` (`disko.nix`, `deploy.nix`, base). Flake attr `.#lasthaze-homelab`.
- **homelab** — `~/Development/personal/lasthaze-homelab`, `git@github.com:yoshintame/lasthaze-homelab`. Owns services + infra, consumed by dotfiles as `inputs.homelab`. dotfiles **floats** this input (no pin): every deploy runs `nix flake update homelab`, so the box always rides fresh homelab `main`.

Box addresses: tailnet `lasthaze-homelab.alpine-ulmer.ts.net` / `100.123.237.27`, LAN `192.168.1.48`. Root SSH is keyless from the Mac.

## Routine service change → pull

Edit homelab, then from the homelab repo:

```
just deploy
```

= `git push` + `tailscale ssh lasthaze-homelab 'sudo systemctl start homelab-deploy.service'`. The box's `homelab-deploy.service` (oneshot) resets its own checkout at `/var/lib/homelab-deploy/dotfiles` to `origin/master`, floats homelab, and `nixos-rebuild switch` — **built on the box**. Latency 5–60 s.

- `just trigger` — trigger without pushing (already pushed from GitHub UI / iPhone).
- `just deploy-status` / `just deploy-logs` — inspect the last run.
- `homelab-deploy.timer` fires hourly (safety net for pushes made without a trigger).

Only a **`git push` to `main`** deploys — the box builds from `origin`, not your working tree. Keep unfinished work on branches, not `main`; the hourly timer will otherwise ship it.

## base/dev iteration (WIP without commit, risky changes) → push

Host-level changes in dotfiles, or testing uncommitted homelab, build from the Mac. aarch64 can't build x86_64 itself, so offload to the box:

```
nix run 'nixpkgs/nixos-25.05#nixos-rebuild' -- switch --flake .#lasthaze-homelab \
  --target-host root@192.168.1.48 --build-host root@192.168.1.48 --fast
```

- `--override-input homelab path:/Users/yoshintame/Development/personal/lasthaze-homelab` to build against uncommitted homelab.
- `test` instead of `switch` for networking/ssh/firewall changes — reverts on next boot (manual magic-rollback).
- `--fast` is required: it skips the local x86_64 rebuild of `nixos-rebuild` itself, which is what makes a plain call fail on aarch64.

**1Password store-ssh gotcha.** `nix run …nixos-rebuild` uses ssh from the nix store; 1Password ties signing approval to the binary path and refuses for the store binary non-interactively → `Permission denied (publickey)`, even though system `ssh root@box` works. Pre-open one system-ssh ControlMaster and make nixos-rebuild reuse it:

```
CM="$TMPDIR/cm.sock"
ssh -o ControlMaster=yes -o ControlPath="$CM" -o ControlPersist=900 -fN root@192.168.1.48
NIX_SSHOPTS="-o ControlPath=$CM -o ControlMaster=no" nix run 'nixpkgs/nixos-25.05#nixos-rebuild' -- switch --flake .#lasthaze-homelab --target-host root@192.168.1.48 --build-host root@192.168.1.48 --fast
ssh -O exit -o ControlPath="$CM" root@192.168.1.48
```

## One change, one topology

Service change → pull only (float, no Mac lock to diverge from `main`). Push is for base/dev iteration with an explicit `--override-input`. Don't drive one homelab change through both — a stale Mac `flake.lock` will silently roll homelab back, and the next timer tick rolls it forward again.

## Rollback

`nixos-rebuild --rollback` on the box, or pick a prior generation in systemd-boot. Faster than a version pin (no rebuild); this is why the homelab input floats instead of pinning.

## Bootstrap facts (for debugging a broken deploy, not routine)

- The box pulls both repos with two read-only **deploy keys** in sops `secrets/homelab/deploy.yaml`, routed by ssh host alias on the box: `github.com` → homelab key, `dotfiles.github.com` → dotfiles key (one deploy key can't cover two repos on GitHub).
- Trigger auth: Tailscale SSH (`--ssh` on the box) + a tailnet ACL `accept` rule for `autogroup:self` + NOPASSWD sudo scoped to exactly `systemctl start homelab-deploy.service`.
- age identity is the box's SSH host key (`age1u83d9…`); a reinstall must preserve `/etc/ssh/ssh_host_ed25519_key` via `nixos-anywhere --extra-files`, or the sops enrollment breaks.
