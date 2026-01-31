import { Router } from 'express'
import * as Bitcore from 'xpi-ts/lib/bitcore'
import { ScriptProcessor } from 'xpi-ts/lib/rank'
import { chronikClient, rpcClient } from '../../modules/index.js'
import { NODE_GEOIP_URL } from '../../../utils/constants.js'
import { toAsyncIterable } from '../../../utils/functions.js'
import { HTTP, sendJSON } from '../index.js'
import type {
  TxInput,
  TxOutput,
  Tx,
  Block,
  TxHistoryPage,
  ScriptType,
} from 'chronik-client'
import type { TransactionOutputRANK } from 'xpi-ts/lib/rank'
import type { PeerInfo } from 'xpi-ts/lib/rpc'

interface AddressResponse {
  scriptType: ScriptType
  scriptPayload: string
  balance?: string
  lastSeen: string | null
  history: {
    txs: Tx[]
    numPages: number
  }
}

type ExplorerBlock = Block & {
  minedBy: string
}

/**
 * Extended transaction input with address information
 */
type ExplorerTxInput = TxInput & {
  /** The address associated with this input */
  address: string
}

/**
 * Extended transaction output with address and RANK information
 */
type ExplorerTxOutput = TxOutput & {
  /** The address associated with this output (if applicable) */
  address?: string
  /** Parsed RANK output data (if this is a RANK OP_RETURN output) */
  rankOutput?: TransactionOutputRANK
}

/**
 * Extended transaction with explorer-specific fields
 */
type ExplorerTx = Tx & {
  /** Transaction inputs with address information */
  inputs: ExplorerTxInput[]
  /** Transaction outputs with address and RANK information */
  outputs: ExplorerTxOutput[]
  /** Number of confirmations for this transaction */
  confirmations: number
  /** Sum of satoshis burned in OP_RETURN outputs */
  sumBurnedSats: string
}

/**
 * Counters for tracking aggregate transaction values
 */
interface TxCounters {
  /** Sum of satoshis burned in OP_RETURN outputs */
  sumBurnedSats: bigint
}

/**
 * Query parameters for explorer API endpoints
 */
interface Query {
  /** Parameters for the transaction endpoint */
  tx: {
    /** Whether to return raw transaction data (1 = true, 0 = false) */
    raw?: string
  }
  /** Parameters for the blocks endpoint */
  blocks: {
    /** Page number for pagination */
    page?: string
    /** Number of items per page */
    pageSize?: string
  }
  /** Parameters for the address endpoint */
  address: {
    /** Page number for pagination */
    page?: string
    /** Number of items per page */
    pageSize?: string
    /** Whether to include address balance in the response */
    includeBalance?: string
  }
}

/**
 * Geographic location data from IP lookup
 */
interface GeoIPData {
  /** Country name */
  country: string
  /** City name */
  city: string
}

/**
 * Response from the GeoIP API
 */
interface GeoIPResponse {
  /** Whether the request was successful */
  success: boolean
  /** HTTP status message */
  status: string
  /** The IP address that was looked up */
  ip: string
  /** Geographic location data */
  data: GeoIPData
  /** The type of IP address */
  type: 'unicast'
}

const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 40
const GEOIP_CACHE = new Map<string, GeoIPResponse>()

// ======================================
// Router setup
// ======================================
const router = Router()

/**
 * Get mining information
 * @route GET /explorer
 * @returns Mining information from the node RPC
 */
router.get('', async (_req, res) => {
  const miningInfo = await rpcClient.getMiningInfo()
  res.json(miningInfo)
})

/**
 * Get network overview including peer information with geolocation data
 * @route GET /explorer/overview
 * @returns {Object} Object containing miningInfo and peerInfo with geolocation
 */
router.get('/overview', async (req, res) => {
  const peerInfo = await rpcClient.getPeerInfo()
  const peers: PeerInfo[] = []
  for (const peer of peerInfo) {
    // skip private IPv4 and IPv6 addresses
    if (
      peer.addr.match(
        /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|169\.254\.)/,
      ) ||
      peer.addr.match(
        /^(::1$|[fF][cCdD][0-9a-fA-F]{2}:|[fF][eE][89aAbB][0-9a-fA-F]:)/,
      )
    ) {
      continue
    }

    // Remove the port from the peer address
    const [ip] = peer.addr.split(/\:\d{1,5}$/)
    if (!ip) continue
    if (GEOIP_CACHE.has(ip)) {
      peers.push({
        ...peer,
        addr: ip,
        geoip: GEOIP_CACHE.get(ip)!.data,
      })
      continue
    }
    const response = await fetch(`${NODE_GEOIP_URL}/${ip}`)
    const json = (await response.json()) as GeoIPResponse
    // console.log('GeoIP response for IP', ip, json)
    if (json.success) {
      GEOIP_CACHE.set(ip, json)
      peers.push({
        ...peer,
        addr: ip,
        geoip: json.data,
      })
    }
  }

  const miningInfo = await rpcClient.getMiningInfo()

  sendJSON(res, {
    miningInfo,
    peerInfo: peers,
  })
})

