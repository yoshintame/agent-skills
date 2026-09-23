---
name: analyze-friction
description: Мера фрикшена агента по истории транскриптов Claude Code.
---

# /analyze-friction

```bash
bun <skill-dir>/scripts/miner.ts               # полный скан (корпус ~4GB, чанки <=128MB)
bun <skill-dir>/scripts/miner.ts --rollup-only # переиспользовать последний скан, итерировать роллапы
```

Вывод — ранжированные кандидат-диффы конфига, не сырой лог. Единый CTAS по корпусу OOM'ится, поэтому скан чанкуется пофайлово; `--rollup-only` переиспользует `$TMPDIR/friction.duckdb`.

Два класса событий:

- **bypass** — `tool_use` Bash с `$.dangerouslyDisableSandbox='true'`.
- **violation** — `tool_result` по сигнатуре: `operation not permitted`→`fs-perm-denied`, `failed to verify certificate`/`OSStatus -26276`→`tls-osstatus`, `IncompleteRead`→`proxy-incompleteread`, `Connection refused`→`net-refused`, `sandbox_violations`.

Violation коррелируется к команде по `tool_use_id` (`assets/friction.sql` добавляет поле, которого нет в `find-session/cc.sql`). Составные команды раскладывает `scripts/decompose.py`; лидер — первый нетривиальный под-сегмент, не обёртка `echo/cd/export`.

## Класс → ось фикса

| Класс | Ось |
|---|---|
| `fs-perm-denied` | `sandbox.filesystem.allowWrite` |
| `net-refused` | `sandbox.network.allowedDomains` |
| `proxy-incompleteread` / `tls-osstatus` | `sandbox.excludedCommands` |
| tool-invocation (кривой cwd/флаг/повтор) | фикс скила, не конфиг |

## Вывод — вход для триажа, не авто-дифф

- `violation` — фактический отказ (эталон); `bypass` переоценивает (сессии в `bypassPermissions` ставят флаг профилактически). Ранжируй по violation.
- Не всякий `fs-perm-denied` → `allowWrite`:
  - `~/.ssh/**`, `~/.config/gh/**`, `~/.dotfiles/**/settings.json`, `~/.claude/**` — защита работает (expected-deny), не открывать.
  - `net-refused` на `localhost`/`127.0.0.1`/`0.0.0.0`/private-IP — сервис не поднят, не блок песочницы.
  - Сигнатура ≠ провал: успешный прогон (`vitest passed`, `bun add Saved lockfile`) несёт сигнатуру от `nice() failed` или под-варнинга и ложно попадает в violation.
- `ps`/`lsof`/`nice` режет sandbox на syscall-уровне (как fs.watch) — только `excludedCommands`.
