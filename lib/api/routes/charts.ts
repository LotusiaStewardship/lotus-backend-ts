/**
 * Charts API routes
 *
 * Provides endpoints for retrieving chart data from TimescaleDB
 * continuous aggregates. Data format matches the Explorer's PlotData type.
 */
import { Router, type Request, type Response } from 'express'
import { HTTP, sendJSON } from '../index.js'
import { Database } from '../../modules/database.js'
import type {
  ChartPeriod,
  ChartMetric,
  PlotData,
  ChartsDocument,
} from '../../indexer/types.js'

// Query parameter types
interface ChartQuery {
  period?: string
}

/**
 * Create the charts router with database injection
 */
export function createChartsRouter(database: Database): Router {
  const router = Router()

/**
 * Get all chart data in a single response
 * @route GET /charts
 * @returns Complete ChartsDocument with all metrics for all periods
 */
  router.get('', async (_req: Request, res: Response) => {
    try {
      const charts = await database.getAllCharts()
      sendJSON(res, charts)
    } catch (e) {
      console.error('[charts] Error fetching all charts:', e)
      sendJSON(
        res,
        { error: 'Failed to fetch chart data', details: (e as Error).message },
        HTTP.BAD_REQUEST,
      )
    }
  })

/**
 * Get inflation chart data
 * @route GET /charts/inflation
 * @query {string} [period=day] - Time period: day, week, or month
 * @returns PlotData array with [timestamp, value] tuples
 */
  router.get('/inflation', async (req: Request, res: Response) => {
  const query = req.query as ChartQuery
  const period = validatePeriod(query.period, ['day', 'week', 'month'])

  if (!period) {
    return sendJSON(
      res,
      { error: 'Invalid period. Must be: day, week, or month' },
      HTTP.BAD_REQUEST,
    )
  }

  try {
    const result = await database.getInflationChart(
      period as 'day' | 'week' | 'month',
    )
    sendJSON(res, {
      period,
      data: result.data,
      total: result.total,
    })
  } catch (e) {
    console.error('[charts] Error fetching inflation chart:', e)
    sendJSON(
      res,
      { error: 'Failed to fetch inflation data', details: (e as Error).message },
      HTTP.BAD_REQUEST,
    )
  }
  })

/**
 * Get burned XPI chart data
 * @route GET /charts/burned
 * @query {string} [period=day] - Time period: day, week, or month
 * @returns PlotData array with [timestamp, value] tuples
 */
  router.get('/burned', async (req: Request, res: Response) => {
  const query = req.query as ChartQuery
  const period = validatePeriod(query.period, ['day', 'week', 'month'])

  if (!period) {
    return sendJSON(
      res,
      { error: 'Invalid period. Must be: day, week, or month' },
      HTTP.BAD_REQUEST,
    )
  }

  try {
    const result = await database.getBurnedChart(
      period as 'day' | 'week' | 'month',
    )
    sendJSON(res, {
      period,
      data: result.data,
      total: result.total,
    })
  } catch (e) {
    console.error('[charts] Error fetching burned chart:', e)
    sendJSON(
      res,
      { error: 'Failed to fetch burned data', details: (e as Error).message },
      HTTP.BAD_REQUEST,
    )
  }
  })

/**
 * Get transaction count chart data
 * @route GET /charts/txs
 * @query {string} [period=day] - Time period: day, week, month, quarter, or all
 * @returns PlotData array with [timestamp, count] tuples
 */
  router.get('/txs', async (req: Request, res: Response) => {
  const query = req.query as ChartQuery
  const period = validatePeriod(query.period, [
    'day',
    'week',
    'month',
    'quarter',
    'all',
  ])

  if (!period) {
    return sendJSON(
      res,
      { error: 'Invalid period. Must be: day, week, month, quarter, or all' },
      HTTP.BAD_REQUEST,
    )
  }

  try {
    const result = await database.getTxsChart(
      period as 'day' | 'week' | 'month' | 'quarter' | 'all',
    )
    sendJSON(res, {
      period,
      data: result.data,
      count: result.count,
    })
  } catch (e) {
    console.error('[charts] Error fetching txs chart:', e)
    sendJSON(
      res,
      { error: 'Failed to fetch transaction data', details: (e as Error).message },
      HTTP.BAD_REQUEST,
    )
  }
  })

/**
 * Get difficulty chart data
 * @route GET /charts/difficulty
 * @query {string} [period=week] - Time period: week, month, quarter, or year
 * @returns PlotData array with [timestamp, difficulty] tuples
 */
  router.get('/difficulty', async (req: Request, res: Response) => {
  const query = req.query as ChartQuery
  const period = validatePeriod(query.period, [
    'week',
    'month',
    'quarter',
    'year',
  ])

  if (!period) {
    return sendJSON(
      res,
      { error: 'Invalid period. Must be: week, month, quarter, or year' },
      HTTP.BAD_REQUEST,
    )
  }

  try {
    const data = await database.getDifficultyChart(
      period as 'week' | 'month' | 'quarter' | 'year',
    )
    sendJSON(res, {
      period,
      data,
    })
  } catch (e) {
    console.error('[charts] Error fetching difficulty chart:', e)
    sendJSON(
      res,
      { error: 'Failed to fetch difficulty data', details: (e as Error).message },
      HTTP.BAD_REQUEST,
    )
  }
  })

/**
 * Get mining distribution chart data
 * @route GET /charts/mining
 * @query {string} [period=day] - Time period: day, week, or month
 * @returns PlotData array with [minerAddress, blockCount] tuples
 */
  router.get('/mining', async (req: Request, res: Response) => {
  const query = req.query as ChartQuery
  const period = validatePeriod(query.period, ['day', 'week', 'month'])

  if (!period) {
    return sendJSON(
      res,
      { error: 'Invalid period. Must be: day, week, or month' },
      HTTP.BAD_REQUEST,
    )
  }

  try {
    const result = await database.getMiningDistChart(
      period as 'day' | 'week' | 'month',
    )
    sendJSON(res, {
      period,
      data: result.data,
      totalMiners: result.totalMiners,
    })
  } catch (e) {
    console.error('[charts] Error fetching mining distribution chart:', e)
    sendJSON(
      res,
      {
        error: 'Failed to fetch mining distribution data',
        details: (e as Error).message,
      },
      HTTP.BAD_REQUEST,
    )
  }
  })

/**
 * Get supply totals
 * @route GET /charts/supply
 * @returns Current supply statistics
 */
  router.get('/supply', async (_req: Request, res: Response) => {
  try {
    const totals = await database.getTotals()

    if (!totals) {
      return sendJSON(res, { error: 'No supply data available' }, HTTP.NOT_FOUND)
    }

    // Convert BigInt to strings for JSON serialization
    sendJSON(res, {
      blocks: totals.blocks,
      supply: totals.supply.toString(),
      supplyXPI: (Number(totals.supply) / 1e6).toFixed(6),
      burned: totals.burned.toString(),
      burnedXPI: (Number(totals.burned) / 1e6).toFixed(6),
      txs: totals.txs,
      circulatingSupply: (totals.supply - totals.burned).toString(),
      circulatingSupplyXPI: (
        Number(totals.supply - totals.burned) / 1e6
      ).toFixed(6),
    })
  } catch (e) {
    console.error('[charts] Error fetching supply:', e)
    sendJSON(
      res,
      { error: 'Failed to fetch supply data', details: (e as Error).message },
      HTTP.BAD_REQUEST,
    )
  }
  })

// ======================================
// Helper functions
// ======================================

/**
 * Validate a period parameter against allowed values
 * @param period - The period string from query params
 * @param allowed - Array of allowed period values
 * @returns The validated period or the first allowed value as default
 */
function validatePeriod(
  period: string | undefined,
  allowed: ChartPeriod[],
): ChartPeriod | null {
  if (!period) {
    return allowed[0] ?? null // Default to first allowed value
  }

  if (allowed.includes(period as ChartPeriod)) {
    return period as ChartPeriod
  }

  return null
}

// ======================================
// Export configured router and URI
// ======================================
  return router
}

const uri = '/charts'
export { uri }
