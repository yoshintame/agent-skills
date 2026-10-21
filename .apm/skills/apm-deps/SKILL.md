---
name: apm-deps
description: Глобальные MCP-серверы и пакеты скилов через APM.
---

У глобальных MCP-серверов и пакетов скилов Claude Code и Codex один источник: `$DOTFILES/modules/home/apm/config/apm.yml` (`targets: [claude, codex]`). Меняй их только там. Не через `claude mcp add`, не через `codex mcp add`, не коннектором claude.ai и не ручной правкой `~/.claude.json` или `~/.codex/config.toml`: сервер окажется только у одного провайдера, а `~/.codex/config.toml` перелинковывается при каждом switch, и ручные правки пропадают.

## MCP-сервер

Запись в `dependencies.mcp`, всегда с `registry: false`:

```yaml
- name: example
  registry: false
  transport: stdio
  command: bunx            # один бинарь; все аргументы — в args
  args: [-y, 'example-mcp@1.2.3']
  env:
    EXAMPLE_TOKEN: ${EXAMPLE_TOKEN}
- name: example-remote
  registry: false
  transport: http
  url: https://example.com/mcp
```

- **Секрет** — в `apm.yml` только `${VAR}`, значение лежит в SOPS `$DOTFILES/modules/home/apm/secrets.yaml`. Не читай и не печатай его: пользователь добавляет его через `sops <file>`, либо значение пайпится из 1Password (`op://`-ссылку найди через `/op-secrets`, запускай вне песочницы):

  ```
  VAR="op://<vault>/<item>/<field>" op run -- sh -c 'printf %s "$VAR" | jq -Rs . | sops set --value-stdin "$DOTFILES/modules/home/apm/secrets.yaml" "[\"VAR\"]"'
  ```

  `dot:mcp` падает, если какого-то `${VAR}` нет в SOPS.
- **Секрет в HTTP-заголовке** — codex-адаптер APM пишет `${VAR}` в заголовки дословно. Для Codex добавь маппинг в `extra:` (`bearer_token_env_var` для `Authorization: Bearer`, `env_http_headers` для остальных заголовков) и экспортируй переменную для рантайма Codex строкой `set -gx VAR ${VAR}` в `$DOTFILES/modules/home/apm/config/mcp-secrets.fish.tmpl`. Codex увидит её только при запуске из fish-шелла, открытого после рендера, но не из GUI.

  ```yaml
    headers:
      Authorization: Bearer ${EXAMPLE_TOKEN}
    extra:
      bearer_token_env_var: EXAMPLE_TOKEN
  ```
- **OAuth-сервер** — только `url`. APM вход не выполняет: после установки пользователь логинится один раз в каждом провайдере — в Claude `/mcp` → Authenticate, в Codex `codex mcp login <name>`.
- **Смена транспорта** (stdio ↔ http) — сначала `claude mcp remove <name> -s user` и `codex mcp remove <name>`, иначе APM сольёт новые поля со старой записью и сервер не стартует.
- **Удаление** — убери запись, примени, затем удали остаток из `claude mcp list` / `codex mcp list` теми же двумя командами.

Применяй в `$DOTFILES`, вне песочницы, через `mise run dot:mcp`: он расшифровывает SOPS в env одного процесса `apm install` и возвращает ссылку `~/.apm/apm.lock.yaml` в dotfiles. Если менялся `mcp-secrets.fish.tmpl`, запускай вместо него `mise run dot:link`: он рендерит шаблон без sudo и сам вызывает `dot:mcp`. Не `dot:rebuild`: он требует sudo и делает `git add -A` по всему грязному дереву. Проверка — `claude mcp get <name>` и `codex mcp list`. Инструменты появляются только в сессиях, запущенных после установки: скажи пользователю открыть новую, а не ищи их в текущей.

## Пакеты скилов

В `dependencies.apm` — git-зависимости (`git:`, `ref:`, опционально подмножество `skills:`). Применяй через `mise run dot:apm install`, никогда не голым `apm install --global`: обёртка держит lock слинкованным в dotfiles.

Смена пакета, который поставляет скил с тем же именем, требует полного `mise run dot:apm install`. Точечный `apm update <pkg>` удаляет файлы старого провайдера, но не разворачивает новый, ранее затенённый, и скил молча пропадает.

## Коммит

В `$DOTFILES`: `apm.yml`, `apm.lock.yaml`, а также `secrets.yaml` и `mcp-secrets.fish.tmpl`, если они менялись.
