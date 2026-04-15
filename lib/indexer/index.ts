/**
 * Generalist blockchain indexer for Lotus
 *
 * Indexes block-level metrics for time-series analysis with TimescaleDB.
 * Uses NNG sockets to communicate with lotusd for real-time block notifications.
 */
import { EventEmitter } from 'node:events'
import type { ByteBuffer } from 'flatbuffers'
import {
  NNG,
  NNG_RPC_BLOCKRANGE_SIZE,
  type NNGMessageType,
  type NNGMessageProcessor,
} from 'lotus-nng-client'
import * as NNGInterface from 'lotus-nng-client/lib/nng-interface/index.js'
import { RuntimeState } from './state.js'
import { Database } from '../modules/database.js'
import type { Checkpoint, BlockMetricsData } from './types.js'

/** Default NNG socket paths */
const NNG_PUB_DEFAULT_SOCKET_PATH = `${process.env.HOME}/.lotus/pub.pipe`
const NNG_RPC_DEFAULT_SOCKET_PATH = `${process.env.HOME}/.lotus/rpc.pipe`

/** Error codes for the indexer */
export enum ERR {
  IDX_INIT = 1,
  IDX_RECONCILE,
  IDX_SYNC_BLOCKS,
  IDX_REWIND,
  IDX_BLOCK_CONNECTED,
  IDX_BLOCK_DISCONNECTED,
  NNG_CONNECT,
}

/** Log entry type for structured logging */
type LogEntry = [string, string]

/**
 * Simple structured logger
 */
function log(entries: LogEntry[]): void {
  const formatted = entries.map(([k, v]) => `${k}=${v}`).join(' ')
  console.log(`[indexer] ${formatted}`)
}

/**
 * Generalist blockchain indexer
 *
 * Subscribes to lotusd NNG events and indexes block-level metrics
 * for time-series analysis.
 */
export class Indexer extends EventEmitter {
  private db: Database
  private nng!: NNG
  private pubUri: string
  private rpcUri: string
  private state: RuntimeState

  constructor({
    state,
    db,
    pubUri,
    rpcUri,
  }: {
    state: RuntimeState
    db: Database
    pubUri?: string
    rpcUri?: string
  }) {
    super()
    this.state = state
    this.db = db
    this.pubUri = pubUri ?? NNG_PUB_DEFAULT_SOCKET_PATH
    this.rpcUri = rpcUri ?? NNG_RPC_DEFAULT_SOCKET_PATH
  }

  /**
   * Initialize the indexer
   *
   * - Establishes NNG socket connections
   * - Reconciles checkpoint with blockchain state
   * - Syncs historical blocks
   * - Subscribes to real-time block notifications
   */
  async init(): Promise<void> {
    // Initialize NNG sockets
    this.nng = new NNG({
      sockets: [
        { type: 'sub', path: this.pubUri },
        { type: 'req', path: this.rpcUri },
      ],
      processors: {
        blkconnected: this.nngBlockConnected,
        blkdisconctd: this.nngBlockDisconnected,
      },
    })

    log([
      ['init', 'nng'],
      ['status', 'connected'],
      ['rpcUri', `"${this.rpcUri}"`],
      ['pubUri', `"${this.pubUri}"`],
    ])

    // Get checkpoint from database
    let checkpoint: Checkpoint | null
    try {
      checkpoint = await this.db.getCheckpoint()
      this.state.checkpoint = checkpoint
    } catch (e) {
      throw [ERR.IDX_INIT, (e as Error).message]
    }

    // Reconcile checkpoint with blockchain state
    if (checkpoint) {
      try {
        checkpoint = await this.reconcileBlockState(checkpoint)
        log([
          ['init', 'reconcile'],
          ['height', `${checkpoint.height}`],
          ['hash', checkpoint.hash],
        ])
      } catch (e) {
        throw [ERR.IDX_RECONCILE, (e as Error).message]
      }
    }

    // Sync blocks from checkpoint (or genesis if no checkpoint)
    this.state.isSyncing = true
    try {
      const startHeight = checkpoint?.height ?? -1
      checkpoint = await this.syncBlocks(startHeight)
      this.state.checkpoint = checkpoint
    } catch (e) {
      throw [ERR.IDX_SYNC_BLOCKS, (e as Error).message]
    } finally {
      this.state.isSyncing = false
    }

    // Subscribe to block notifications
    const channels: NNGMessageType[] = ['blkconnected', 'blkdisconctd']
    this.nng.subscribe('sub', channels)
    log([
      ['init', 'nng'],
      ['status', 'subscribed'],
      ['channels', channels.join(',')],
    ])
  }

