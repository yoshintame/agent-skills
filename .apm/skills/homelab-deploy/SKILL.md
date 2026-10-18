---
name: homelab-deploy
description: Деплой lasthaze-homelab NixOS-бокса.
---

# homelab-deploy

`lasthaze-homelab` (NixOS OptiPlex, tailnet-only) собирается из двух репо (dotfiles публичный, homelab приватный):

- **dotfiles** — `~/.dotfiles`, `git@github.com:yoshintame/dotfiles`. Владеет хостом: `hosts/lasthaze-homelab/` (`disko.nix`, `deploy.nix`, base). Flake-атрибут `.#lasthaze-homelab`.
- **homelab** — `~/Development/personal/lasthaze-homelab`, `git@github.com:yoshintame/lasthaze-homelab`. Владеет сервисами + инфрой, потребляется dotfiles как `inputs.homelab`. dotfiles **не пинит** этот инпут: каждый деплой делает `nix flake update homelab` — бокс всегда едет на свежем homelab `main`.

Адреса бокса:
```bash
tailscale status | grep lasthaze-homelab   # tailnet IP + статус
```
Root SSH через Tailscale (ACL разрешает root для `tag:homelab`).

## Роутинг

Все `just`-команды запускаются из homelab-репо (`~/Development/personal/lasthaze-homelab`). Актуальный список рецептов с описаниями:
```bash
just --justfile ~/Development/personal/lasthaze-homelab/justfile --list
```

Без аргументов: проверь `git -C ~/Development/personal/lasthaze-homelab status --porcelain`. Есть незакоммиченные изменения — предупреди и предложи `just dev`. Чисто — спроси фильтр (имя сервиса) и запусти `just deploy-wait <filter>`.

## Типы сервисов

- **Контейнерные** — `services/<name>/` с `containers.<key>`: `virtualisation.oci-containers` под rootful Podman, контейнер `<name>-<key>`, юнит `podman-<name>-<key>.service`, сеть `<name>`, slice `homelab-<name>.slice` (дефис в имени экранирован: `systemd-escape <name>`). На боксе: `sudo podman ps -a`, `journalctl -u 'podman-<name>-*'`; остановить сервис целиком — `systemctl stop 'homelab-<name>.slice'`.
- **NixOS-native** — `modules/infra/` и `services.<name>` NixOS: `tailscale ssh lasthaze-homelab 'journalctl -u <unit> -n 30 --no-pager'`.

`switch` может выйти с кодом 4 при рабочем сервисе: в failed попадают транзиентные юниты пробы healthcheck (`<64 hex>-<hex>.service`). `just failed` отделяет их от упавших сервисов, `deploy-wait` вызывает его сам.

## Pull deploy — `just deploy-wait <filter>`

Штатный деплой сервисных изменений. Пушит в `main`, триггерит на боксе `homelab-deploy.service` (oneshot). Вызов `systemctl start` блокируется до завершения сборки (5–60 с), после чего показывает последние 20 записей журнала (результат сборки), `just failed`, статус контейнеров и логи юнитов `podman-<filter>*`.

Бокс собирает из `origin/main`, не из рабочего дерева. Деплоится только закоммиченный и запушенный код.

- `just deploy` — push + trigger без ожидания (legacy, без feedback'а).
- `just trigger` — trigger без push'а (уже запушено через GitHub UI / iPhone).
- `homelab-deploy.timer` стреляет раз в час (подстраховка для push'ей без trigger'а).

## Push deploy — `just dev [action]`

Dev-итерация без коммита: собирает из рабочего дерева Mac'а через `nixos-rebuild --override-input homelab path:.`, делегируя сборку на бокс через `--build-host`. Вывод отфильтрован — nix-шум (copying paths, списки .drv, warnings) подавлен; видны только diff, сообщения активации и Done.

Рецепт автоматически обходит **1Password store-ssh gotcha**: `nix run …nixos-rebuild` использует SSH из nix store, а 1Password привязывает подпись к пути бинарника → `Permission denied`. Рецепт открывает system-SSH ControlMaster и перенаправляет nixos-rebuild через него (`NIX_SSHOPTS`).

`action` по умолчанию `switch`. Для сетевых/SSH/firewall-изменений используй `test` — откатится при следующей перезагрузке (ручной magic-rollback).

Часовой `homelab-deploy.timer` пересобирает бокс из `main` и затирает dev-поколение. `systemctl stop` таймера не держит: каждый `switch` запускает его снова, а `systemctl mask --runtime` проигрывает юниту из `/etc`. На серию dev-switch держи сам деплой runtime drop-in'ом, оба файла исчезают при ребуте:

```
mkdir -p /run/systemd/system/homelab-deploy.service.d
printf '[Unit]\nConditionPathExists=!/run/homelab-deploy.hold\n' > /run/systemd/system/homelab-deploy.service.d/hold.conf
touch /run/homelab-deploy.hold && systemctl daemon-reload
```

Снять: `rm /run/homelab-deploy.hold`, затем `just trigger`, если бокс должен вернуться на `main`.

## Одно изменение, одна топология

Сервисное изменение → только pull (float, Mac не расходится с `main`). Push — для base/dev итерации с явным `--override-input`. Не гони одно изменение через обе топологии — устаревший `flake.lock` на Mac'е молча откатит homelab, а следующий тик таймера прокатит обратно.

## Откат

```
tailscale ssh lasthaze-homelab 'sudo nixos-rebuild --rollback switch'
```

Или выбери предыдущее поколение в systemd-boot. Быстрее версионного пина (без пересборки) — поэтому homelab-инпут плавает, а не пинится.

## Отложить и вернуть данные сервиса

Команда, которая откладывает или возвращает каталоги сервиса на боксе, должна переживать повторный запуск: человек может вставить её дважды. Каждый `rm` и `mv` — только после проверки, что источник на месте, а цель свободна.

```sh
set -e
d=/var/lib/<svc>
[ -d $d/config.bak ] || { echo "нет $d/config.bak, ничего не трогаю" >&2; exit 1; }
systemctl stop homelab-<svc>.slice
rm -rf $d/config
mv $d/config.bak $d/config
```

Откладывание — зеркально: `[ ! -e $d/config.bak ]` перед `mv $d/config $d/config.bak`, иначе второй запуск вложит `config` внутрь `config.bak`.

## Bootstrap-факты (для отладки сломанного деплоя, не для рутины)

- Бокс тянет оба репо двумя read-only **deploy-ключами** из sops `secrets/homelab/deploy.yaml`, разведёнными по ssh-алиасам: `github.com` → ключ homelab, `dotfiles.github.com` → ключ dotfiles (один deploy key не покрывает два репо на GitHub).
- Авторизация trigger'а: Tailscale SSH (`--ssh` на боксе) + tailnet ACL `accept` для `tag:homelab` + NOPASSWD sudo ровно на `systemctl start homelab-deploy.service`.
- Бокс — **nix remote builder** (запись в `/etc/nix/machines`), доступен через Tailscale SSH. Проверить: `just ping`.
- age identity — SSH host key бокса; переустановка должна сохранить `/etc/ssh/ssh_host_ed25519_key` через `nixos-anywhere --extra-files`, иначе sops-энроллмент ломается.
