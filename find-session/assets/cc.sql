-- OOM guard: the view re-parses the whole JSONL corpus on every query. On a
-- large corpus a full scan/aggregate exhausts RAM unless DuckDB drops input
-- ordering, caps parser parallelism, and is allowed to spill to disk. All three
-- are required — dropping any one OOMs on a GROUP BY over the whole corpus.
-- The JSON reader's own buffers do NOT spill: a single CTAS over the full glob
-- can OOM regardless of memory_limit. Snapshot builds therefore go through the
-- *_src(files) macros in bounded batches (see search.ts build()).
SET preserve_insertion_order = false;
SET threads = 3;
SET temp_directory = '/tmp/duckdb-cc-spill';

CREATE OR REPLACE MACRO msg_src(pat) AS TABLE
WITH raw AS (
  SELECT json, regexp_extract(filename, '/projects/([^/]+)/', 1) AS project
  FROM read_json_objects(pat,
                         format='newline_delimited', ignore_errors=true, filename=true)
  WHERE json->>'$.type' IN ('user','assistant')
),
strs AS (
  SELECT project, json->>'$.sessionId' AS session_id, json->>'$.timestamp' AS ts,
         'user' AS kind, NULL AS tool, json->>'$.message.content' AS text
  FROM raw
  WHERE json->>'$.type'='user' AND json_type(json->'$.message.content')='VARCHAR'
),
blocks AS (
  SELECT project, json->>'$.sessionId' AS session_id, json->>'$.timestamp' AS ts,
         json->>'$.type' AS rowtype, block
  FROM raw,
       unnest(CASE WHEN json_type(json->'$.message.content')='ARRAY'
                   THEN CAST(json->'$.message.content' AS JSON[]) ELSE [] END) AS u(block)
)
SELECT * FROM strs
UNION ALL
SELECT project, session_id, ts,
  CASE block->>'$.type' WHEN 'text' THEN rowtype ELSE block->>'$.type' END AS kind,
  block->>'$.name' AS tool,
  CASE block->>'$.type'
    WHEN 'text'        THEN block->>'$.text'
    WHEN 'thinking'    THEN block->>'$.thinking'
    WHEN 'tool_use'    THEN block->>'$.input'
    WHEN 'tool_result' THEN block->>'$.content'
    ELSE block::VARCHAR END AS text
FROM blocks;

CREATE OR REPLACE VIEW msg AS
SELECT * FROM msg_src('/Users/yoshintame/.claude/projects/**/*.jsonl');

-- Only my real typed messages: kind='user' minus harness injections
-- (slash-command expansions, skill preambles, task notifications, reminders,
-- interrupts, tool-result caveats). IDE-selection rows are kept because the
-- user's typed text follows the <ide_selection> block on the same line.
CREATE OR REPLACE MACRO me_src(pat) AS TABLE
SELECT project, session_id, ts, text
FROM msg_src(pat)
WHERE kind = 'user'
  AND text NOT LIKE '<command-%'
  AND text NOT LIKE '<local-command-%'
  AND text NOT LIKE 'Base directory for this skill%'
  AND text NOT LIKE 'Caveat:%'
  AND text NOT LIKE '<task-notification>%'
  AND text NOT LIKE '<system-reminder>%'
  AND text NOT LIKE '[Request interrupted%'
  AND text NOT LIKE 'API Error%'
  AND text NOT LIKE 'Tool ran without output%';

CREATE OR REPLACE VIEW me AS
SELECT * FROM me_src('/Users/yoshintame/.claude/projects/**/*.jsonl');

-- ─── index-hygiene macros ───
-- Used ONLY by the BM25 cache build (search.ts build()), never by the views
-- above: the msg/me views must keep returning raw tool_use JSON so the raw-SQL
-- escape hatch (json_extract_string(text,'$.file_path')) keeps working.

-- Strip harness/editor blocks from prose anywhere in the string (the me_src
-- filters above are prefix-only and miss mid-line/trailing injections). Replace
-- with a space, then collapse whitespace, so the typed reply survives intact.
CREATE OR REPLACE MACRO strip_injections(t) AS
  trim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(coalesce(t, ''),
          '<ide_selection>.*?</ide_selection>', ' ', 'gs'),
        '<ide_opened_file>.*?</ide_opened_file>', ' ', 'gs'),
      '<system-reminder>.*?</system-reminder>', ' ', 'gs'),
    '\s+', ' ', 'g'));

-- json_extract_string over a value that may not be valid JSON: try_cast first.
CREATE OR REPLACE MACRO jx(t, p) AS json_extract_string(try_cast(t AS JSON), p);

-- tool_use input is a JSON object. Index its identifying fields (paths, command,
-- pattern, query, prompt…), not the brace/escape serialization.
CREATE OR REPLACE MACRO tool_use_fields(t) AS
  concat_ws(' ',
    jx(t, '$.file_path'), jx(t, '$.path'), jx(t, '$.notebook_path'),
    jx(t, '$.pattern'), jx(t, '$.glob'), jx(t, '$.command'),
    jx(t, '$.query'), jx(t, '$.url'), jx(t, '$.description'),
    jx(t, '$.prompt'), jx(t, '$.subagent_type'));

-- …and drop the call outright when it is the search tooling itself, so a session
-- searching its own history stops self-hitting first. Cuts the document (the tool
-- call), not the vocabulary — the words stay indexable in human prose.
CREATE OR REPLACE MACRO tool_use_text(t) AS
  CASE
    WHEN tool_use_fields(t) = '' THEN NULL
    WHEN tool_use_fields(t) ILIKE '%find-session%'
      OR tool_use_fields(t) ILIKE '%search.ts%'
      OR tool_use_fields(t) ILIKE '%open-session.ts%'
      OR tool_use_fields(t) ILIKE '%cc.duckdb%'
      OR tool_use_fields(t) ILIKE '%/cc.sql%' THEN NULL
    ELSE tool_use_fields(t)
  END;

-- What actually enters the index, per block kind. tool_result is dropped: grep
-- output is noise and a read file's content double-indexes the source corpus.
CREATE OR REPLACE MACRO index_text(kind, t) AS
  CASE kind
    WHEN 'tool_use'    THEN tool_use_text(t)
    WHEN 'tool_result' THEN NULL
    WHEN 'image'       THEN NULL
    ELSE nullif(strip_injections(t), '')
  END;
