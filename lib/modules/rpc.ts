import { RPCClient } from 'xpi-ts'
import config from '../../config.js'

export const rpcClient = new RPCClient({
  address: config.rpc.address,
  port: config.rpc.port,
  user: config.rpc.user,
  password: config.rpc.password,
})
