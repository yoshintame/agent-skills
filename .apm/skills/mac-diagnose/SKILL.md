---
name: mac-diagnose
description: Диагностика тормозов Mac lasthaze-mbp.
---

## 1. Снимок сейчас

Первый вызов — `mac-metrics snapshot` вместо ручных `ps` и `top`. За секунду он отдаёт CPU, load, память в разбивке Activity Monitor, давление памяти, swap, топ приложений и процессов по памяти и CPU (с pid и возрастом процесса), браузеры по типам процессов. `-json` — для разбора, `-interval 3s` — для устойчивых CPU%, `-top N` — длина таблиц.

- `MEMORY` — `phys_footprint`, колонка «Память» в Activity Monitor, включая сжатую память. RSS из `ps` и `top -stats rsize` бывает меньше в разы, с ним не сверяй.
- Процессы уже отнесены к приложению: helper'ы — к своему `.app` (`[Paseo]`), XPC-сервисы и WebKit-процессы — к ответственному приложению. Своё отнесение (`responsibility_get_pid_responsible_for_pid`, разбор путей `.app`) не пиши.
- `(command)` — CLI-процессы, сгруппированные по `argv[0]`: `claude`, `node`, `esbuild`.
- `Hidden N` — процессы root и других пользователей, снимок их не читает: `WindowServer`, `kernel_task`, `coreaudiod`, `mds_stores`. Если видимые процессы не объясняют `busy`, смотри их через `top -l 2 -o cpu -n 10 -stats pid,command,cpu,mem` — `top` без sudo видит всех.
- `power_mw` в JSON на окне в секунды недостоверен, выводов по нему не делай.

Нет `mac-metrics` в PATH — модуль `mac-metrics` в dotfiles не применён, работай через CLI.

## 2. История в Grafana

Снимок не видит, когда началось, что росло и не пропал ли виновник. Это даёт Prometheus homelab: MCP `grafana-homelab`, инструмент `query_prometheus`, `datasourceUid: "prometheus"`. У всех серий Mac `host="lasthaze-mbp"`, шаг 15 с, отставание 5–20 с; дыры в рядах — Mac спал.

| Вопрос | PromQL, range за 1–3 ч |
|---|---|
| когда началось | `mac_memory_pressure_level` (1 normal, 2 warning, 4 critical), `node_memory_swap_used_bytes`, `node_memory_compressed_bytes`, `1 - avg(rate(node_cpu_seconds_total{host="lasthaze-mbp",mode="idle"}[1m]))` |
| кто вырос по памяти | `topk(10, delta(mac_app_memory_footprint_bytes{host="lasthaze-mbp"}[1h]))` |
| кто ест CPU, в ядрах | `topk(10, sum by (app) (rate(mac_app_cpu_seconds_total{host="lasthaze-mbp"}[5m])))` |
| один разбухший процесс | `topk(5, mac_app_process_footprint_max_bytes{host="lasthaze-mbp"})` |
| браузер по типам процессов | `mac_browser_memory_footprint_bytes{host="lasthaze-mbp"}`, метки `browser`, `process_type` |

- `app="other"` — сумма мелких приложений. Своё имя приложение получает, как только хоть раз займёт 64 МиБ или 5% CPU; его счётчики идут с этого момента.
- `mac_*_energy_joules_total` не сверены с реальной мощностью, выводов по ним не делай.
- Процессов root (`WindowServer`, `kernel_task`) в истории нет.

Пользователю дай ссылку на дашборд `https://grafana.yoshintame.space/d/mac` с диапазоном вокруг начала проблемы.

## 3. Порядок

Снимок, затем история по моменту начала и по подозреваемым, затем точечный разбор кандидата через CLI (`sample`, `footprint`, `lsof`). В выводе для каждого виновника — с какого времени и по какой метрике это видно.
