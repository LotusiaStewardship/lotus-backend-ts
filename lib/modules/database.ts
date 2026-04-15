/**
 * Database module for the generalist blockchain indexer
 *
 * Provides Prisma client wrapper with raw SQL queries for TimescaleDB
 * continuous aggregates and chart data retrieval.
 */
import { Prisma, PrismaClient } from '../../generated/prisma/index.js'
import type {
  Checkpoint,
  BlockMetricsData,
  PlotData,
  ChartsDocument,
} from '../indexer/types.js'

type AggregateTable =
  | 'block_metrics_hourly'
  | 'block_metrics_daily'
  | 'block_metrics_weekly'

type InflationPeriod = 'day' | 'week' | 'month'
type BurnedPeriod = 'day' | 'week' | 'month'
type TxsPeriod = 'day' | 'week' | 'month' | 'quarter' | 'all'
type DifficultyPeriod = 'week' | 'month' | 'quarter' | 'year'
type MiningDistPeriod = 'day' | 'week' | 'month'

const SATOSHIS_PER_XPI = 1_000_000
const TOTAL_ID = 'current'

function toDecimalString(value: bigint): string {
  return value.toString()
}

function toXpi(value: bigint): number {
  return Number(value) / SATOSHIS_PER_XPI
}

function resolveAggregateTableForInflationOrBurned(
  period: InflationPeriod | BurnedPeriod,
): AggregateTable {
  if (period === 'day') return 'block_metrics_hourly'
  if (period === 'week') return 'block_metrics_daily'
  return 'block_metrics_weekly'
}

function resolveAggregateTableForTxs(period: TxsPeriod): AggregateTable {
  if (period === 'day') return 'block_metrics_hourly'
  if (period === 'week' || period === 'month') return 'block_metrics_daily'
  return 'block_metrics_weekly'
}

function resolveAggregateTableName(table: AggregateTable): string {
  switch (table) {
    case 'block_metrics_hourly':
      return 'public.block_metrics_hourly'
    case 'block_metrics_daily':
      return 'public.block_metrics_daily'
    case 'block_metrics_weekly':
      return 'public.block_metrics_weekly'
    default: {
      const exhaustive: never = table
      throw new Error(`Unsupported aggregate table: ${String(exhaustive)}`)
    }
  }
}

function getInflationPeriodInterval(period: InflationPeriod): string {
  return INTERVAL_MAP[period]
}

function getBurnedPeriodInterval(period: BurnedPeriod): string {
  return INTERVAL_MAP[period]
}

function getTxsPeriodInterval(period: TxsPeriod): string {
  return INTERVAL_MAP[period]
}

function getDifficultyPeriodInterval(period: DifficultyPeriod): string {
  return INTERVAL_MAP[period]
}

function getMiningDistPeriodInterval(period: MiningDistPeriod): string {
  return INTERVAL_MAP[period]
}

/**
 * Time interval mapping for SQL queries
 */
const INTERVAL_MAP = {
  day: '1 day',
  week: '7 days',
  month: '30 days',
  quarter: '90 days',
  year: '365 days',
  all: '10 years', // effectively all time
} as const

/**
 * Database class for indexer operations
 * Wraps Prisma client with raw SQL for TimescaleDB-specific queries
 */
export class Database {
  private prisma: PrismaClient
  private _isConnected: boolean

  constructor() {
    this.prisma = new PrismaClient()
    this._isConnected = false
  }

  /**
   * Connect to the database
   */
  async connect(): Promise<void> {
    await this.prisma.$connect()
    await this.verifyInstall()
    this._isConnected = true
  }

  /**
   * Disconnect from the database
   */
  async disconnect(): Promise<void> {
    await this.prisma.$disconnect()
    this._isConnected = false
  }

  /**
   * Check if the database is connected
   */
  get isConnected(): boolean {
    return this._isConnected
  }

  /**
   * Get the Prisma client instance for direct access
   */
  get client(): PrismaClient {
    return this.prisma
  }