  /**
   * Close the indexer and disconnect NNG sockets
   */
  async close(): Promise<void> {
    this.nng?.close()
  }

  /**
   * Reconcile our checkpoint with the blockchain state
   *
   * Compares our checkpoint hash with lotusd and rewinds if necessary
   * to handle chain reorganizations.
   */
  private async reconcileBlockState(
    checkpoint: Checkpoint,
  ): Promise<Checkpoint> {
    let current = checkpoint

    // Rewind backwards until checkpoint hash matches lotusd at the same height
    while (current.height >= 0) {
      const rpcBlock = await this.nng.rpcGetBlock(current.height)

      if (!rpcBlock) {
        await this.rewindToHeight(current.height - 1)
        current = this.state.checkpoint ?? this.genesisCheckpoint()
        continue
      }

      const header = rpcBlock.header()
      if (!header) {
        throw new Error('Block header is null')
      }

      const rpcHash = this.toBlockHash(header)
      if (rpcHash === current.hash) {
        return current
      }

      log([
        ['reconcile', 'reorg'],
        ['height', `${current.height}`],
        ['dbHash', current.hash],
        ['rpcHash', rpcHash],
      ])

      await this.rewindToHeight(current.height - 1)
      current = this.state.checkpoint ?? this.genesisCheckpoint()
    }

    return this.genesisCheckpoint()
  }

  /**
   * Sync blocks from startHeight to chain tip
   */
  private async syncBlocks(startHeight: number): Promise<Checkpoint> {
    let totalBlocks = 0
    let currentHeight = startHeight
    const t0 = performance.now()

    while (true) {
      const t1 = performance.now()
      const blockRange = await this.nng.rpcGetBlockRange(
        currentHeight + 1,
        NNG_RPC_BLOCKRANGE_SIZE,
      )

      if (!blockRange) {
        break
      }

      const blocksLength = blockRange.blocksLength()

      if (blocksLength < 1) {
        // Caught up to chain tip
        break
      }

      // Process and save blocks
      const metrics: BlockMetricsData[] = []
      let latestCheckpoint: Checkpoint | null = null

      for (let i = 0; i < blocksLength; i++) {
        const block = blockRange.blocks(i)
        if (!block) continue

        const blockData = this.parseBlock(block)
        metrics.push(blockData.metrics)
        latestCheckpoint = blockData.checkpoint

        // Update supply totals
        await this.db.updateTotals(
          blockData.metrics.subsidy,
          blockData.metrics.burned,
          blockData.metrics.numTxs - 1, // Exclude coinbase
        )
      }

      // Batch insert metrics
      await this.db.insertBlockMetricsBatch(metrics)

      // Save checkpoint
      if (latestCheckpoint) {
        await this.db.saveCheckpoint(latestCheckpoint)
      }

      totalBlocks += blocksLength
      currentHeight += blocksLength
      const t2 = (performance.now() - t1).toFixed(3)

      log([
        ['sync', 'blocks'],
        ['startHeight', `${currentHeight - blocksLength + 1}`],
        ['endHeight', `${currentHeight}`],
        ['blocksLength', `${blocksLength}`],
        ['elapsed', `${t2}ms`],
      ])

      // If we didn't get a full range, we're caught up
      if (blocksLength < NNG_RPC_BLOCKRANGE_SIZE) {
        break
      }
    }

    const totalElapsed = ((performance.now() - t0) / 1000).toFixed(3)
    log([
      ['sync', 'complete'],
      ['totalBlocks', `${totalBlocks}`],
      ['elapsed', `${totalElapsed}s`],
    ])

    // Return current checkpoint
    return (await this.db.getCheckpoint()) ?? this.genesisCheckpoint()
  }

  /**
   * Rewind database state to a specific height
   */
  private async rewindToHeight(targetHeight: number): Promise<void> {
    const currentHeight = await this.db.getLatestHeight()
    if (currentHeight === null) {
      this.state.checkpoint = this.genesisCheckpoint()
      return
    }

    if (currentHeight <= targetHeight) {
      return
    }

    log([
      ['rewind', 'start'],
      ['from', `${currentHeight}`],
      ['to', `${targetHeight}`],
    ])

    // Delete metrics from targetHeight + 1 onwards
    const deleted = await this.db.deleteBlockMetricsFrom(targetHeight + 1)

    // Recalculate totals from remaining block metrics to keep supply state consistent
    await this.db.recalculateTotalsFromMetrics()

    // Refresh checkpoint from latest remaining metrics (or genesis if empty)
    const latest = await this.db.getLatestBlockMetrics()
    const checkpoint: Checkpoint = latest
      ? {
          hash: latest.hash,
          height: latest.height,
          timestamp: BigInt(Math.floor(latest.time.getTime() / 1000)),
        }
      : this.genesisCheckpoint()

    await this.db.saveCheckpoint(checkpoint)
    this.state.checkpoint = checkpoint

    log([
      ['rewind', 'complete'],
      ['deleted', `${deleted}`],
      ['checkpointHeight', `${checkpoint.height}`],
    ])
  }

