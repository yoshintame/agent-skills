---
name: git-ref
description: Give a clickable link that opens a GitLens "Search & Compare" view for two git refs in the editor (VSCode/Cursor). Use to review a batch of commits — the ones an AI agent just made, the current feature branch vs master, or two explicit refs. Triggers — "/git-ref", "дай ссылку на сравнение", "открой сравнение в gitlens", "сравни коммиты", "compare commits", "review my commits", "с веткой этой фичи".
---

# /git-ref

Отдаёт в ответе кликабельную ссылку, открывающую в редакторе (VSCode/Cursor) GitLens-сравнение двух refs — лучший интерфейс для ревью пачки коммитов. Команда `gitlens.compareWith` с обоими refs пропускает пикер; deep link матчит уже открытый репозиторий по SHA, поэтому аргумент пути не нужен.

## Когда

Юзер хочет глазами отревьюить набор коммитов: то, что насыпал агент; фиче-ветку против базовой; произвольный диапазон.

## Как определить refs

1. **Явные хэши/refs в аргументах** — `/git-ref <ref1> <ref2>` → сравнить `ref1...ref2`.
2. **Число N** — `/git-ref <N>` → `HEAD~N...HEAD`.
3. **Ветка** («с веткой этой фичи», имя ветки) — `ref1` = базовая ветка (`master`/`main`), `ref2` = tip фиче-ветки. GitLens сам покажет three-dot дифф от merge-base, параллельный прогресс базы в дифф не попадёт.
4. **Без аргументов** — коммиты, которые ты (агент) сделал в этой сессии: `HEAD~N...HEAD` по их числу. Если не уверен — `git rev-list --count @{u}..HEAD` (коммиты впереди upstream); если upstream нет — спроси N у юзера, не угадывай.

Инвариант: `ref1` — база (старое), `ref2` — новое (обычно `HEAD` / tip ветки). GitLens покажет изменения от `ref1` к `ref2`.

## Запуск

```bash
bash ~/.claude/skills/git-ref/scripts/compare-link.sh -C <repo> <ref1> <ref2>
```

`-C <repo>` передавай всегда — cwd между вызовами Bash дрейфует, а молча собранная ссылка по чужому репо выглядит валидной.

Скрипт резолвит refs в полные SHA (чтобы в пути deep link не было слешей из имён веток) и печатает две строки:

- `deep:` — `<scheme>://eamodio.gitlens/link/r/<repoId>/compare/<sha1>...<sha2>?url=<origin|пусто>&path=<repo>` (схема редактора определяется из окружения);
- `redirect:` — `https://vscode.dev/redirect?url=<encoded deep>` — единственная форма, кликабельная в чате (рендерер режет не-http(s) схемы).

## Ответ

В ответе отдай **markdown-ссылку на redirect-форму** + одну строку контекста: какой диапазон сравнивается и `git log --oneline` по нему.

```md
[GitLens compare: <ref1>...<ref2>](https://vscode.dev/redirect?url=...)
```

Авто-открытие (`--open` первым аргументом — скрипт сделает `open` deep-ссылки) — только по явной просьбе «открой» или когда рендера markdown нет (терминал). Если `open` заблокирован песочницей — перезапустить вне её: это открытие URI-схемы редактора, не сеть.

## Заметки

- Ссылка обязана нести `?url=` и/или `?path=` — без обоих GitLens её вообще не парсит (`parseDeepLinkUri` возвращает undefined, молчаливый отказ). Скрипт всегда добавляет `path=<repo_root>`: по нему GitLens не только матчит открытые репо, но и сам подключает репо (`getOrAddRepository`), даже если оно не открыто в окне, принявшем URI.
- `url=` стоит в query **первым и всегда** (пустым, если origin нет) — намеренно: `vscode.dev/redirect` дописывает свой `url=<весь deep link>` в query целевого URI, а `URLSearchParams.get('url')` в GitLens берёт первое вхождение. Без заслона GitLens принимает весь линк за remote и падает в промпт «Unable to find remote → Add Remote». Пустая строка falsy во всех проверках (`RemoteMatchUnneeded`) — remote-флоу пропускается.
- Ручная альтернатива без агента: which-key `enter g k` (Compare References) — интерактивный пикер двух refs.
