---
name: homelab-add-service
description: Добавить сервис в lasthaze-homelab.
---

Репо `~/Development/personal/lasthaze-homelab`, работа в отдельном worktree (`/wt-workflow`). Сервис — один файл `services/<name>/default.nix`, в нём только `homelab.services.<name>`. Схема — `modules/service-options.nix`, `modules/collectors/*.nix`, `modules/runtimes/podman.nix`; прочитай их до записи файла. Эталоны с разбором — [examples.md](references/examples.md).

## 1. Апстрим

- Compose и страница конфигурации — из репо или доков апстрима.
- Из доков, не наугад: обязательные env, первый логин или создание админа, проба здоровья, время первого старта (миграции, загрузка моделей), есть ли свой логин, API для нативных клиентов, trusted header (`Remote-User`).
- Релизный тег: `crane ls <repo>`. Мажор Postgres — из доков апстрима; позже он меняется только через dump и restore.

## 2. Черновик скриптом

Скачай compose и файлы, на которые он ссылается (`env_file`, `extends`), в один каталог. Скрипт нормализует проект через `docker compose config`, пинит образы через `crane digest` и рендерит Nix через `lib.generators.toPretty`. Нужны сеть и nix (`docker compose` и `crane` берутся через `nix shell`, если их нет в PATH), поэтому запускай вне sandbox:

```
bun <skill-dir>/scripts/compose-to-homelab.ts --name <name> --compose <dir>/compose.yml [--compose pin.yml] [--env-file <dir>/.env] --out $TMPDIR/homelab-<name>
```

- Образ на `latest` или без тега — второй `--compose` с override `services.<svc>.image: <repo>:<tag>` и повторный прогон; теги — `nix shell nixpkgs#crane -c crane ls <repo>`.
- Скопируй `default.nix` в `services/<name>/` и прогони `nix fmt`. Отладочные и демо-значения примера (`DEBUG=1`, `LOG_LEVEL=debug`) убери.
- Ключ контейнера — это и его DNS-алиас в сети сервиса. Переименовал ключ (или скрипт переименовал сервис compose, см. `notes`) — поменяй `dependsOn`, `networkVia` и хосты в env, которые на него ссылаются.
- `report.json`:
  - `containers` — какой сервис compose стал каким ключом;
  - `secrets` — ключи, вынутые из env, с примером значения апстрима. Один и тот же ключ из разных контейнеров — одна строка общего env-файла. Ложное срабатывание (`*_KEY` с несекретным значением) верни в `environment`. Добавь `secrets.env = ./secrets.yaml;` (шаг 4);
  - `postgres` — сервис `report.postgres.service` стал `needs.postgres`: этот хост в env приложения замени на `postgres`, пароль БД — в секреты;
  - `port` — `candidates`: выбери контейнер с UI (гость `networkVia` может нести `port`, публикует его владелец); `null`: порт в compose не объявлен, возьми его из доков;
  - `unmapped`, `notes`, `dropped` — закрой в файле или вынеси в отчёт. Хост-пути вне проекта не переносятся: данные — под `/var/lib/<name>`, файл-конфиг — `"${./file}:/target:ro"` из каталога сервиса.

## 3. Вопросы пользователю

`AskUserQuestion`, до 4 вопросов за вызов. Первая опция — рекомендация, в описании — почему, со ссылкой на факт из доков апстрима.

