-- ============================================================================
-- Lotus Backend database install script
-- ============================================================================
-- Use this script after Prisma has created the base schema.
--
-- Example:
--   npx prisma migrate deploy
--   psql "$DATABASE_URL" -f sql/install.sql
--
-- This script is idempotent and can be re-run safely.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public."BlockMetrics"') IS NULL THEN
    RAISE EXCEPTION
      'Missing table public."BlockMetrics". Run Prisma migrations before sql/install.sql.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Convert BlockMetrics to a hypertable (partitioned by time)
SELECT create_hypertable(
  '"BlockMetrics"',
  'time',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Add compression policy for BlockMetrics (compress after 7 days)
SELECT add_compression_policy(
  '"BlockMetrics"',
  INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Add retention policy for raw BlockMetrics (keep 2 years of raw data)
-- Aggregates are kept indefinitely
SELECT add_retention_policy(
  '"BlockMetrics"',
  INTERVAL '2 years',
  if_not_exists => TRUE
);

-- Hourly Block Metrics Aggregate
CREATE MATERIALIZED VIEW IF NOT EXISTS block_metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  COUNT(*) AS block_count,
  SUM(subsidy) AS total_subsidy,
  SUM(burned) AS total_burned,
  SUM("numTxs") AS total_txs,
  AVG(difficulty) AS avg_difficulty,
  MAX(difficulty) AS max_difficulty,
  MIN(difficulty) AS min_difficulty
FROM "BlockMetrics"
GROUP BY bucket;

SELECT add_continuous_aggregate_policy(
  'block_metrics_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- Daily Block Metrics Aggregate
CREATE MATERIALIZED VIEW IF NOT EXISTS block_metrics_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time) AS bucket,
  COUNT(*) AS block_count,
  SUM(subsidy) AS total_subsidy,
  SUM(burned) AS total_burned,
  SUM("numTxs") AS total_txs,
  AVG(difficulty) AS avg_difficulty,
  MAX(difficulty) AS max_difficulty,
  MIN(difficulty) AS min_difficulty
FROM "BlockMetrics"
GROUP BY bucket;

SELECT add_continuous_aggregate_policy(
  'block_metrics_daily',
  start_offset => INTERVAL '2 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- Weekly Block Metrics Aggregate
CREATE MATERIALIZED VIEW IF NOT EXISTS block_metrics_weekly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 week', time) AS bucket,
  COUNT(*) AS block_count,
  SUM(subsidy) AS total_subsidy,
  SUM(burned) AS total_burned,
  SUM("numTxs") AS total_txs,
  AVG(difficulty) AS avg_difficulty,
  MAX(difficulty) AS max_difficulty,
  MIN(difficulty) AS min_difficulty
FROM "BlockMetrics"
GROUP BY bucket;

SELECT add_continuous_aggregate_policy(
  'block_metrics_weekly',
  start_offset => INTERVAL '2 weeks',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- Monthly Block Metrics Aggregate
CREATE MATERIALIZED VIEW IF NOT EXISTS block_metrics_monthly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 month', time) AS bucket,
  COUNT(*) AS block_count,
  SUM(subsidy) AS total_subsidy,
  SUM(burned) AS total_burned,
  SUM("numTxs") AS total_txs,
  AVG(difficulty) AS avg_difficulty,
  MAX(difficulty) AS max_difficulty,
  MIN(difficulty) AS min_difficulty
FROM "BlockMetrics"
GROUP BY bucket;

SELECT add_continuous_aggregate_policy(
  'block_metrics_monthly',
  start_offset => INTERVAL '2 months',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- Daily Mining Distribution Aggregate
CREATE MATERIALIZED VIEW IF NOT EXISTS mining_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time) AS day,
  "minedBy" AS miner_address,
  COUNT(*) AS blocks_mined,
  SUM(subsidy) AS total_rewards
FROM "BlockMetrics"
GROUP BY day, "minedBy";

SELECT add_continuous_aggregate_policy(
  'mining_daily',
  start_offset => INTERVAL '2 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- Weekly Mining Distribution Aggregate
CREATE MATERIALIZED VIEW IF NOT EXISTS mining_weekly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 week', time) AS week,
  "minedBy" AS miner_address,
  COUNT(*) AS blocks_mined,
  SUM(subsidy) AS total_rewards
FROM "BlockMetrics"
GROUP BY week, "minedBy";

SELECT add_continuous_aggregate_policy(
  'mining_weekly',
  start_offset => INTERVAL '2 weeks',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- Monthly Mining Distribution Aggregate
CREATE MATERIALIZED VIEW IF NOT EXISTS mining_monthly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 month', time) AS month,
  "minedBy" AS miner_address,
  COUNT(*) AS blocks_mined,
  SUM(subsidy) AS total_rewards
FROM "BlockMetrics"
GROUP BY month, "minedBy";

SELECT add_continuous_aggregate_policy(
  'mining_monthly',
  start_offset => INTERVAL '2 months',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_block_metrics_height
  ON "BlockMetrics" (height DESC);

CREATE INDEX IF NOT EXISTS idx_block_metrics_miner_time
  ON "BlockMetrics" ("minedBy", time DESC);
