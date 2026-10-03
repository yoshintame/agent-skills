---
name: op-secrets
description: Секреты из 1Password — использовать, не видя значений.
---

# /op-secrets

Значение секрета не попадает в контекст: ни в вывод команд, ни в файлы, которые ты читаешь. Секрет существует только в env дочернего процесса под `op run`.

## Запуск `op`

- `op` работает только вне sandbox: каждый вызов с `dangerouslyDisableSandbox: true`. Под sandbox — `couldn't connect to the 1Password desktop app`.
- Каждый Bash-вызов — новая сессия `op` и отдельный Touch ID у пользователя. Собирай все `op`-операции шага в один вызов.

## Метаданные — только через `op-meta.ts`

`op item get --format json` отдаёт значения скрытых полей открытым текстом (human-readable вывод их прячет). Item'ы и поля смотри скриптом, он значений не печатает:

```bash
bun <skill-dir>/scripts/op-meta.ts items [--vault V] [--query Q]   # id, vault, category, title, urls
bun <skill-dir>/scripts/op-meta.ts fields <item> [--vault V]       # label, type, filled|empty, op://-reference
```

## Использовать секрет

Reference из `fields` — в env потребителя:

```bash
OPENAI_API_KEY="op://Private/OpenAI/credential" op run -- <cmd>
op run --env-file .env.tpl -- <cmd>    # .env.tpl: KEY=op://vault/item/field — без значений, коммитится
```

`op run` маскирует секрет в stdout/stderr только при точном совпадении. Не запускай под ним то, что печатает производное от значения: `env`, `printenv`, `set -x`, `echo $KEY | base64`, debug-логи с заголовками запросов.

Конфиг без подстановки env: `op inject -i <tpl> -o <file>`. Получившийся файл не читай.

## Секрета нет — запросить у пользователя

```bash
bun <skill-dir>/scripts/op-meta.ts request --title "<Сервис — назначение>" [--category "Secure Note" --field LABEL ...]
bun <skill-dir>/scripts/op-meta.ts wait <item-id> --vault Agent [--timeout 600]
```

`request` создаёт item в vault `Agent` с пустыми полями и открывает его в приложении 1Password. Категория по умолчанию `API Credential` даёт одно скрытое поле `credential`; несколько значений — `--category "Secure Note"` и `--field` на каждое. Сначала напиши пользователю, что вписать в какое поле, затем запусти `request` и `wait` одним Bash-вызовом с `timeout: 600000`. `wait` поллит, пока все скрытые поля не заполнены, и печатает references; exit 2 — таймаут.

## Запрещено

`op read`, `--reveal`, `--otp`, `--no-masking`, JSON-вывод `op item get/create/edit`, `op inject` и `op document get` без `-o`, чтение смонтированного `.env` из 1Password Environments (это FIFO). PreToolUse-hook их блокирует; не обходи через скрипт-обёртку или промежуточный файл.
