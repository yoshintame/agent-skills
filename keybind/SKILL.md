---
name: keybind
description: Design and implement new keyboard bindings across system (Karabiner / Hammerspoon) and per-app (VSCode / Cursor) layers, following the user's keybinds architecture from the Obsidian vault. Use when the user asks to add, change, or evaluate a keybind, or when they describe an action they want to bind.
---

# Keybind

Workflow для добавления/изменения клавиатурных биндов в инфраструктуре пользователя. Полная философия и архитектура — в Obsidian vault, **читай оттуда**, не дублируй из памяти.

Эта версия — общая часть. Управление инстансами `keybind-idea` (создание / редактирование / status transitions) добавляется позже, когда будет реализован `obsidian-type-mcp`. Пока что skill фокусируется на дизайне и имплементации в реальных конфигах.

## Vault как источник правды

Перед началом любой задачи прочитать соответствующие документы:

| Документ | Когда читать |
|---|---|
| `~/Documents/obsidian/yoshintame/projects/keybinds-architecture/keybinds-architecture.md` | **Всегда.** Две оси (scope × direct/leader), hyper, action vs binding, чеклист «принципы при добавлении нового бинда». |
| `~/Documents/obsidian/yoshintame/projects/keybinds-system/keybinds-system.md` | Системные бинды — абстрактная модель (что забиндено, какие слои). Таблиц самих биндов тут нет. |
| `~/Documents/obsidian/yoshintame/projects/hammerspoon-keybindings.md` | **Hammerspoon: App Launcher + leader `F18`.** Здесь живут таблицы биндов leader-дерева — правится при любой правке `main.lua`. |
| `~/Documents/obsidian/yoshintame/projects/karabiner-hyperlayers.md` | Karabiner: hyper-слои и sublayers. Таблицы hyper-биндов. |
| `~/Documents/obsidian/yoshintame/projects/keybinds-vscode/keybinds-vscode.md` | VSCode/Cursor хаб. |
| `~/Documents/obsidian/yoshintame/projects/keybinds-vscode/direct-shortcuts.md` | VSCode direct (cmd+...). |
| `~/Documents/obsidian/yoshintame/projects/keybinds-vscode/whichkey-layer.md` | VSCode leader (which-key). |
| `~/Documents/obsidian/yoshintame/projects/proxy-bindings.md` | Shortcuts в third-party приложениях, дёргаемые из Hammerspoon/Karabiner. |
| `~/Documents/obsidian/yoshintame/areas/keybinds.md` | Индекс area. |

Если документация противоречит этому SKILL.md — vault выигрывает; SKILL.md устарел и его надо обновить.

## Алгоритм

### 1. Понять задачу

Что должно произойти, в каких приложениях, как часто. Если описано размыто — уточнить:

- Это нужно везде или в одном приложении?
- Это частое действие (десятки раз в день) или редкое?
- Какой контекст активации — фокус приложения, открыта ли панель, есть ли selection?

### 2. Классификация по двум осям

Применить чеклист из конца `keybinds-architecture.md` («Принципы при добавлении нового бинда»):

1. **Ось 1 — scope**: системное (везде) vs приложение (один).
2. **Ось 2 — активация**: direct (одно нажатие) vs leader (sequence).
3. Если direct — есть свободный слот с 0–1 модификатором? Иначе — hyper или leader.
4. Если leader — какой путь в дереве? Группировка по семантике (`g` git, `f` file, `s` search, …).
5. Sublayer vs терминальное действие — если в группе уже >5 биндов, выделять sublayer.

Записать решение явно: «direct cmd+i в VSCode, потому что AI-чат — частый хоткей, free от дефолтов после снятия Cursor `composerMode.agent`».

### 3. Проверить занятость слотов

**Никогда не предлагать бинд, не убедившись что он свободен.** Зачитать соответствующий конфиг и проверить:

| Layer | Что проверять |
|---|---|
| Karabiner direct + hyper | `~/.dotfiles/modules/karabiner/config/src/hyper-layer-binds.ts` (бинды) и `actions.ts` (action-имена). |
| Hammerspoon leader (`F18 → ...`) | `~/.dotfiles/modules/hammerspoon/config/` — leader-конфиг + sublayers. |
| Hammerspoon App Launcher | `~/.dotfiles/modules/hammerspoon/config/` — `Alt+<letter>` маппинги. |
| VSCode direct | `~/.dotfiles/modules/vscode/config/keybindings.json` — собственные бинды + снятые конфликты. Плюс дефолты VSCode/Cursor (если бинд не `cmd+...`, проверить, занят ли он расширением). |
| VSCode whichkey (leader) | `~/.dotfiles/modules/vscode/config/settings.json` → поле `whichkey.bindings`. |
| Proxy bindings (третьи приложения) | `~/.dotfiles/modules/proxy-bindings/proxy-bindings.yaml`. |

Пути могут устареть — всегда подтверждать `ls`-ом перед чтением. Если нашёл расхождение с этим SKILL.md, сначала чини SKILL.md.

### 4. Предложить варианты

