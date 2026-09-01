---
name: cc-model-reset
description: Reset the Claude Code default model back to the pinned claude-opus-4-8[1m] after the VSCode native model picker clobbered it. Use when the default model "slipped"/reset (e.g. to sonnet or haiku), a session opened on an unexpected model, or the user says "опять слетела модель", "верни дефолтную модель", "reset default model".
---

Дефолтная модель Claude Code (`~/.claude/settings.json` → `model`) периодически слетает с закреплённой `claude-opus-4-8[1m]`: нативный пикер расширения персистит любой выбор прямо в этот ключ, а самой 4.8 в списке пикера нет (только тир-алиасы и их 1M-последние). Полный разбор — `problem` в vault: [claude-code-default-model-drifts.md](/Users/yoshintame/Documents/obsidian/yoshintame/projects/ai-agent-config/seeds/problems/claude-code-default-model-drifts.md).

## Фикс

Одной командой:

```bash
mise run cc:model-reset
```

Задача через `jq` ставит `model = "claude-opus-4-8[1m]"` в оригинале dotfiles (`~/.dotfiles/modules/home/claude/config/settings.json`; `~/.claude/settings.json` — симлинк на него, подхватывает живьём). В расширении применяется с новой сессии. Идемпотентна — повторный запуск безопасен.

Sandbox отключать не нужно: цель записи `~/.dotfiles/**` — в write-allow. Выведи строку `cc:model-reset: model = …` пользователю как подтверждение.

## Не путать

Это откат **дефолта**. Сменить модель только на текущую сессию, не трогая дефолт, — не сюда: `/model <alias>` в session-only режиме. Нативный дропдаун «switch model» — ровно то, что ломает дефолт; его не использовать.
