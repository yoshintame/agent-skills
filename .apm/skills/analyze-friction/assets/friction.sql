-- Sibling init for the friction miner. NOT a fork of find-session/cc.sql:
-- it exposes the one field cc.sql omits — tool_use_id — so a violation
-- (tool_result) can be joined back to the tool_use that caused it.
--   tool_use    → $.id
--   tool_result → $.tool_use_id
-- Same OOM guard as cc.sql: the macro re-parses JSONL on every call, so a full
-- glob CTAS OOMs; callers must batch via fr_src(files) (<=128MB, see miner.ts).
SET preserve_insertion_order = false;
SET threads = 3;
SET temp_directory = '/tmp/duckdb-friction-spill';

CREATE OR REPLACE MACRO fr_src(pat) AS TABLE
WITH raw AS (
  SELECT json, regexp_extract(filename, '/projects/([^/]+)/', 1) AS project
  FROM read_json_objects(pat,
                         format='newline_delimited', ignore_errors=true, filename=true)
  WHERE json->>'$.type' IN ('user','assistant')
),
blocks AS (
  SELECT project, json->>'$.sessionId' AS session_id, json->>'$.timestamp' AS ts,
         json->>'$.type' AS rowtype, block
  FROM raw,
       unnest(CASE WHEN json_type(json->'$.message.content')='ARRAY'
                   THEN CAST(json->'$.message.content' AS JSON[]) ELSE [] END) AS u(block)
)
SELECT project, session_id, ts,
  block->>'$.type' AS kind,
  block->>'$.name' AS tool,
  CASE block->>'$.type'
    WHEN 'tool_use'    THEN block->>'$.id'
    WHEN 'tool_result' THEN block->>'$.tool_use_id'
    ELSE NULL END AS tuid,
  CASE block->>'$.type'
    WHEN 'tool_use'    THEN block->>'$.input'
    WHEN 'tool_result' THEN block->>'$.content'
    ELSE block::VARCHAR END AS text
FROM blocks;
