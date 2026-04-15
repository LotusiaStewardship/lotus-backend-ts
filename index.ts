import { API } from './lib/api/index.js'
import { explorer, charts } from './lib/api/routes/index.js'
import { createChartsRouter } from './lib/api/routes/charts.js'
import { Database } from './lib/modules/database.js'
import { RuntimeState } from './lib/indexer/state.js'
import { Indexer, ERR } from './lib/indexer/index.js'
import config from './config.js'

type Exception = [number | string, string]

/**
 * SETUP
 */
// Instantiate all required modules
const db = new Database()
const state = new RuntimeState()
const indexer = new Indexer({
  state,
  db,
  pubUri: config.nng.pubSocketPath,
  rpcUri: config.nng.rpcSocketPath,
})

// Create charts router with database injection
const chartsRouter = createChartsRouter(db)

// Configure API routers
const routers = [
  explorer,
  { uri: charts.uri, router: chartsRouter },
  // add more routers here
]

// Initialize and start the API server
const api = new API(routers, config.api)

// Register shutdown handlers for graceful termination
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
indexer.once('exception', shutdown)

/**
 * Gracefully shuts down the API server and indexer
 * Called when SIGINT or SIGTERM signals are received
 */
async function shutdown(exitCode: number | string, exitError?: string) {
  console.log('Shutting down...')

  try {
    api.stop()
    await indexer.close()
    await db.disconnect()
  } catch (e) {
    // ignore errors during shutdown
  }

  if (exitError?.length) {
    console.error(`[shutdown] fatal: ${ERR[exitCode as number]} - ${exitError}`)
  } else {
    console.log(`[shutdown] clean: ${exitCode}`)
  }

  // Exit with code 0 for signals, or the error code
  process.exit(typeof exitCode === 'string' ? 0 : exitCode)
}

/**
 * RUNTIME
 */
;(async () => {
  // Connect to database first
  await db.connect()
  console.log('[init] database connected')

  // Initialize and start the indexer
  await indexer.init()
  console.log('[init] indexer started')

  // Start the API server
  api.start(config.api)
  console.log(`[init] API server running on ${config.api.listenAddress}:${config.api.listenPort}`)
})().catch(e => {
  const [exitCode, exitError] = e as Exception
  return shutdown(exitCode, exitError)
})