  /**
   * Verify required schema objects exist before runtime starts.
   * This keeps Docker optional and surfaces missing SQL install steps early.
   */
  private async verifyInstall(): Promise<void> {
    const [state] = await this.prisma.$queryRawUnsafe<
      Array<{
        blockMetricsTable: string | null
        checkpointTable: string | null
        totalTable: string | null
        timescaledbExtension: boolean
        hourlyAggregate: string | null
        dailyAggregate: string | null
        weeklyAggregate: string | null
      }>
    >(`
      SELECT
        to_regclass('public."BlockMetrics"')::text AS "blockMetricsTable",
        to_regclass('public."Checkpoint"')::text AS "checkpointTable",
        to_regclass('public."Total"')::text AS "totalTable",
        EXISTS (
          SELECT 1
          FROM pg_extension
          WHERE extname = 'timescaledb'
        ) AS "timescaledbExtension",
        to_regclass('public.block_metrics_hourly')::text AS "hourlyAggregate",
        to_regclass('public.block_metrics_daily')::text AS "dailyAggregate",
        to_regclass('public.block_metrics_weekly')::text AS "weeklyAggregate"
    `)

    if (
      !state?.blockMetricsTable ||
      !state?.checkpointTable ||
      !state?.totalTable
    ) {
      throw new Error(
        'Database schema is incomplete. Run Prisma migrations before starting the service.',
      )
    }

    if (
      !state.timescaledbExtension ||
      !state.hourlyAggregate ||
      !state.dailyAggregate ||
      !state.weeklyAggregate
    ) {
      throw new Error(
        'Database install is incomplete. Ensure TimescaleDB is available and run `psql "$DATABASE_URL" -f sql/install.sql`.',
      )
    }
  }

  // ============================================================================
  // Checkpoint Operations
  // ============================================================================

  /**
   * Get the current checkpoint from the database
   * Returns null if no checkpoint exists (first run)
   */
  async getCheckpoint(): Promise<Checkpoint | null> {
    const checkpoint = await this.prisma.checkpoint.findUnique({
      where: { id: TOTAL_ID },
    })

    if (!checkpoint) return null

    return {
      hash: checkpoint.hash,
      height: checkpoint.height,
      timestamp: checkpoint.timestamp,
      prevHash: checkpoint.prevHash,
    }
  }