/**
 * Get blockchain information
 * @route GET /explorer/chain-info
 * @returns Blockchain information from Chronik including tip height and hash
 */
router.get('/chain-info', async (_req, res) => {
  const blockchainInfo = await chronikClient.blockchainInfo()
  sendJSON(res, blockchainInfo)
})

/**
 * Get transaction history for an address
 * @route GET /explorer/address/:address
 * @param address - The address to look up transaction history for
 * @returns Transaction history with pagination and burned satoshi totals
 */
router.get('/address/:address', async (req, res) => {
  const address = req.params.address
  if (!address) {
    return sendJSON(res, { error: 'address is required' }, HTTP.BAD_REQUEST)
  }

  if (!Bitcore.Address.isValid(address)) {
    return sendJSON(res, { error: 'invalid address' }, HTTP.BAD_REQUEST)
  }

  const query = req.query as Query['address']
  const pageNum = Number(query.page) || 1
  let pageSizeNum = Number(query.pageSize) || DEFAULT_PAGE_SIZE
  if (pageSizeNum > MAX_PAGE_SIZE) {
    pageSizeNum = MAX_PAGE_SIZE
  }

  const script = Bitcore.Script.fromAddress(address)
  const scriptType = script.getType()
  const scriptPayload = script.getData().toString('hex')

  let history: TxHistoryPage
  try {
    const scriptEndpoint = chronikClient.script(scriptType, scriptPayload)
    // Chronik history page is 0-indexed, but we want to show the user a 1-indexed page
    history = await scriptEndpoint.history(
      pageNum > 0 ? pageNum - 1 : 0,
      pageSizeNum,
    )
  } catch (e) {
    return sendJSON(res, { error: (e as Error).message }, HTTP.NOT_FOUND)
  }

  // find the address last seen time
  // use latest block time if available, otherwise use the most recent tx firstSeen time
  const lastSeenTx = history.txs[0]
  let lastSeen: string | null = null
  if (lastSeenTx) {
    lastSeen = lastSeenTx.block?.timestamp ?? lastSeenTx.timeFirstSeen
  }

  const txs = history.txs.map(tx => ({
    ...tx,
    sumBurnedSats: getSumBurnedSats(tx).toString(),
  }))

  const data: AddressResponse = {
    scriptType,
    scriptPayload,
    lastSeen,
    history: { txs, numPages: history.numPages },
  }

  if (query.includeBalance && query.includeBalance === '1') {
    const response = await chronikClient
      .script(scriptType, scriptPayload)
      .utxos()
    const utxos = response[0]?.utxos
    if (utxos) {
      data.balance = utxos
        .reduce((acc, utxo) => acc + BigInt(utxo.value), 0n)
        .toString()
    }
  }

  sendJSON(res, data)
})

/**
 * Get block details by hash or height
 * @route GET /explorer/block/:hashOrHeight
 * @param hashOrHeight - The block hash or height to look up
 * @returns Block data with miner address and burned satoshi totals per transaction
 */
router.get('/block/:hashOrHeight', async (req, res) => {
  const hashOrHeight = req.params.hashOrHeight
  if (!hashOrHeight) {
    return sendJSON(
      res,
      { error: 'hashOrHeight is required' },
      HTTP.BAD_REQUEST,
    )
  }

  let block: Block
  try {
    block = await chronikClient.block(hashOrHeight)
    if (!block) {
      throw new Error('block not found')
    }
  } catch (e) {
    return sendJSON(res, { error: (e as Error).message }, HTTP.NOT_FOUND)
  }

  // return genesis block as is
  if (block.blockInfo.height === 0) {
    return sendJSON(res, block)
  }

  // iterate each tx's outputs to calculate sumBurnedSats for the tx
  const txs: Array<Tx & { sumBurnedSats: string }> = []
  for await (const tx of toAsyncIterable(block.txs)) {
    txs.push({
      ...tx,
      sumBurnedSats: getSumBurnedSats(tx).toString(),
    })
  }
  block.txs = txs

  sendJSON(res, {
    ...block,
    minedBy: Bitcore.Script.fromHex(block.txs[0]!.outputs[1]!.outputScript)
      .toAddress()!
      .toXAddress(),
  } as ExplorerBlock)
})

/**
 * Get a paginated list of blocks
 * @route GET /explorer/blocks
 * @query {string} [page] - Page number (default: 1)
 * @query {string} [pageSize] - Number of blocks per page (default: 10, max: 40)
 * @returns {Object} Object containing blocks array and tipHeight
 */
