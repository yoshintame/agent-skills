---
name: op-secrets
description: Секреты и item'ы 1Password — использовать и разбирать, не видя значений.
---

# /op-secrets

Значение секрета не попадает в контекст: ни в вывод команд, ни в файлы, которые ты читаешь. Секрет существует только в env дочернего процесса под `op run` или внутри процесса `op-meta.ts`.

## Запуск

```bash
OP_ACCOUNT=<account_uuid> bun <skill-dir>/scripts/op-meta.ts <команда> ...
```

- И `op-meta.ts` (1Password SDK), и `op` CLI достают до десктоп-приложения только вне sandbox: каждый вызов с `dangerouslyDisableSandbox: true`.
- `OP_ACCOUNT` — UUID аккаунта. Если не задан в окружении, возьми `account_uuid` из `op account list --format json` отдельным Bash-вызовом.
- Один процесс `op-meta.ts` — один Touch ID на все его операции. Каждый вызов `op` CLI — отдельный Touch ID. Поэтому всё, что умеет `op-meta.ts`, делай через него.
- Не вызывай `op` CLI в одном Bash-вызове с `op-meta.ts` и не обрывай его вывод через `| head`: после такого relay SDK в приложении ломается, и 1Password сам выключает Settings → Developer → «Integrate with 1Password SDKs». Симптом — `IPC operation failed: -3` на любой команде. Попроси пользователя снова включить галочку.

## Метаданные

`op item get --format json` отдаёт значения скрытых полей открытым текстом. Item'ы и поля смотри только через `op-meta.ts`:

```bash
op-meta.ts items [--vault V] [--query Q] [--archived]   # id, vault, category, title, websites, tags
op-meta.ts fields <item> [--vault V]                   # label, type, filled|empty, op://-reference
```

## Использовать секрет

Reference из `fields` — в env потребителя:

```bash
OPENAI_API_KEY="op://<vault-id>/<item-id>/<field-id>" op run -- <cmd>
op run --env-file .env.tpl -- <cmd>    # .env.tpl: KEY=op://... — без значений, коммитится
```

`op run` маскирует секрет в stdout/stderr только при точном совпадении. Не запускай под ним то, что печатает производное от значения: `env`, `printenv`, `set -x`, `echo $KEY | base64`, debug-логи с заголовками запросов.

Конфиг без подстановки env: `op inject -i <tpl> -o <file>`. Получившийся файл не читай.

## Секрета нет — запросить у пользователя

```bash
op-meta.ts request --title "<Сервис — назначение>" [--category SecureNote --fields A,B]
op-meta.ts wait <item-id> --vault Agent [--timeout 600]
```

`request` создаёт item в vault `Agent` с пустыми скрытыми полями (по умолчанию одно — `credential`) и открывает его в приложении 1Password. Напиши пользователю, что вписать в какое поле, затем запусти `wait` с Bash `timeout: 600000`: он поллит, пока все скрытые поля не заполнены, и печатает references. Exit 2 — таймаут.

## Разбор библиотеки

1. `op-meta.ts inventory [--vault V] > $TMPDIR/op-inventory.jsonl` — JSONL по каждому активному item'у: title, category, vault, username, websites, tags, даты, какие скрытые поля заполнены, `hasNotes`, `files`, `unsupportedFields`. Анализируй через `jq`.
2. `op-meta.ts dupes [--vault V]` — группы item'ов с одинаковым значением секрета. Значения и хэши не печатаются.
3. Покажи пользователю план таблицей и дождись одобрения. Применяй только одобренное.
4. Запиши план в `$TMPDIR/op-plan.json` и выполни `op-meta.ts apply $TMPDIR/op-plan.json`:

```json
[
  { "op": "update", "id": "<item-id>", "vault": "<vault>", "title": "...", "tags": ["..."], "websites": ["https://..."] },
  { "op": "archive", "id": "<item-id>", "vault": "<vault>" },
  { "op": "move", "id": "<item-id>", "vault": "<vault>", "to": "<vault>" },
  { "op": "delete", "id": "<item-id>", "vault": "<vault>" }
]
```

`apply` сначала проверяет весь план и при любой проблеме ничего не применяет. Ограничения SDK:

- `move` не выполняется — SDK не умеет переносить. `apply` печатает список для ручного переноса в приложении (мультиселект и перетаскивание).
- Теги только ASCII; кириллические — вручную в приложении.
- `websites` только у Login и Password; убрать последний сайт нельзя.
- Item'ы с `unsupportedFields > 0` (passkeys и т.п.) `update` не трогает.
- Архивные item'ы SDK не читает и не меняет.
- `delete` необратим. По умолчанию предлагай `archive`, `delete` — только по явному решению пользователя.

## Запрещено

`op read`, `--reveal`, `--otp`, `--no-masking`, JSON-вывод `op item get/create/edit`, `op inject` и `op document get` без `-o`, чтение смонтированного `.env` из 1Password Environments (FIFO), свой код поверх 1Password SDK, печатающий значения. Часть из этого блокирует PreToolUse-hook; не обходи его через скрипт-обёртку или промежуточный файл.
