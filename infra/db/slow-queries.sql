-- Run in Supabase Dashboard > SQL Editor (or Database > Query Performance shows the same data).
-- pg_stat_statements is enabled on Supabase by default. Look at the TOP of each list after a week of real traffic.

-- 1) Where the database spends its time
SELECT round(total_exec_time::numeric, 0) AS total_ms, calls, round(mean_exec_time::numeric, 2) AS mean_ms,
       round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 1) AS pct, left(query, 160) AS query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;

-- 2) Slowest on average (ignore calls < 20)
SELECT calls, round(mean_exec_time::numeric, 1) AS mean_ms, round(max_exec_time::numeric, 0) AS max_ms, left(query, 160) AS query
FROM pg_stat_statements WHERE calls >= 20 ORDER BY mean_exec_time DESC LIMIT 20;

-- 3) Tables that are read by scanning everything (candidates for an index)
SELECT relname, seq_scan, seq_tup_read, idx_scan, n_live_tup
FROM pg_stat_user_tables WHERE seq_scan > 100 AND n_live_tup > 10000 ORDER BY seq_tup_read DESC LIMIT 15;

-- 4) Indexes that are never used (after at least a month of traffic; the unique and primary-key ones must stay)
SELECT s.relname AS table, s.indexrelname AS index, s.idx_scan, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 20;

-- 5) Connections by role (Free plan / Nano: about 60 in total)
SELECT usename, state, count(*) FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC;
