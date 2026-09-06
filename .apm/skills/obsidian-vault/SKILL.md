---
name: obsidian-vault
description: Конвенции этого Obsidian vault — type-driven модель, размещение и именование файлов, связи только во frontmatter. Используй при любом создании, редактировании или навигации по заметкам в vault ($OBSIDIAN_VAULT, fallback ~/Documents/obsidian/yoshintame).
---

# /obsidian-vault

Персональный Obsidian vault с нестандартной type-driven моделью. Дефолтный агент её ломает: кладёт файлы в папки наугад, дописывает «## Связанные» в тело, именует файлы Title Case. Ниже — только поправки к этому дефолту.

## Тип

Единица классификации — поле `type:` во frontmatter, а не папка (папка производна от типа). Каждый тип описан схемой `_types/<type>.type` (YAML: `description`, `location.folder`, `fields`). `fields` задаёт валидные поля инстанса: shared-ссылки `"[[title]]"` / `"[[linked]]"` / `"[[tags]]"` плюс inline-поля (`name`, `kind: option|url|plain|number`, `values`, `default`, `required`, `from`).

`ls _types/` — это **индекс** всех типов. Не читай `.type` пачкой: это засоряет контекст. Открывай `_types/<type>.type` **только** перед созданием или правкой инстанса этого типа — чтобы frontmatter совпал со схемой (обязательные поля, допустимые `values`).

## Подкатегоризация — `kind:` vs подтип через `extends:`

Деление внутри типа — не свободный выбор, а детерминированное правило. Тест — **schema-divergence delta**:

- **`kind:`** (поле внутри типа) — подварианты делят один lifecycle-словарь статусов, один structural-template тела и один field-set; различие лежит в optional-полях, downstream или роли инстанса. Так живут `task` (feature / bugfix / refactor / hotfix / maintenance), `analysis` (grooming / investigation / optimization / spec-draft), `open-question`, `meeting-type`.
- **`extends:`** (подтип отдельной схемой) — подварианты расходятся в lifecycle-словаре (`scheduled → completed` против `active → resolved`), в structural-template'е тела или в field-set'е сверх нескольких optional. Так живут `dev-task extends task`, `dev-project extends project`, `meeting` / `incident extends event`, `idea` / `problem extends seed`.

Порог: другой lifecycle или дельта больше нескольких optional-полей — территория `extends:`; меньше — `kind:`. Первым фильтром идёт тест на вредное протекание (если держать одним типом, потечёт ли реализация в business-часть): течёт — точно разные типы, а не `kind`.

`extends:` — **single-inheritance by design**: у типа ровно один родитель. Multi-parent в data-model, как и в OOP, — признак неправильной абстракции; правильный ход — разложить на два типа, а не наследовать от двух.

**Folder-hierarchy отражает наследование**: подтип лежит в подпапке базы (`events/meetings/*.md`, `seeds/ideas/*.md`), а не в собственной папке верхнего уровня. Со-локация effort-артефактов перекрывает это тем же образом, что и дефолт: `projects/<proj>/seeds/ideas/<slug>.md`.

`extends:` в vault-types пока reserved — парсер не мёржит поля базы, поэтому подтип носит полную схему вручную, дублируя базовые поля. Не блокер: подтип валидируется как самостоятельный тип.

Canonical-разбор правила: `projects/effort-management/analysis/kind-vs-type-inheritance.md`.

## Модель эффорта — какие роли обязаны стоять отдельно

Дефолт агента — слепить всю историю в один док: триггер первой секцией, разбор второй, фикс третьей. Здесь так нельзя: каждая роль — отдельный артефакт.

**Intent-роль обязательна.** Как только работа порождает `analysis`, `task` или спеку, её причина обязана быть читаема отдельным артефактом — `idea` (additive, «надо бы X») или `problem` (corrective, «нечто сломано»). Интент, вписанный первой секцией в тело analysis, — hygiene violation того же класса, что история в спеке. Единственная альтернатива — **inheritance**: если intent уже зафиксирован upstream (originating-seed рутины, rationale спеки, контекст decision, upstream-task), дубль не заводится, роль уже занята. Порог: работа без артефакт-графа (мысль в daily-note) под правило не подпадает — seed на каждый чих не нужен.

