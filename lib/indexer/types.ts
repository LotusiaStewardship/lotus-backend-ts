/**
 * Type definitions for the generalist blockchain indexer
 *
 * These types define the data structures used for indexing block-level metrics
 * for time-series analysis with TimescaleDB.
 */
import type { Block as NNGBlock } from 'lotus-nng-client'

/**
 * Checkpoint data for tracking indexer sync state
 * Used for reconciliation on startup and reorg detection
 */
export interface Checkpoint {
  /** Block hash of the checkpoint */
  hash: string
  /** Block height of the checkpoint */
  height: number
  /** Block timestamp (Unix seconds) */
  timestamp: bigint
  /** Previous block hash (for reorg detection) */
  prevHash?: string | null
}

/**
 * Block metrics for time-series storage
 * This is the primary data structure indexed by the generalist indexer
 */
export interface BlockMetricsData {
  /** Block timestamp (used as partition column for TimescaleDB hypertable) */
  time: Date
  /** Block height (unique identifier within the chain) */
  height: number
  /** Block hash */
  hash: string
  /** Block difficulty */
  difficulty: bigint
  /** Block subsidy in satoshis (used for inflation charts) */
  subsidy: bigint
  /** Total burned in satoshis (OP_RETURN outputs + burned fees) */
  burned: bigint
  /** Number of transactions in the block (including coinbase) */
  numTxs: number
  /** Miner address (for mining distribution charts) */
  minedBy: string
}

/**
 * Extended block type with generalist indexer metadata
 * Combines NNG block data with indexed metrics
 */
export interface IndexedBlock extends NNGBlock {
  /** Block difficulty */
  difficulty: bigint
  /** Block subsidy in satoshis */
  subsidy: bigint
  /** Total burned satoshis in the block */
  burned: bigint
  /** Number of transactions */
  numTxs: number
  /** Miner address */
  minedBy: string
}

/**
 * Chart data types matching Explorer's PlotData format
 * Array of tuples: [timestamp/label, value, ...]
 */
export type PlotData = Array<(string | number)[]>

/**
 * Time period for chart aggregation
 */
export type ChartPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'

/**
 * Chart metric types
 */
export type ChartMetric =
  | 'inflation'
  | 'burned'
  | 'txs'
  | 'difficulty'
  | 'miningDist'

/**
 * Chart query parameters
 */
export interface ChartQueryParams {
  /** The metric to query */
  metric: ChartMetric
  /** The time period for aggregation */
  period: ChartPeriod
}

/**
 * Complete charts response matching Explorer's Document type
 */
export interface ChartsDocument {
  // Inflation XPI
  inflationDay: PlotData
  inflationWeek: PlotData
  inflationMonth: PlotData
  inflationDay_total: number
  inflationWeek_total: number
  inflationMonth_total: number
  // Burned XPI (OP_RETURN)
  burnedDay: PlotData
  burnedWeek: PlotData
  burnedMonth: PlotData
  burnedDay_total: number
  burnedWeek_total: number
  burnedMonth_total: number
  // Non-coinbase Transactions
  txsDay: PlotData
  txsWeek: PlotData
  txsMonth: PlotData
  txsQuarter: PlotData
  txsAll: PlotData
  txsDay_count: number
  txsWeek_count: number
  txsMonth_count: number
  txsQuarter_count: number
  // Block Difficulty
  difficultyWeek: PlotData
  difficultyMonth: PlotData
  difficultyQuarter: PlotData
  difficultyYear: PlotData
  // Mining Distribution
  miningDistDay: PlotData
  miningDistWeek: PlotData
  miningDistMonth: PlotData
  totalMinersDay: number
  totalMinersWeek: number
  totalMinersMonth: number
}

/**
 * Indexer configuration options
 */
export interface IndexerConfig {
  /** Path to the NNG pub/sub socket */
  pubUri: string
  /** Path to the NNG RPC socket */
  rpcUri: string
}

/**
 * NNG configuration (extends existing config structure)
 */
export interface NNGConfig {
  /** Path to the NNG pub/sub socket */
  pubSocketPath: string
  /** Path to the NNG RPC socket */
  rpcSocketPath: string
}