router.get('/blocks', async (req, res) => {
  const query = req.query as Query['blocks']
  const pageNum = Number(query.page) || 1
  let pageSizeNum = Number(query.pageSize) || DEFAULT_PAGE_SIZE
  if (pageSizeNum > MAX_PAGE_SIZE) {
    pageSizeNum = MAX_PAGE_SIZE
  }

  const blockchainInfo = await chronikClient.blockchainInfo()
  const startHeight = blockchainInfo.tipHeight - pageSizeNum * pageNum
  const endHeight =
    startHeight + (pageSizeNum > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : pageSizeNum)
  const blocks = await chronikClient.blocks(
    startHeight + 1 > 0 ? startHeight + 1 : 1,
    endHeight,
  )

  sendJSON(res, {
    blocks: blocks.reverse(),
    tipHeight: blockchainInfo.tipHeight,
  })
})

/**
 * Get transaction details by transaction ID
 * @route GET /explorer/tx/:txid
 * @param txid - The transaction ID to look up
 * @query {string} [raw] - If '1', returns raw transaction data from RPC; otherwise returns parsed data from Chronik
 * @returns Transaction data in Explorer format or raw transaction data
 */
router.get('/tx/:txid', async (req, res) => {
  const txid = req.params.txid
  const query = req.query as Query['tx']

  // Return raw transaction data if requested
  if (query.raw && query.raw === '1') {
    const tx = await rpcClient.getRawTransaction(txid)
    res.json(tx)
  } else {
    // Get blockchain info to calculate confirmations
    const blockchainInfo = await rpcClient.getBlockCount()
    // Return parsed transaction data from Chronik
    let tx: Tx
    try {
      tx = await chronikClient.tx(txid)
    } catch (e) {
      return sendJSON(
        res,
        { error: 'transaction not found', txid },
        HTTP.NOT_FOUND,
      )
    }

    const counters: TxCounters = {
      sumBurnedSats: 0n,
    }
    const inputs = tx.inputs.map(i => toExplorerTxInput(i))
    const outputs = tx.outputs.map(o => toExplorerTxOutput(o, counters))

    sendJSON(res, {
      ...tx,
      inputs,
      outputs,
      confirmations: tx.block ? blockchainInfo - tx.block.height + 1 : 0,
      sumBurnedSats: counters.sumBurnedSats.toString(),
    } as ExplorerTx)
  }
})

// ======================================
// Function definitions
// ======================================

/**
 * Converts a transaction input to an explorer-formatted input with address information
 * @param input - The original transaction input from Chronik
 * @returns The input with an address field added if the output script is a standard address type
 */
function toExplorerTxInput(input: TxInput): TxInput | ExplorerTxInput {
  if (!input.outputScript) {
    return input
  }
  const script = Bitcore.Script.fromHex(input.outputScript)
  const address =
    // P2PKH/P2SH/P2TR inputs
    script.isPublicKeyHashOut() ||
    script.isScriptHashOut() ||
    script.isTaprootOut()
      ? script.toAddress()!.toString()
      : null
  return {
    ...input,
    address,
  } as ExplorerTxInput
}

/**
 * Converts a transaction output to an explorer-formatted output with address and RANK information
 * @param output - The original transaction output from Chronik
 * @param counters - Counter object to track aggregate values like burned satoshis
 * @returns The output with address and/or RANK output data added if applicable
 */
function toExplorerTxOutput(
  output: TxOutput,
  counters: TxCounters,
): TxOutput | ExplorerTxOutput {
  const scriptBuf = Buffer.from(output.outputScript, 'hex')
  const script = Bitcore.Script.fromBuffer(scriptBuf)

  // OP_RETURN outputs
  if (script.isDataOut()) {
    // increment sumBurnedSats by the output value
    counters.sumBurnedSats += BigInt(output.value)
    // process the RANK output
    const rank = new ScriptProcessor(scriptBuf)
    const rankOutput = rank.processScriptRANK()
    if (rankOutput) {
      return {
        ...output,
        rankOutput,
      } as ExplorerTxOutput
    }

    // TODO: we can add more LOKAD checks here
  }

  // P2PKH/P2SH/P2TR outputs
  if (
    script.isPublicKeyHashOut() ||
    script.isScriptHashOut() ||
    script.isTaprootOut()
  ) {
    const address = script.toAddress()!.toString()
    return {
      ...output,
      address,
    } as ExplorerTxOutput
  }

  // if we get here, the output is not a rank output or an address output
  // just return the output as is
  return output
}

/**
 * Calculates the sum of satoshis burned in OP_RETURN outputs
 * @param tx - The transaction to analyze
 * @returns The total amount of satoshis burned in OP_RETURN outputs
 */
function getSumBurnedSats(tx: Tx): bigint {
  return tx.outputs.reduce((acc, output) => {
    const value = BigInt(output.value)
    // 0x6a = OP_RETURN
    if (output.outputScript.startsWith('6a') && value > BigInt(0)) {
      return acc + value
    }
    return acc
  }, BigInt(0))
}

// ======================================
// Export configured router and URI
// ======================================
const uri = '/explorer'
export { uri, router }