  /**
   * Save or update the current checkpoint
   */
  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.prisma.checkpoint.upsert({
      where: { id: TOTAL_ID },
      create: {
        id: TOTAL_ID,
        hash: checkpoint.hash,
        height: checkpoint.height,
        timestamp: checkpoint.timestamp,
        prevHash: checkpoint.prevHash ?? null,
      },
      update: {
        hash: checkpoint.hash,
        height: checkpoint.height,
        timestamp: checkpoint.timestamp,
        prevHash: checkpoint.prevHash ?? null,
      },
    })
  }

  // ============================================================================
  // Block Metrics Operations
  // ============================================================================

  /**
   * Insert a single block's metrics
   */
  async insertBlockMetrics(metrics: BlockMetricsData): Promise<void> {
    await this.prisma.blockMetrics.create({
      data: {
        time: metrics.time,
        height: metrics.height,
        hash: metrics.hash,
        difficulty: toDecimalString(metrics.difficulty),
        subsidy: metrics.subsidy,
        burned: metrics.burned,
        numTxs: metrics.numTxs,
        minedBy: metrics.minedBy,
      },
    })
  }

  /**
   * Insert multiple blocks' metrics in a batch
   * Uses raw SQL for optimal performance with TimescaleDB
   */
  async insertBlockMetricsBatch(metrics: BlockMetricsData[]): Promise<void> {
    if (metrics.length === 0) return

    const values = Prisma.join(
      metrics.map(
        metric =>
          Prisma.sql`(
          ${metric.time},
          ${metric.height},
          ${metric.hash},
          ${toDecimalString(metric.difficulty)},
          ${metric.subsidy},
          ${metric.burned},
          ${metric.numTxs},
          ${metric.minedBy}
        )`,
      ),
    )

    await this.prisma.$executeRaw`
      INSERT INTO "BlockMetrics" (
        "time",
        "height",
        "hash",
        "difficulty",
        "subsidy",
        "burned",
        "numTxs",
        "minedBy"
      )
      VALUES ${values}
      ON CONFLICT ("time", "height") DO UPDATE SET
        "hash" = EXCLUDED."hash",
        "difficulty" = EXCLUDED."difficulty",
        "subsidy" = EXCLUDED."subsidy",
        "burned" = EXCLUDED."burned",
        "numTxs" = EXCLUDED."numTxs",
        "minedBy" = EXCLUDED."minedBy"
    `
  }

  /**
   * Delete block metrics for heights >= the given height
   * Used for reorg handling
   */
  async deleteBlockMetricsFrom(height: number): Promise<number> {
    const result = await this.prisma.blockMetrics.deleteMany({
      where: { height: { gte: height } },
    })
    return result.count
  }

  /**
   * Get the latest indexed block height
   */
  async getLatestHeight(): Promise<number | null> {
    const result = await this.prisma.blockMetrics.findFirst({
      orderBy: { height: 'desc' },
      select: { height: true },
    })
    return result?.height ?? null
  }

  /**
   * Get the latest indexed block metadata
   */
  async getLatestBlockMetrics(): Promise<{
    hash: string
    height: number
    time: Date
  } | null> {
    const result = await this.prisma.blockMetrics.findFirst({
      orderBy: { height: 'desc' },
      select: {
        hash: true,
        height: true,
        time: true,
      },
    })

    if (!result) return null

    return {
      hash: result.hash,
      height: result.height,
      time: result.time,
    }
  }

  /**
   * Recalculate totals from BlockMetrics ground truth.
   * Used after rewinds/reorgs to guarantee consistency.
   */
  async recalculateTotalsFromMetrics(): Promise<void> {
    const aggregate = await this.prisma.$queryRaw<
      Array<{
        blocks: bigint
        supply: bigint
        burned: bigint
        txs: bigint
      }>
    >`
      SELECT
        COUNT(*)::bigint AS blocks,
        COALESCE(SUM(subsidy), 0)::bigint AS supply,
        COALESCE(SUM(burned), 0)::bigint AS burned,
        COALESCE(SUM("numTxs") - COUNT(*), 0)::bigint AS txs
      FROM "BlockMetrics"
    `

    const row = aggregate[0]
    const blocks = Number(row?.blocks ?? 0n)
    const supply = row?.supply ?? 0n
    const burned = row?.burned ?? 0n
    const txs = Number(row?.txs ?? 0n)

    await this.prisma.total.upsert({
      where: { id: TOTAL_ID },
      create: {
        id: TOTAL_ID,
        blocks,
        supply,
        burned,
        txs,
      },
      update: {
        blocks,
        supply,
        burned,
        txs,
      },
    })
  }

  // ============================================================================
  // Chart Data Queries (using TimescaleDB continuous aggregates)
  // ============================================================================

  /**
   * Get inflation chart data for a specific period
   * Returns subsidy (new coins minted) per time bucket
   */
  async getInflationChart(
    period: InflationPeriod,
  ): Promise<{ data: PlotData; total: number }> {
    const interval = getInflationPeriodInterval(period)
    const aggregateTable = resolveAggregateTableForInflationOrBurned(period)
    const tableName = resolveAggregateTableName(aggregateTable)

    const result = await this.prisma.$queryRaw<
      Array<{ bucket: Date; total_subsidy: bigint }>
    >`
      SELECT bucket, total_subsidy
      FROM ${Prisma.raw(tableName)}
      WHERE bucket >= NOW() - ${interval}::interval
      ORDER BY bucket ASC
    `

    const data: PlotData = result.map(row => [
      row.bucket.toISOString(),
      toXpi(row.total_subsidy), // Convert satoshis to XPI
    ])

    const total = result.reduce((sum, row) => sum + toXpi(row.total_subsidy), 0)

    return { data, total }
  }

  /**
   * Get burned XPI chart data for a specific period
   * Returns burned satoshis per time bucket
   */
  async getBurnedChart(
    period: BurnedPeriod,
  ): Promise<{ data: PlotData; total: number }> {
    const interval = getBurnedPeriodInterval(period)
    const aggregateTable = resolveAggregateTableForInflationOrBurned(period)
    const tableName = resolveAggregateTableName(aggregateTable)

    const result = await this.prisma.$queryRaw<
      Array<{ bucket: Date; total_burned: bigint }>
    >`
      SELECT bucket, total_burned
      FROM ${Prisma.raw(tableName)}
      WHERE bucket >= NOW() - ${interval}::interval
      ORDER BY bucket ASC
    `

    const data: PlotData = result.map(row => [
      row.bucket.toISOString(),
      toXpi(row.total_burned), // Convert satoshis to XPI
    ])

    const total = result.reduce((sum, row) => sum + toXpi(row.total_burned), 0)

    return { data, total }
  }

  /**
   * Get transaction count chart data for a specific period
   */
  async getTxsChart(
    period: TxsPeriod,
  ): Promise<{ data: PlotData; count: number }> {
    const interval = getTxsPeriodInterval(period)
    const aggregateTable = resolveAggregateTableForTxs(period)
    const tableName = resolveAggregateTableName(aggregateTable)

    const result = await this.prisma.$queryRaw<
      Array<{ bucket: Date; total_txs: bigint }>
    >`
      SELECT bucket, total_txs
      FROM ${Prisma.raw(tableName)}
      WHERE bucket >= NOW() - ${interval}::interval
      ORDER BY bucket ASC
    `

    const data: PlotData = result.map(row => [
      row.bucket.toISOString(),
      Number(row.total_txs),
    ])

    const count = result.reduce((sum, row) => sum + Number(row.total_txs), 0)

    return { data, count }
  }

  /**
   * Get difficulty chart data for a specific period
   */
  async getDifficultyChart(period: DifficultyPeriod): Promise<PlotData> {
    const interval = getDifficultyPeriodInterval(period)

    // Use daily aggregate for all difficulty charts
    const result = await this.prisma.$queryRaw<
      Array<{ bucket: Date; avg_difficulty: number }>
    >`
      SELECT bucket, avg_difficulty
      FROM block_metrics_daily
      WHERE bucket >= NOW() - ${interval}::interval
      ORDER BY bucket ASC
    `

    return result.map(row => [row.bucket.toISOString(), row.avg_difficulty])
  }

  /**
   * Get mining distribution chart data for a specific period
   * Returns miners and their block counts
   */
  async getMiningDistChart(
    period: MiningDistPeriod,
  ): Promise<{ data: PlotData; totalMiners: number }> {
    const interval = getMiningDistPeriodInterval(period)

    const result = await this.prisma.$queryRaw<
      Array<{ miner: string; block_count: bigint }>
    >`
      SELECT "minedBy" as miner, COUNT(*) as block_count
      FROM "BlockMetrics"
      WHERE "time" >= NOW() - ${interval}::interval
      GROUP BY "minedBy"
      ORDER BY block_count DESC
      LIMIT 50
    `

    const data: PlotData = result.map(row => [
      row.miner,
      Number(row.block_count),
    ])

    return { data, totalMiners: result.length }
  }

  /**
   * Get all charts data in a single call
   * Optimized for the /charts endpoint that needs all data at once
   */
  async getAllCharts(): Promise<ChartsDocument> {
    const [
      inflationDay,
      inflationWeek,
      inflationMonth,
      burnedDay,
      burnedWeek,
      burnedMonth,
      txsDay,
      txsWeek,
      txsMonth,
      txsQuarter,
      txsAll,
      difficultyWeek,
      difficultyMonth,
      difficultyQuarter,
      difficultyYear,
      miningDistDay,
      miningDistWeek,
      miningDistMonth,
    ] = await Promise.all([
      this.getInflationChart('day'),
      this.getInflationChart('week'),
      this.getInflationChart('month'),
      this.getBurnedChart('day'),
      this.getBurnedChart('week'),
      this.getBurnedChart('month'),
      this.getTxsChart('day'),
      this.getTxsChart('week'),
      this.getTxsChart('month'),
      this.getTxsChart('quarter'),
      this.getTxsChart('all'),
      this.getDifficultyChart('week'),
      this.getDifficultyChart('month'),
      this.getDifficultyChart('quarter'),
      this.getDifficultyChart('year'),
      this.getMiningDistChart('day'),
      this.getMiningDistChart('week'),
      this.getMiningDistChart('month'),
    ])

    return {
      inflationDay: inflationDay.data,
      inflationWeek: inflationWeek.data,
      inflationMonth: inflationMonth.data,
      inflationDay_total: inflationDay.total,
      inflationWeek_total: inflationWeek.total,
      inflationMonth_total: inflationMonth.total,
      burnedDay: burnedDay.data,
      burnedWeek: burnedWeek.data,
      burnedMonth: burnedMonth.data,
      burnedDay_total: burnedDay.total,
      burnedWeek_total: burnedWeek.total,
      burnedMonth_total: burnedMonth.total,
      txsDay: txsDay.data,
      txsWeek: txsWeek.data,
      txsMonth: txsMonth.data,
      txsQuarter: txsQuarter.data,
      txsAll: txsAll.data,
      txsDay_count: txsDay.count,
      txsWeek_count: txsWeek.count,
      txsMonth_count: txsMonth.count,
      txsQuarter_count: txsQuarter.count,
      difficultyWeek,
      difficultyMonth,
      difficultyQuarter,
      difficultyYear,
      miningDistDay: miningDistDay.data,
      miningDistWeek: miningDistWeek.data,
      miningDistMonth: miningDistMonth.data,
      totalMinersDay: miningDistDay.totalMiners,
      totalMinersWeek: miningDistWeek.totalMiners,
      totalMinersMonth: miningDistMonth.totalMiners,
    }
  }

  // ============================================================================
  // Supply Tracking (using existing Total model)
  // ============================================================================

  /**
   * Get the current supply totals
   */
  async getTotals(): Promise<{
    blocks: number
    supply: bigint
    burned: bigint
    txs: number
  } | null> {
    const total = await this.prisma.total.findUnique({
      where: { id: TOTAL_ID },
    })
    if (!total) return null

    return {
      blocks: total.blocks,
      supply: total.supply,
      burned: total.burned,
      txs: total.txs,
    }
  }

  /**
   * Update supply totals after indexing a block
   */
  async updateTotals(
    subsidy: bigint,
    burned: bigint,
    txCount: number,
  ): Promise<void> {
    await this.prisma.total.upsert({
      where: { id: TOTAL_ID },
      create: {
        id: TOTAL_ID,
        blocks: 1,
        supply: subsidy,
        burned,
        txs: txCount,
      },
      update: {
        blocks: { increment: 1 },
        supply: { increment: subsidy },
        burned: { increment: burned },
        txs: { increment: txCount },
      },
    })
  }

  /**
   * Revert supply totals when handling a reorg
   */
  async revertTotals(
    blockCount: number,
    subsidy: bigint,
    burned: bigint,
    txCount: number,
  ): Promise<void> {
    const existing = await this.prisma.total.findUnique({
      where: { id: TOTAL_ID },
    })
    if (!existing) return

    await this.prisma.total.update({
      where: { id: TOTAL_ID },
      data: {
        blocks: { decrement: blockCount },
        supply: { decrement: subsidy },
        burned: { decrement: burned },
        txs: { decrement: txCount },
      },
    })
  }
}
