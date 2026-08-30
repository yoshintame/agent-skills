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
