import { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import express, {
  Express,
  Router,
  Request,
  Response,
  NextFunction,
  json,
} from 'express'
import rateLimit from 'express-rate-limit'
import { APIConfig } from '../../utils/types.js'

/**
 * Configuration for a router with its URI path
 */
interface ConfiguredRouter {
  /** The URI path where this router will be mounted */
  uri: string
  /** The Express router instance */
  router: Router
}

/**
 * HTTP status codes
 */
export enum HTTP {
  /** Success */
  OK = 200,
  ACCEPTED = 202,
  /** Redirection */
  MOVED_PERMANENTLY = 301,
  /** Client errors */
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  PAYMENT_REQUIRED = 402,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
}

/**
 * API class for handling HTTP requests and responses
 * @extends {EventEmitter}
 */
export class API extends EventEmitter {
  /** Express application instance */
  private app: Express
  /** Main router instance, registers all subrouters */
  private router: Router
  /** HTTP server instance */
  private server!: Server

  /**
   * Creates a new API instance
   * @param routers - Array of configured routers with their URI paths
   */
  constructor(routers: ConfiguredRouter[], config: APIConfig) {
    super()
    this.app = express()
    this.app.use(json())

    // Add API rate limiting config
    this.app.use(
      rateLimit({
        windowMs: config.rateLimitWindowMinutes * 60 * 1000,
        limit: config.rateLimitMaxRequests, // `max` was renamed to `limit` in express-rate-limit v7
        standardHeaders: true,
        legacyHeaders: false,
        skip: () => {
          // return "false" to NOT skip rate limiting quota for each client
          return false
        },
        handler: sendRateLimitExceededJSON,
      }),
    )

    this.router = Router()
    for (const { uri, router } of routers) {
      console.log(`Registering router ${uri}`)
      this.router.use(uri, router)
    }
    this.app.use('/api/v1', this.router)
  }

  /**
   * Starts the API server and begins listening for requests
   */
  public start(config: APIConfig): void {
    // Listen on the specified address and port
    this.server = this.app.listen(
      config.listenPort,
      config.listenAddress,
      () => {
        console.log(
          `API server running on ${config.listenAddress}:${config.listenPort}`,
        )
      },
    )
  }

  /**
   * Stops the API server and closes all connections
   */
  public stop(): void {
    if (this.server) {
      this.server.closeAllConnections()
      this.server.close()
    }
  }
}

/**
 * Sends a JSON response with the specified data and status code
 * @param res Express Response object to send the JSON response
 * @param data Object containing the data to be sent as JSON
 * @param statusCode Optional HTTP status code (defaults to HTTP.OK if not provided)
 */
export function sendJSON(res: Response, data: object, statusCode?: HTTP) {
  res
    .contentType('application/json')
    .status(statusCode ?? HTTP.OK)
    .json(data)
}

/**
 * Sends a rate limit JSON error response to the client
 * @param req Express Request object (unused but required for express-rate-limit handler signature)
 * @param res Express Response object to send the error response
 */
export function sendRateLimitExceededJSON(_req: Request, res: Response) {
  res.contentType('application/json').status(HTTP.FORBIDDEN).json({
    error: '401 Too many requests, please try again later.',
  })
}
