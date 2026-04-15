/**
 * Runtime state management for the indexer
 *
 * Tracks the current sync checkpoint and provides a shared state
 * across indexer components.
 */
import type { Checkpoint } from './types.js'

/**
 * Manages runtime state for the indexer
 * Provides access to the current checkpoint and sync status
 */
export class RuntimeState {
  private _checkpoint: Checkpoint | null
  private _isSyncing: boolean

  constructor() {
    this._checkpoint = null
    this._isSyncing = false
  }

  /**
   * Get the current checkpoint
   * Returns null if no checkpoint has been set (first run)
   */
  get checkpoint(): Checkpoint | null {
    return this._checkpoint
  }

  /**
   * Set the current checkpoint
   * Called when a new block is indexed or on startup from database
   */
  set checkpoint(checkpoint: Checkpoint | null) {
    this._checkpoint = checkpoint
  }

  /**
   * Check if the indexer is currently syncing historical blocks
   */
  get isSyncing(): boolean {
    return this._isSyncing
  }

  /**
   * Set the syncing status
   * True when catching up to chain tip, false when caught up
   */
  set isSyncing(syncing: boolean) {
    this._isSyncing = syncing
  }

  /**
   * Get the current synced height
   * Returns -1 if no checkpoint exists (genesis not yet indexed)
   */
  get height(): number {
    return this._checkpoint?.height ?? -1
  }

  /**
   * Get the current synced hash
   * Returns undefined if no checkpoint exists
   */
  get hash(): string | undefined {
    return this._checkpoint?.hash
  }
}
