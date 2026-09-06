---
name: vault-types
description: Работа с типизированным Obsidian vault через библиотеку и CLI vault-types.
---

# /vault-types

Vault валидируется и мутируется библиотекой `vault-types` (в vault установлена как alias `npm:@yoshintame/vault-types`). Дефолтный агент ошибается в трёх местах: скриптует библиотеку ради интроспекции схем, глушит типы кастами, гоняет запись голым `bun script.ts` мимо `vault-types run`. Ниже — поправки.

## Bootstrap

1. API-документация — published TSDoc: `Read node_modules/vault-types/src/public/index.ts` (+ `migrations.ts`, `config.ts`; все три ≈ 8K токенов). Это единственный источник сигнатур — не угадывать по памяти.
2. CLI-справка: `NO_COLOR=1 bunx vault-types --help`, у подкоманд свой `--help`.
3. Интроспекция схем — чтение файлов `_types/<type>.type` / `_fields/<field>.field` напрямую. Библиотеку открывать только за resolved/runtime данными (инстансы, граф ссылок, счётчики) — не писать скрипт, чтобы «распечатать схему».

## Cwd: vault резолвится от рабочей директории (временный workaround)

CLI открывает vault поиском корня **от cwd** — флага `--root` нет. Из чужого cwd (`~/.dotfiles` и т.п.) он молча откроет **не тот репозиторий** как vault: симптом — `count` в десятки заметок вместо сотен и «0 matched» на заведомо существующих путях; мутация с `--apply` ушла бы в чужое дерево. Из сессии, чей cwd не vault (правило «никогда `cd`»), канонический запуск:

```bash
NO_COLOR=1 bun run --cwd "$OBSIDIAN_VAULT" vault-types eval '(vault) => …'
```

Перед первой мутацией из сомнительного cwd — sanity-check `vault.count({ where: {} })`: сотни — vault, десятки — не туда.

Это заслон на стороне агента, а не фикс: дефект — problem-нота `vault-types-cwd-silent-wrong-vault` в vault, секция удаляется после фикса резолва корня (задача `remove-cwd-workaround-from-skill` проекта vault-types).

## Каналы: eval vs migration-файл

Граница — по весу операции, как в SQL: `psql -c "SELECT …"` никто не оформляет миграцией, а schema change — обязательно файл.

- **`eval`** — эфемерные one-liner'ы: read-запросы и тривиальные одношаговые мутации, где dry-run-план — достаточное ревью. `bunx vault-types eval '(vault) => …'` (`async` поддерживается); семантика записи как у `run`: dry-run по умолчанию, `--apply` пишет. Возврат функции печатается JSON'ом в stdout, план/warnings/итог — в stderr, так что stdout безопасно пайпить в `jq`. Заметки сериализуются проекцией `{ path, basename, type, data }` без body; body — флагом `--body` либо `await note.text()` в самом выражении.
- **Migration-файл + `vault-types run <script>`** — всё, что стоит сохранить, повторить или поревьюить: многошаговые мутации, схемные правки. Runner дополнительно делает codegen, typecheck скрипта и git-clean check.
- Запись в любом канале — никогда голым `bun script.ts`: мимо dry-run-гейта и планов runner'а.

```bash
# read: счётчик
bunx vault-types eval '(vault) => vault.count({ where: { type: "book", "data.status": "reading" } })'

# read: граф
bunx vault-types eval '(vault) => vault.findFirst({ where: { path: "areas/dotfiles.md" } })?.backlinks().map(b => b.note.path)'

# тривиальная мутация: сначала dry-run с планом, потом тот же вызов с --apply
bunx vault-types eval '(vault) => vault.update({ where: { "data.status": "current" } }, { $set: { "data.status": "active" } })'
```

Чтение из собственного скрипта/миграции: `openVault()` → синхронные `findFirst` / `findMany` / `count` с mingo-селектором `{ where }`; body заметки — `await note.text()`.

## Перемещение / переименование файла

Никогда не `mv` и не ручной поиск+фикс `[[wikilinks]]` по vault'у. Move и rename — это мутация `$set: { path }`: библиотека сама находит входящие frontmatter-ссылки и детерминированно переписывает их в том же apply (строки `edit <сосед>.md (~поле)` в плане; embed/heading/alias сохраняются).

```bash
# переместить: сначала dry-run — план покажет move + каскад, потом тот же вызов с --apply
bunx vault-types eval '(vault) => vault.update({ where: { path: "books/dune.md" } }, { $set: { path: "reading/dune.md" } })'

# переименовать (basename меняется → перепишутся входящие [[dune]] → [[dune-notes]])
bunx vault-types eval '(vault) => vault.update({ where: { path: "books/dune.md" } }, { $set: { path: "books/dune-notes.md" } })'

# пачка по селектору
bunx vault-types eval '(vault) => vault.findMany({ where: { "data.status": "archived" } }).map(n => n.update({ $set: { path: "archive/" + n.basename + ".md" } }))'

# папка-инстанс целиком (main + sub-файлы + co-located typed-инстансы): префикс-rewrite по $regex
# replaceAll покрывает и папку, и basename main-файла; parent-ссылки детей и внешние [[old-proj]] перепишет каскад
bunx vault-types eval '(vault) => vault.findMany({ where: { path: { $regex: "^projects/old-proj/" } } }).map(n => n.update({ $set: { path: n.path.replaceAll("old-proj", "new-proj") } }))'
```