**Corrective chain** — фолт раскладывается по ролям, а не пишется одной простынёй:

```
problem     «сломано» — вход, деферрабельный (лежать open месяцами легитимно)
  → analysis kind: investigation   «почему» — разбор причины, если он нетривиален
  → task                            «делаю фикс»
  → knowledge                       переиспользуемый обход / понимание
  [+ incident                       если фолт манифестировал во времени]
```

Звенья опциональны — входить можно на нужной высоте (очевидный фикс схлопывает цепочку в `knowledge`). Кроме `problem`: он заводится на любой фолт, чей бы код ни был, — это corrective intent-роль, и фикс без него будет embedded intent. Ownership-разрез решает лишь, **бывает ли следом `task`**: свой код чинится в корне, поэтому `task` есть; по чужому тулу или среде `task` не бывает вовсе, цепочка заканчивается обходом.

**Occurrence и fault — разные оси.** `event` — база «нечто произошло во времени»; `meeting` и `incident` — её подтипы. `incident` держит только occurrence-line и линкует фолт полем `problem:`: рестарт закрывает `incident: resolved`, а корневой баг ещё месяц лежит `problem: open`. Одна `problem` порождает сколько угодно `incident`-ов.

**Recurring — это `routine`**, а не project со странным статусом и не одноразовая task. Рутина садится между `area` и `project`: конфиг повторения, шаблон, накопленное знание, никакого DoD. Occurrence — всегда типизированный файл (`task` или `project` по `occurrence-kind`), не inline-чекбокс: иначе не спросить «платил ли в июле». Occurrences колоцируются под рутиной; стенсилы — полноценные task-ноты с frontmatter в `routines/<slug>/template/`, маркер заготовки даёт локация, а не отсутствие типа. Intent-роль occurrences наследуют от рутины — свой seed каждому не заводится.

**Boundary-тесты**, когда линия плывёт:

- запланировал и присутствуешь → `event`; сломалось само → `incident` + `problem` на фолт;
- есть окно во времени с impact → добавляется `incident`; стоячий латентный фолт → только `problem`;
- зафиксировано, **что** сломано → `problem`; идёт разбор **почему** → `analysis kind: investigation` рядом;
- обход ещё в работе → внутри `problem`; обход переиспользуемый → выпускается в `knowledge`;
- «не знаю, как сделать X, ничего не сломано» → `open-question` или `analysis`, **не** `problem` (problem требует malfunction).

## Размещение и именование

- Дефолт: инстанс `type: X` лежит в папке из `location.folder` этого типа. Один тип — одна папка — один base.
- **Со-локация effort-артефактов** (перекрывает дефолт): артефакт (`task` / `analysis` / `idea` / `problem` / `open-question` / `decision` / `business-spec` / `implementation-spec` / …) с **ровно одним** проектом в `parent:` кладётся в папку инстанса этого проекта — `projects/<proj>/{tasks,analysis,seeds/ideas,seeds/problems,decisions,spec,…}/<slug>.md`. Глобальная типовая папка — только для мульти-parent и без project-родителя. Со-локованный инстанс — полноценный typed-инстанс (несёт `type:`), НЕ sub-файл; `location-mismatch` warning валидатора на нём ожидаем. Решение: `areas/vault-management/decisions/effort-artifacts-colocated-in-project.md`.
- Инстанс — либо файл `<folder>/<slug>.md`, либо папка `<folder>/<slug>/<slug>.md` + sub-файлы. Папка — только когда инстанс разросся.
- Sub-файлы **не имеют `type:`** — они часть main-файла, не самостоятельные сущности. Файл, который осмысленно цитировать отдельно, — не sub, а отдельный инстанс в своей типовой папке.
- На диске всё **kebab-case** (файлы и папки). `title:` во frontmatter — обычный Title Case или нормальная фраза. Имя файла ≠ `title`.
- **Media-слаг всегда с годом**: инстанс `movie` / `serial` / `anime` / `game` / `book` именуется `<название>-<year>` — `bird-box-2018`, `quake-iii-arena-1999`. Безусловно, даже когда коллизии сейчас нет: ремейки и ремастеры переиспользуют названия плотнее всего. Правило и границы — `areas/vault-management/file-naming-convention.md` § Медиа.
- **Слаг `instance` — с годом покупки**: `<product-slug>-<год из purchase-date>` (`lg-oled55c4-2025`), иначе инстанс неотличим от своего product'а в `[[wikilink]]`. Точность повышается только при конфликте (`-YYYY-MM`, `-YYYY-MM-DD`), покупки одного дня — `-a`/`-b`, чужая вещь несёт имя владельца (`ksusha-glasses-round-black`), пустой `purchase-date` — без суффикса. § «Вещи — тип `instance`» там же.

