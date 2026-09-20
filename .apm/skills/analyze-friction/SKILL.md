---
name: analyze-friction
description: Мера фрикшена агента по истории транскриптов Claude Code — sandbox-bypass, violations, застрявшие retry-loops → ранжированные кандидат-диффы конфига. Use when asked to measure or reduce agent friction, audit sandbox/permission pain, find what to add to allowWrite/allowedDomains/excludedCommands, or "почему агент постоянно байпасит песочницу".
---

# /analyze-friction

Каждый sandbox-обход и violation — лишний фрикшен, и разбирать его руками по сырым транскриптам не масштабируется. Скрипт сканирует `~/.claude/projects/**/*.jsonl` и выдаёт **ранжированные кандидат-диффы конфига**, а не сырой лог: что добавить в `allowWrite` / `allowedDomains` / `excludedCommands`, какие команды застревают в retry-loop.

## Запуск

```bash
bun ~/.claude/skills/analyze-friction/scripts/miner.ts              # полный скан корпуса (~4GB, чанки ≤128MB)
bun ~/.claude/skills/analyze-friction/scripts/miner.ts --rollup-only # переиспользовать последний скан (быстрая итерация по роллапам)
```

Корпус большой — единый CTAS OOM'ится, поэтому скан чанкуется пофайлово (тот же приём, что в `find-session`). `--rollup-only` переиспользует `$TMPDIR/friction.duckdb` + дамп строк, не перечитывая корпус.

## Что меряется

Два класса событий:

- **bypass** — `tool_use` Bash с `$.dangerouslyDisableSandbox='true'`; команда в `$.command`.
- **violation** — `tool_result` по OS/прокси-сигнатурам: `operation not permitted` → `fs-perm-denied`, `failed to verify certificate`/`OSStatus -26276` → `tls-osstatus`, `IncompleteRead` → `proxy-incompleteread`, `Connection refused` → `net-refused`, `sandbox_violations`.

Каждый violation коррелируется к вызвавшей команде через `tool_use_id` (`assets/friction.sql` экспонирует поле, которого нет в `find-session/cc.sql`: у `tool_use` — `$.id`, у `tool_result` — `$.tool_use_id`). Составные команды раскладываются `scripts/decompose.py` (переиспользует `decompose_command` из хука `smart_approve.py`) — лидер это первый нетривиальный под-сегмент, а не обёртка `echo/cd/export`.

## Таксономия → ось фикса

| Класс | Ось лечения |
|---|---|
| `fs-perm-denied` | `sandbox.filesystem.allowWrite` (путь) |
| `net-refused` | `sandbox.network.allowedDomains` (host) |
| `proxy-incompleteread` / `tls-osstatus` | `sandbox.excludedCommands` (бинарь) |
| bypass-промпт | `permissions.allow` (если безопасно) |
| tool-invocation (кривой cwd/флаг/повтор) | фикс скила/обёртки, НЕ конфиг |

## Как читать вывод

- **`violation` — ground truth** (ОС реально сказала «нет»); **`bypass` — уточняющий срез** (часть — сессии в `bypassPermissions`, где флаг ставится профилактически). Чинить по violation-классам.
- **Кандидаты — вход для триажа, не авто-дифф.** Не всякий `fs-perm-denied` → `allowWrite`:
  - `~/.ssh/**`, `~/.config/gh/**`, `~/.dotfiles/**/settings.json`, `~/.claude/**` — это защита работает (expected-deny), не открывать; такие команды лечатся `excludedCommands` (ssh/gh уже там) или остаются под deny.
  - `net-refused` на `localhost`/`127.0.0.1`/`0.0.0.0`/private-IP — локальный сервис не поднят, не блок песочницы; не аллоулистить.
  - **Сигнатура ≠ провал**: успешный прогон (`vitest passed`, `bun add Saved lockfile`) может нести сигнатуру в выводе (`nice() failed`, под-варнинг) и попасть в violation ложно — сверяйся с реальным исходом команды.
- `ps`/`lsof`/`nice` под песочницей режутся на syscall-уровне (перечисление процессов, как fs.watch) — лечится только `excludedCommands`, не путём.

## Форвард-захват (опц.)

Майнер работает по накопленной истории без новой инфры. Инкремент без скана — PostToolUse-хук в `friction.jsonl` (не реализован; майнеру не обязателен).
