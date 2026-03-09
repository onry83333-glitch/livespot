/**
 * rotation.ts — Spy cast auto-rotation
 *
 * Manages which spy_casts are actively monitored:
 * - registered_casts (self): always monitored
 * - spy_casts with auto_monitor=true: always monitored (pinned)
 * - spy_casts with auto_monitor=false: rotated in groups
 * - Online casts stay until they go offline (never rotated out mid-stream)
 */

import { CastTarget, ROTATION_CONFIG } from './config.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('rotation');

export class SpyRotation {
  /** All spy_casts (auto_monitor=false only — rotatable pool) */
  private pool: CastTarget[] = [];
  /** Round-robin index into pool */
  private cursor = 0;
  /** Currently active rotatable cast_names */
  private activeSlots = new Set<string>();

  /**
   * Update the full list of spy targets.
   * Called on each target reload (every 5 min).
   */
  updatePool(spyCasts: CastTarget[]): void {
    // Only non-pinned spy_casts go into the rotation pool
    this.pool = spyCasts.filter((t) => !t.autoMonitor);

    // Remove any activeSlots that are no longer in pool
    const poolNames = new Set(this.pool.map((t) => t.castName));
    for (const name of this.activeSlots) {
      if (!poolNames.has(name)) {
        this.activeSlots.delete(name);
      }
    }

    // Clamp cursor
    if (this.cursor >= this.pool.length) {
      this.cursor = 0;
    }
  }

  /**
   * Select the next batch of spy_casts to monitor.
   * Returns { toAdd, toRemove } relative to current active set.
   *
   * @param onlineCasts - set of cast_names currently online (will not be removed)
   */
  rotate(onlineCasts: Set<string>): { toAdd: CastTarget[]; toRemove: CastTarget[] } {
    const maxSlots = ROTATION_CONFIG.maxConcurrent;

    if (this.pool.length === 0) {
      return { toAdd: [], toRemove: [] };
    }

    // If pool fits entirely within maxSlots, activate all
    if (this.pool.length <= maxSlots) {
      const toAdd = this.pool.filter((t) => !this.activeSlots.has(t.castName));
      for (const t of toAdd) this.activeSlots.add(t.castName);
      return { toAdd, toRemove: [] };
    }

    // Build next active set:
    // 1. Keep online casts (never rotate out mid-stream)
    const nextActive = new Set<string>();
    for (const name of this.activeSlots) {
      if (onlineCasts.has(name)) {
        nextActive.add(name);
      }
    }

    // 2. Fill remaining slots via round-robin from pool
    let attempts = 0;
    while (nextActive.size < maxSlots && attempts < this.pool.length) {
      const candidate = this.pool[this.cursor % this.pool.length];
      this.cursor = (this.cursor + 1) % this.pool.length;
      attempts++;

      if (!nextActive.has(candidate.castName)) {
        nextActive.add(candidate.castName);
      }
    }

    // Compute diff
    const toAdd: CastTarget[] = [];
    const toRemove: CastTarget[] = [];

    for (const t of this.pool) {
      if (nextActive.has(t.castName) && !this.activeSlots.has(t.castName)) {
        toAdd.push(t);
      }
      if (!nextActive.has(t.castName) && this.activeSlots.has(t.castName)) {
        toRemove.push(t);
      }
    }

    this.activeSlots = nextActive;

    if (toAdd.length > 0 || toRemove.length > 0) {
      log.info(
        `Rotation: +${toAdd.length} -${toRemove.length} ` +
        `(active=${this.activeSlots.size}/${this.pool.length}, cursor=${this.cursor})`
      );
      if (toAdd.length > 0) log.info(`  ADD: ${toAdd.map((t) => t.castName).join(', ')}`);
      if (toRemove.length > 0) log.info(`  REMOVE: ${toRemove.map((t) => t.castName).join(', ')}`);
    }

    return { toAdd, toRemove };
  }

  /**
   * Get list of currently active rotatable cast names
   * (for external status reporting)
   */
  getActiveNames(): string[] {
    return [...this.activeSlots];
  }

  /**
   * Initial selection — called once at startup to pick the first batch.
   * Same as rotate() but with empty onlineCasts.
   */
  initialSelect(): CastTarget[] {
    const { toAdd } = this.rotate(new Set());
    return toAdd;
  }

  get poolSize(): number {
    return this.pool.length;
  }

  get activeSize(): number {
    return this.activeSlots.size;
  }
}
