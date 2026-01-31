import { API } from './lib/api/index.js'
import { explorer } from './lib/api/routes/index.js'
import config from './config.js'

// Configure API routers
const routers = [
  explorer,
  // add more routers here
]

// Initialize and start the API server
// TODO: set up cluster mode for production readiness
const api = new API(routers)
api.start(config.api)

// Register shutdown handlers for graceful termination
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

/**
 * Gracefully shuts down the API server
 * Called when SIGINT or SIGTERM signals are received
 */
function shutdown() {
  console.log('Shutting down API server...')
  api.stop()
  process.exit(0)
}
