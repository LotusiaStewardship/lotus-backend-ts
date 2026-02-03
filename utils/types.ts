/**
 * Configuration options for the API server
 */
export interface APIConfig {
  /** The address the API server will listen on */
  listenAddress: string
  /** The port the API server will listen on */
  listenPort: number
  /** Rate limit: time window in minutes */
  rateLimitWindowMinutes: number
  /** Rate limit: maximum requests per window per IP */
  rateLimitMaxRequests: number
}

/**
 * Configuration options for JSON-RPC connection
 */
export interface JSONRPCConfig {
  /** The hostname or IP address of the JSON-RPC server */
  address: string
  /** The port number of the JSON-RPC server */
  port: number
  /** The username for JSON-RPC authentication */
  user: string
  /** The password for JSON-RPC authentication */
  password: string
}

/**
 * Configuration options for Chronik indexer connection
 */
export interface ChronikConfig {
  /** The URL of the Chronik indexer service */
  url: string
}