- Ссылки в body **не** переписываются — придут как `warning:`; разруливать руками (в этом vault'е связи по конвенции только во frontmatter, так что это редкость).
- Модель видит только `.md` — ассеты (картинки, PDF) в папке-инстансе двигать отдельно (`mv` + проверить `![[embeds]]`).
- Занятый target не роняет пачку — заметка скипается с warning (режим `onPathCollision` в конфиге).
- Если файл просто лежит не в папке своего типа — это не ручной move, а `vault.fix({ where: … }, { moveFiles: true })` / CLI `fix --move-files`.

### Батч-переименование молча теряет move (временный workaround)

Заметка, которая в одном батче одновременно **переименовывается** и **правится каскадом** (её frontmatter ссылается на другую переименовываемую заметку той же пачки), выпадает из плана целиком: файл не двигается, её собственные ссылки не переписываются. Ни warning'а, ни ненулевого exit code; `update()` возвращает `true` и для отброшенной заметки, а итог рапортует `applied — N file(s) written`. Вырожденный и самый частый случай — самоссылка через коллизию слагов (`instances/x.md` с `product: "[[x]]"` при живом `products/x.md`).

Поэтому после **любого** батч-переименования возврат `update()` и строка `applied` не считаются подтверждением:

```bash
# сверить план с диском — в плане должно быть по строке move на каждую заметку
NO_COLOR=1 bun run --cwd "$OBSIDIAN_VAULT" vault-types eval '…' 2>&1 | rg "^  move"
ls <целевая папка>
```

Расходится — переименовывать по одной заметке за вызов. Если пачка уже применена и файлы не переехали: каскад ссылок к этому моменту **уже записан**, так что недостающее — ровно `mv` на оставшиеся пути (не откатывать и не переписывать ссылки заново). После — `bunx vault-types validate`.

Дефект — problem-нота `batch-move-dropped-on-link-cascade` в vault (разбор условия — `batch-move-drop-condition`), секция снимается после фикса (задача `remove-batch-move-workaround-from-skill`).

## Migration-скрипт

```ts
import { defineMigration } from 'vault-types'

export default defineMigration({
  name: 'rename status -> state on projects',
  run: (vault) => {
    vault.update(
      { where: { type: 'project' } },
      { $rename: { 'data.status': 'data.state' } },
    )
  },
})
```

- Runner сам открывает vault, вызывает `run(vault)`, применяет, печатает план/warnings/счётчики и закрывает в `finally`. В теле `run` НЕ вызывать `openVault()`, `vault.apply()`, `vault.close()` и не печатать план вручную.
- Гейт записи: CLI `--apply` форсит запись, `--dry-run` форсит dry-run, иначе решает поле `apply?: boolean` миграции (default false).
- Порядок всегда: `vault-types run migrations/x.ts` → прочитать план → тот же вызов с `--apply`.
- Target-фичи, которых нет: `match:`-селектор с типизацией драфта (P3). Не изобретать его в скриптах.

## Типизация

- Не кастовать возвраты библиотеки: `as Record<string, unknown>` на `FieldDef` / `TypeDef` / результатах глушит уже существующие типы.
- Чистый vault: typed-путь — `openTypedVault()` из `_types/.generated/vault.ts` (codegen), per-type overloads `findMany('project')`.
- Грязный vault (remediation/fix-скрипты): `openTypedVault` непригоден — он открывает со `validate: 'strict'` и бросает на любой ошибке. Канон — `openVault()` и mingo-пути `'data.<field>'` без кастов.

## Автофикс

- CLI-цикл: `bunx vault-types validate` → `fix --dry-run` → `fix`. Из библиотеки то же самое — `vault.fix(selector?, { semantic?, moveFiles?, renameFiles? })` / `note.fix()`: правки буферизуются как обычные мутации до `apply`.
- `fix` без флагов применяет только детерминированные фиксы (порядок полей, однозначная кардинальность). Семантические — `title-format-mismatch`, `field-value-not-in-enum`, `missing-required-field` — только под `--semantic`: они перезаписывают человеческие значения, dry-run обязателен.
- Convergence при `--semantic`: отсутствующее required-поле вставляется пустым стабом → следующий `validate` даёт `required-field-no-default` → заполнить значение (или `default:` в `.type`); повторный прогон сходится. Это ожидаемое поведение, не баг.
- Перемещения файлов — за отдельными флагами `--move-files` / `--rename-files` (или `fixer.renameFiles` в конфиге).
- Тумблеры `fixer.*` и секция `serialization` (минимальные диффы) — в `.vault-types.config.ts`; сигнатуры в `node_modules/vault-types/src/public/config.ts`.

