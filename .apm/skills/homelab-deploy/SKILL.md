---
name: homelab-deploy
description: Деплой lasthaze-homelab NixOS-бокса.
---

# homelab-deploy

`lasthaze-homelab` (NixOS OptiPlex, tailnet-only) собирается из двух репо (dotfiles публичный, homelab приватный):

- **dotfiles** — `~/.dotfiles`, `git@github.com:yoshintame/dotfiles`. Владеет хостом: `hosts/lasthaze-homelab/` (`disko.nix`, `deploy.nix`, base). Flake-атрибут `.#lasthaze-homelab`.
- **homelab** — `~/Development/personal/lasthaze-homelab`, `git@github.com:yoshintame/lasthaze-homelab`. Владеет сервисами + инфрой, потребляется dotfiles как `inputs.homelab`. dotfiles **не пинит** этот инпут: каждый деплой делает `nix flake update homelab` — бокс всегда едет на свежем homelab `main`.

Адреса: tailnet `lasthaze-homelab` / `100.123.237.27`, LAN `192.168.1.48`. Root SSH через Tailscale (ACL разрешает root для `tag:homelab`).

## Роутинг

Все `just`-команды запускаются из homelab-репо (`~/Development/personal/lasthaze-homelab`).

| Вызов | Рецепт | Что делает |
|---|---|---|
| `/homelab-deploy <filter>` | `just deploy-wait <filter>` | push + блокирующее ожидание + build log + статус Docker-контейнера + логи |
| `/homelab-deploy dev` | `just dev` | push nixos-rebuild с Mac'а, без git commit |
| `/homelab-deploy dev test` | `just dev test` | то же, но `test` вместо `switch` (откатится при ребуте) |
| `/homelab-deploy status` | `just deploy-status` | systemctl status deploy-сервиса |
| `/homelab-deploy logs` | `just deploy-logs` | последние 80 записей журнала deploy-сервиса |
| `/homelab-deploy ping` | `just ping` | проверить доступность бокса как nix remote builder |

Без аргументов: проверь `git -C ~/Development/personal/lasthaze-homelab status --porcelain`. Есть незакоммиченные изменения — предупреди и предложи `just dev`. Чисто — спроси фильтр (имя сервиса) и запусти `just deploy-wait <filter>`.

## Типы сервисов

`deploy-wait <filter>` показывает статус и логи Docker-контейнера — работает только для **Docker (arion) сервисов**. NixOS-native сервисы проверяются через `systemctl`/`journalctl` напрямую.

| Сервис | Тип | Проверка статуса |
|---|---|---|
| powersync, actual, postgres, paperless, archivebox | Docker | `just deploy-wait <name>` |
| adguard, traefik, authelia, cloudflared, grafana, prometheus, loki, alloy, alertmanager | NixOS-native | `tailscale ssh lasthaze-homelab 'systemctl status <unit> --no-pager'` |

Логи NixOS-native сервиса: `tailscale ssh lasthaze-homelab 'journalctl -u <unit> -n 30 --no-pager'`.

## Pull deploy — `just deploy-wait <filter>`

Штатный деплой сервисных изменений. Пушит в `main`, триггерит на боксе `homelab-deploy.service` (oneshot). Вызов `systemctl start` блокируется до завершения сборки (5–60 с), после чего показывает последние 20 записей журнала (результат сборки) и статус + логи Docker-контейнера по фильтру.

Бокс собирает из `origin/main`, не из рабочего дерева. Деплоится только закоммиченный и запушенный код.

- `just deploy` — push + trigger без ожидания (legacy, без feedback'а).
- `just trigger` — trigger без push'а (уже запушено через GitHub UI / iPhone).
- `homelab-deploy.timer` стреляет раз в час (подстраховка для push'ей без trigger'а).

## Push deploy — `just dev [action]`

Dev-итерация без коммита: собирает из рабочего дерева Mac'а через `nixos-rebuild --override-input homelab path:.`, делегируя сборку на бокс через `--build-host`. Вывод отфильтрован — nix-шум (copying paths, списки .drv, warnings) подавлен; видны только diff, сообщения активации и Done.

Рецепт автоматически обходит **1Password store-ssh gotcha**: `nix run …nixos-rebuild` использует SSH из nix store, а 1Password привязывает подпись к пути бинарника → `Permission denied`. Рецепт открывает system-SSH ControlMaster и перенаправляет nixos-rebuild через него (`NIX_SSHOPTS`).

`action` по умолчанию `switch`. Для сетевых/SSH/firewall-изменений используй `test` — откатится при следующей перезагрузке (ручной magic-rollback).

## Одно изменение, одна топология

Сервисное изменение → только pull (float, Mac не расходится с `main`). Push — для base/dev итерации с явным `--override-input`. Не гони одно изменение через обе топологии — устаревший `flake.lock` на Mac'е молча откатит homelab, а следующий тик таймера прокатит обратно.

## Откат

```
tailscale ssh lasthaze-homelab 'sudo nixos-rebuild --rollback switch'
```

Или выбери предыдущее поколение в systemd-boot. Быстрее версионного пина (без пересборки) — поэтому homelab-инпут плавает, а не пинится.

## Bootstrap-факты (для отладки сломанного деплоя, не для рутины)

- Бокс тянет оба репо двумя read-only **deploy-ключами** из sops `secrets/homelab/deploy.yaml`, разведёнными по ssh-алиасам: `github.com` → ключ homelab, `dotfiles.github.com` → ключ dotfiles (один deploy key не покрывает два репо на GitHub).
- Авторизация trigger'а: Tailscale SSH (`--ssh` на боксе) + tailnet ACL `accept` для `tag:homelab` + NOPASSWD sudo ровно на `systemctl start homelab-deploy.service`.
- Бокс — **nix remote builder** (`ssh-ng://root@lasthaze-homelab` в `/etc/nix/machines`), доступен через Tailscale SSH. Проверить: `just ping`.
- age identity — SSH host key бокса (`age1u83d9…`); переустановка должна сохранить `/etc/ssh/ssh_host_ed25519_key` через `nixos-anywhere --extra-files`, иначе sops-энроллмент ломается.
