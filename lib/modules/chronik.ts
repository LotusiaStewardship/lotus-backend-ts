import { ChronikClient } from 'chronik-client'
import config from '../../config.js'

export const chronikClient = new ChronikClient(config.chronik.url)
