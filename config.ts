import { config as dotenv } from 'dotenv'
import { APIConfig, JSONRPCConfig, ChronikConfig } from './utils/types.js'
import type { DotenvConfigOutput } from 'dotenv'

/**
 * Main configuration interface combining API, RPC, and Chronik settings
 */
interface Config {
  api: APIConfig
  rpc: JSONRPCConfig
  chronik: ChronikConfig
}

/**
 * Parses environment variables from a .env file and provides typed configuration
 * @class EnvironmentParser
 */
class EnvironmentParser {
  /**
   * The parsed dotenv configuration output
   * @protected
   */
  protected env?: DotenvConfigOutput

  /**
   * Creates a new EnvironmentParser instance
   * @param path - Optional path to the .env file, defaults to '.env'
   * @param env - Optional pre-parsed dotenv configuration
   */
  constructor(path?: string, env?: DotenvConfigOutput) {
    this.env = env ?? dotenv({ path: path ?? '.env' })
  }

  /**
   * Gets the parsed configuration object
   * @returns The parsed Config object containing api, rpc, and chronik settings
   */
  get config(): Config {
    return this.parseEnvironment()
  }

  /**
   * Parses environment variables into a typed Config object
   * @private
   * @returns Config object with api, rpc, and chronik configuration
   */
  private parseEnvironment(): Config {
    return {
      api: {
        listenAddress: this.env?.parsed?.API_LISTEN_ADDRESS || '0.0.0.0',
        listenPort: parseInt(this.env?.parsed?.API_LISTEN_PORT || '3000'),
        rateLimitWindowMinutes: parseInt(this.env?.parsed?.API_RATE_LIMIT_WINDOW_MINUTES || '1'),
        rateLimitMaxRequests: parseInt(this.env?.parsed?.API_RATE_LIMIT_MAX_REQUESTS || '100'),
      },
      rpc: {
        address: this.env?.parsed?.JSONRPC_ADDRESS || '127.0.0.1',
        port: parseInt(this.env?.parsed?.JSONRPC_PORT || '10604'),
        user: this.env?.parsed?.JSONRPC_USERNAME || 'lotus',
        password: this.env?.parsed?.JSONRPC_PASSWORD || 'lotus',
      },
      chronik: {
        url: this.env?.parsed?.CHRONIK_URL || 'https://chronik.lotusia.org',
      },
    }
  }
}

const env = new EnvironmentParser()
export default env.config