## Assets (картинки, вложения)

Вложение — sub-файл (без `type:`, часть main-файла): живёт в папке своего инстанса, не в общей свалке.

- **Folder-инстанс** → `<инстанс>/assets/<имя>.<ext>` рядом с main.md (как `projects/kitten-care/assets/`).
- **Flat-инстанс** (`<folder>/<slug>.md`) при первом вложении — **промоуть в folder-инстанс**: `<folder>/<slug>/<slug>.md` + `<folder>/<slug>/assets/`. Вложение — это «инстанс разросся». Безопасно: bases фильтруют по `type:`, `[[slug]]` резолвится по shortest-path — ни запросы, ни ссылки не рвутся.
- Глобальный `_assets/` в корне — **не использовать** (рвёт co-location, отрывает asset от дока).
- Имя — семантичное и vault-уникальное; `<slug-дока>-N.png` — безопасный дефолт (гарантирует резолв wikilink), описательное (`ear-lesion-01.png`) — лучше.
- Embed — wikilink: `![[<имя>.png]]` (vault на shortest-path). Markdown-ссылки `![](…)` не использовать.
- Нативная вставка в Obsidian настроена на `./assets` (`attachmentFolderPath`) — кладёт в `assets/` рядом с заметкой.
- **Скрины, вставленные в чат агенту** — не файлы, а base64 в session-транскрипте: достать байты скриптом `extract-images` (механизм — в глобальном `AGENTS.md`), затем разложить по правилам выше.
- Решение и обоснование: `areas/vault-management/decisions/assets-colocated-in-instance-folder.md`.

## Связи — только во frontmatter

Жёсткий запрет: никаких «## Связанные», «## Related», «См. также», «Связано:» в теле заметки. Связи между инстансами — два поля, массивы `"[[slug]]"`:

- `parent:` — доменно-иерархическая принадлежность («частью чего это»): area / software / organization / родительский проект. Значений может быть несколько — принадлежность двум иерархиям сразу.
- `linked:` — всё прочее смежное; fallback при сомнении.

```yaml
---
title: Change Picker UX
type: project
status: active
parent:
  - "[[git]]"
linked:
  - "[[git-commit-skill]]"
  - "[[vscode]]"
tags: [git, ux]
---
```

## Навигация

Корень — `$OBSIDIAN_VAULT` (fallback `~/Documents/obsidian/yoshintame`). `[[slug]]` резолвится в `<folder>/<slug>.md`, где folder диктуется типом цели.

```sh
ls "$OBSIDIAN_VAULT/_types/"                       # индекс типов
find "$OBSIDIAN_VAULT" -name "*<keyword>*.md"       # по имени файла
rg -l "<keyword>" "$OBSIDIAN_VAULT" -g "*.md"       # по содержимому
rg -l "\[\[<slug>\]\]" "$OBSIDIAN_VAULT" -g "*.md"  # бэклинки на ноту
```

## Прочее

- Содержимое — на русском; английский только в технических идентификаторах и цитатах. Без emoji.
- Полная модель, таксономия и обоснования (читать при необходимости, не по умолчанию): `$OBSIDIAN_VAULT/areas/vault-management/vault-management.md` — хаб области, оттуда роутинг в `spec/storage-model`, `spec/type-groups` и `decisions/`.