1–3 варианта с обоснованием каждого: почему direct vs leader, почему именно эти модификаторы, что снимаем (если конфликт с дефолтом), как это согласуется с философией. Подсветить trade-off'ы.

Не делать выбор за пользователя на этом шаге, если он сам не попросил «выбери лучший».

### 5. Реализовать после approve

В зависимости от уровня:

- **Karabiner**: правки в `src/hyper-layer-binds.ts` (binding) и `src/actions.ts` (если новый action). Karabiner build — отдельный проект, см. `[[karabiner-build]]` в vault.
- **Hammerspoon**: правки в leader-конфиге. После изменений — `hs.reload()` через Hammerspoon console (или подождать live-reload, если настроен).
- **VSCode direct**: правки в `keybindings.json`. Применяется автоматически.
- **VSCode whichkey**: правки в `settings.json` → `whichkey.bindings`. Применяется автоматически.
- **Proxy bindings**: правки в `proxy-bindings.yaml` + `dot proxy-bindings` (или `dot rebuild`). Если бинд ещё не записан в самом third-party приложении — Hyper Setup mode (`F18 → u → h`), Tab+key в shortcut-диалоге, обратно `F18 → u → h`.

### 6. Verify

Спросить пользователя проверить и подтвердить, что бинд работает в нужном контексте. UI/keymap не тестируется напрямую.

### 7. Свериться с документацией (обязательно)

После того как решение найдено и закоммичено — **обязательно** пройтись по документации keybind'ов в vault и привести её в соответствие. Это не опционально: новый или изменённый бинд, не отражённый в vault, рассинхронизирует документацию с реальным конфигом.

- Обновить заметку того слоя, который правился (таблица биндов, дерево leader-путей). Карта «документ ↔ слой» — в таблице из секции «Vault как источник правды» в начале skill'а.
- Проверить смежное: индекс area `keybinds.md`, перекрёстные ссылки, занятость соседних слотов — не устарело ли что-то ещё от этой правки.
- Если правка сняла конфликтующий дефолт или перенесла действие между слоями — отразить в **обеих** затронутых заметках.

## Правила

- **Direct — дефицитный ресурс.** Не тратить direct-слот на редкое действие. Если действие редкое — leader.
- **0 модификаторов в direct** — только если приложение не работает с текстом (IINA-типа).
- **2+ модификаторов в direct — нет.** Сразу leader или hyper.
- **Hyper-сублееры (S/D/F)** — для расширения direct'ов внутри hyper, а не для отдельных «слоёв». Композиция `Hyper+S+...` работает, потому что S — это sub-modifier внутри hyper-слоя.
- **Leader — одна клавиша**, не комбинация. Это принципиально (см. критику дефолта tmux в `keybinds-architecture.md`).
- **AI-биндинги в VSCode** обязательно используют selection-aware команды (`*.focus`, `addToThread`, `insertAtMention`), а не `*.open`. Иначе теряется selection-to-context.
- **Layout-биндинги в VSCode** — `runCommands` из трёх шагов: `closePanel` → `view.<target>` → reveal активного файла.
- **Конфликтующие дефолты** снимаются явно: `{ "command": "-<original>" }` рядом с новым биндом или в конце файла.
- **Third-party приложения** — никогда не лезть руками в их preferences, всё через `proxy-bindings.yaml` + Hyper Setup mode.

## Anti-patterns

- ❌ Предлагать бинд без проверки реального конфига — «cmd+shift+a свободен» по памяти.
- ❌ Дублировать философию из vault в свой ответ — ссылайся, а не пересказывай.
- ❌ Smart `cmd+...` бинд в VSCode без снятия Cursor-дефолта (`composerMode.agent`, `aichat.newchataction`, и т.п.) — даст конфликт, если пользователь откроет в Cursor.
- ❌ Использовать `*.open` для AI-расширений вместо `*.focus`.
- ❌ Биндить макро-действие в direct «потому что одну клавишу нажимать удобнее» — забивает дефицитные слоты, ломает регулярность системы.
- ❌ Расщеплять одно действие на два бинда (один для Karabiner, один для VSCode) без проверки, не закрывает ли его один уровень. Karabiner работает везде — если действие универсальное, ему место там.
- ❌ Закоммитить бинд и не обновить документацию в vault — конфиг и vault разъезжаются, и следующая сессия проверит занятость слота по устаревшей таблице.

## TODO (после obsidian-type-mcp)

- Создание инстансов `keybind-idea` через MCP (status `proposed` → `exploring`).
- Чтение списка существующих идей при старте сессии для контекста «что в очереди».
- После реализации — авто-апдейт status на `implemented` + ссылка на коммит.
- Inbox-processor: парсинг inline `#kbi` (или общего inline-tag механизма из `[[obsidian-types]]`) в Daily Notes → создание инстансов.

До реализации MCP инстансы создаются обычным путём (`keybind-ideas/<slug>.md` со frontmatter из [[taxonomy-keybind-ideas]]). Skill про них **не знает** и ими не управляет — пользователь сам.