| Поле | Дефолт | Как решать |
|---|---|---|
| `subdomain` | короткое имя назначения (`budget`, `docs`, `rss`) | не `auth`/`traefik` и не занятые (flake check проверит) |
| контур | приватный | `public = true` — только если нужен доступ без tailnet; `tailnet` — только для клиентов, которым нужен `*.ts.net` |
| `auth` | `one_factor` | политика Authelia — на весь поддомен, без исключений по путям. Нативные клиенты или API → `bypass` (побеждает остальное); только браузер и есть trusted header → `one_factor` + header-auth на `Remote-User`; админка или чувствительные данные → `two_factor`. OIDC-провайдера в Authelia нет |
| `needs.postgres` | выделенный, если в compose есть Postgres | общий кластер пока отклоняется assertion; спроси, только если приложение умеет SQLite |
| `egress` | `true` | `false`, если приложению не нужен интернет (нет фидов, вебхуков, загрузки моделей) |
| секреты | имена из `report.secrets` | покажи список, значения генерирует и шифрует человек |
| `healthcheck`, `startTimeout` | из compose, доков или конфига образа | `test` выполняется через `/bin/sh -c`, проба — из бинарей образа; долгий первый старт → `startPeriod` покрывает прогрев, `startTimeout` больше него |
| `health.external`, `health.path` | как `public` | проба sentinel с внешнего хоста; путь, отвечающий без логина |
| `dashboard` | есть, если у сервиса есть UI | `category` — из `rg 'category =' services modules`, новая, если ни одна не подходит; `icon` — встроенная иконка Raycast (`archive`, `chat`, `dollar`, `film`, `globe`, `grafana`, `lock`, `play`, `shield`, `tv`), по умолчанию `globe` |

## 4. Файл сервиса

Правила ниже `nix flake check` не ловит:

- Данные — подкаталоги `/var/lib/<name>/<sub>`, по одному на назначение (`data`, `media`, `config`).
- Образы linuxserver и прочие на s6-overlay: пользователь через `PUID`/`PGID` в env, без `user` и `--init`.
- `connectsTo`: к чужому контейнеру обращайся по полному имени `<target>-<key>`, короткий алиас `<key>` может совпасть со своим.
- URL-переменные приложения (`BASE_URL`, `APP_URL`, `*_ORIGIN`) — `https://<subdomain>.yoshintame.space`.
- Header-auth (`one_factor` + `Remote-User`): Traefik приходит в контейнер с адреса шлюза сети сервиса, доверенная сеть прокси — пул Podman `10.89.0.0/16`.
- `dashboard.iconUrl` = `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/<slug>.png`; проверь, что отвечает 200.
- `public = true` публикует только ingress cloudflared. CNAME `<subdomain>` на `<tunnelId>.cfargotunnel.com` (proxied) в Cloudflare создаёт человек, `tunnelId` — в `modules/infra/options.nix`.
- Секреты: в файле только `secrets.env = ./secrets.yaml;`. Пароль Postgres не задавай в `needs.postgres.password`: `POSTGRES_PASSWORD` и строка подключения приложения с тем же паролем идут в тот же env. Значения в env без кавычек.

Файл `secrets.yaml` шифрует человек: строка на каждый ключ из `report.secrets`, запуск из корня репо (правило sops и путь зависят от каталога), открытый текст на диск не пишется:

```fish
set pg (openssl rand -hex 32); set admin (openssl rand -hex 16)
printf '<name>-env: |\n  POSTGRES_PASSWORD=%s\n  DATABASE_URL=postgres://<user>:%s@postgres/<db>?sslmode=disable\n  ADMIN_PASSWORD=%s\n' $pg $pg $admin \
  | sops encrypt --filename-override services/<name>/secrets.yaml --output services/<name>/secrets.yaml
```

Пока его нет, eval падает на `path … does not exist`. Для `nix flake check` до шифрования годится заглушка с фиктивными значениями той же раскладки: sops-nix проверяет файл только при сборке. В коммит идёт только зашифрованный файл.

## 5. Проверка

1. `git add -N services/<name>` — флейк видит только tracked-файлы.
2. `nix flake check`. Каждое сообщение assertion говорит, что поправить; не обходи его через `extraOptions`.
3. После шифрования секрета — `nix run .#dev-<name>`: все контейнеры healthy, приложение отвечает на `127.0.0.1:<hostPort>`. `connectsTo` в dev не воспроизводится, `egress = false` соблюдается только под podman.
4. Коммит — `/git-commit`. Деплой — `/homelab-deploy`, push только по просьбе пользователя.

## 6. Отчёт

- Выбранные поля и основание для каждого.
- Ручные шаги человека: шифрование `secrets.yaml`, CNAME для `public`, первый логин или создание админа.
- Незакрытые `unmapped` и `notes` из `report.json`.