  /**
   * Handle NNG blkconnected message (new block connected)
   */
  private nngBlockConnected: NNGMessageProcessor = async (
    bb: ByteBuffer,
  ): Promise<void> => {
    const t0 = performance.now()

    try {
      const connectedBlock =
        NNGInterface.BlockConnected.getRootAsBlockConnected(bb)
      const block = connectedBlock.block()
      if (!block) {
        throw new Error('Block is null in blkconnected message')
      }

      const blockData = this.parseBlock(block)

      // Insert metrics
      await this.db.insertBlockMetrics(blockData.metrics)

      // Update supply totals
      await this.db.updateTotals(
        blockData.metrics.subsidy,
        blockData.metrics.burned,
        blockData.metrics.numTxs - 1, // Exclude coinbase
      )

      // Save checkpoint
      await this.db.saveCheckpoint(blockData.checkpoint)

      // Update runtime state
      this.state.checkpoint = blockData.checkpoint

      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['nng', 'blkconnected'],
        ['height', `${blockData.checkpoint.height}`],
        ['hash', blockData.checkpoint.hash.slice(0, 16) + '...'],
        ['numTxs', `${blockData.metrics.numTxs}`],
        ['elapsed', `${t1}ms`],
      ])
    } catch (e) {
      this.emit('exception', ERR.IDX_BLOCK_CONNECTED, (e as Error).message)
    }
  }

  /**
   * Handle NNG blkdisconctd message (block disconnected/reorg)
   */
  private nngBlockDisconnected: NNGMessageProcessor = async (
    bb: ByteBuffer,
  ): Promise<void> => {
    const t0 = performance.now()

    try {
      const disconnectedBlock =
        NNGInterface.BlockDisconnected.getRootAsBlockDisconnected(bb)
      const block = disconnectedBlock.block()
      if (!block) {
        throw new Error('Block is null in blkdisconctd message')
      }

      const header = block.header()
      if (!header) {
        throw new Error('Block header is null')
      }

      const height = this.toBlockHeight(header)
      const hash = this.toBlockHash(header)

      // Rewind disconnected block and all dependent state
      await this.rewindToHeight(height - 1)

      // Keep runtime checkpoint in sync with persisted checkpoint
      this.state.checkpoint = await this.db.getCheckpoint()

      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['nng', 'blkdisconctd'],
        ['height', `${height}`],
        ['hash', hash.slice(0, 16) + '...'],
        ['elapsed', `${t1}ms`],
      ])
    } catch (e) {
      this.emit('exception', ERR.IDX_BLOCK_DISCONNECTED, (e as Error).message)
    }
  }

  /**
   * Block information for the Genesis block on the Lotus blockchain.
   *
   * Pulled from Chronik `/block/0` API endpoint
   */
  private genesisCheckpoint(): Checkpoint {
    return {
      hash: '000000000abc0cde58ee7e919d3d4de183e6844add1fd5d14b4eac89d958f470',
      height: 0,
      timestamp: 1624246260n,
    }
  }

  /**
   * Parse an NNG block into metrics and checkpoint data
   */
  private parseBlock(block: NNGInterface.Block): {
    metrics: BlockMetricsData
    checkpoint: Checkpoint
  } {
    const header = block.header()
    if (!header) {
      throw new Error('Block header is null')
    }

    const height = this.toBlockHeight(header)
    const hash = this.toBlockHash(header)
    const timestamp = header.timestamp()

    // Difficulty is encoded in nBits - use as-is for now
    // Real difficulty calculation requires more complex math
    const difficulty = BigInt(header.nBits())

    const prevBlockHash = header.prevBlockHash()
    const prevHash = prevBlockHash ? this.toPrevBlockHash(prevBlockHash) : null

    // Parse block transactions to calculate metrics
    const txsLength = block.txsLength()
    let subsidy = 0n
    let burned = 0n
    let minedBy = ''

    // Process coinbase transaction to get subsidy and miner address
    if (txsLength > 0) {
      const coinbaseTx = block.txs(0)
      const rawTx = coinbaseTx?.tx()
      const rawArray = rawTx?.rawArray()

      if (rawArray && rawArray.length > 0) {
        // Parse the raw transaction to extract outputs
        // This is a simplified parser - outputs follow inputs in the raw tx
        const txData = this.parseRawTransaction(rawArray)
        subsidy = txData.totalOutput
        burned = txData.burned
        minedBy = txData.minerAddress
      }
    }

    // Sum burned amounts from non-coinbase transactions
    for (let t = 1; t < txsLength; t++) {
      const blockTx = block.txs(t)
      const rawTx = blockTx?.tx()
      const rawArray = rawTx?.rawArray()

      if (rawArray && rawArray.length > 0) {
        const txData = this.parseRawTransaction(rawArray)
        burned += txData.burned
      }
    }

    return {
      metrics: {
        time: new Date(Number(timestamp) * 1000),
        height,
        hash,
        difficulty,
        subsidy,
        burned,
        numTxs: txsLength,
        minedBy,
      },
      checkpoint: {
        hash,
        height,
        timestamp,
        prevHash,
      },
    }
  }

  /**
   * Parse raw transaction bytes to extract output values
   * This is a simplified parser for coinbase transactions
   */
  private parseRawTransaction(rawArray: Uint8Array): {
    totalOutput: bigint
    burned: bigint
    minerAddress: string
  } {
    let totalOutput = 0n
    let burned = 0n
    let minerAddress = ''

    try {
      // Skip version (4 bytes), input count varint, and inputs
      let offset = 4

      // Read input count (varint)
      const inputCount = rawArray[offset]!
      offset += 1

      // Skip inputs (simplified - assumes no witness data)
      for (let i = 0; i < inputCount; i++) {
        offset += 32 // prevout hash
        offset += 4 // prevout index
        const scriptLen = rawArray[offset]!
        offset += 1 + scriptLen // script
        offset += 4 // sequence
      }

      // Read output count (varint)
      const outputCount = rawArray[offset]!
      offset += 1

      // Parse outputs
      for (let o = 0; o < outputCount; o++) {
        // Read value (8 bytes, little-endian)
        const valueBuf = rawArray.slice(offset, offset + 8)
        let value = 0n
        for (let i = 0; i < 8; i++) {
          value += BigInt(valueBuf[i]!) << BigInt(i * 8)
        }
        offset += 8

        // Read script length
        const scriptLen = rawArray[offset]!
        offset += 1

        // Read script
        const script = rawArray.slice(offset, offset + scriptLen)
        offset += scriptLen

        totalOutput += value

        // Check if OP_RETURN (0x6a)
        if (script.length > 0 && script[0] === 0x6a) {
          burned += value
        } else if (o === 1 && script.length >= 25) {
          // Second output is typically the miner address (P2PKH)
          // OP_DUP (0x76) OP_HASH160 (0xa9) <20 bytes> OP_EQUALVERIFY (0x88) OP_CHECKSIG (0xac)
          if (script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14) {
            minerAddress = Buffer.from(script.slice(3, 23)).toString('hex')
          }
        }
      }
    } catch {
      // If parsing fails, return defaults
    }

    return { totalOutput, burned, minerAddress }
  }

  /**
   * Extract block hash from header
   */
  private toBlockHash(header: NNGInterface.BlockHeader): string {
    const blockHash = header.blockHash()
    if (!blockHash) return ''

    const hash = blockHash.hash()
    if (!hash || !hash.bb) return ''

    // Hash is stored inline in the flatbuffer, read 32 bytes directly
    const bytes = hash.bb.bytes().subarray(hash.bb_pos, hash.bb_pos + 32)
    return Buffer.from(bytes).reverse().toString('hex')
  }

  /**
   * Extract previous block hash
   */
  private toPrevBlockHash(prevBlockHash: NNGInterface.BlockHash): string {
    const hash = prevBlockHash.hash()
    if (!hash || !hash.bb) return ''

    const bytes = hash.bb.bytes().subarray(hash.bb_pos, hash.bb_pos + 32)
    return Buffer.from(bytes).reverse().toString('hex')
  }

  /**
   * Extract block height from raw header bytes
   * Height is encoded at bytes 60-64 of the raw header
   */
  private toBlockHeight(header: NNGInterface.BlockHeader): number {
    const rawArray = header.rawArray()
    if (!rawArray || rawArray.length < 64) return 0

    const heightBytes = rawArray.subarray(60, 64)
    return (
      heightBytes[0]! |
      (heightBytes[1]! << 8) |
      (heightBytes[2]! << 16) |
      (heightBytes[3]! << 24)
    )
  }
}
