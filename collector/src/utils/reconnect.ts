import { createLogger } from './logger.js';

const log = createLogger('reconnect');

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

export class RetryTracker {
  private failures: Map<string, number> = new Map();
  private opts: RetryOptions;

  constructor(opts: Partial<RetryOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  getDelay(key: string): number {
    const count = this.failures.get(key) || 0;
    const delay = Math.min(
      this.opts.baseDelayMs * Math.pow(2, count),
      this.opts.maxDelayMs,
    );
    // Add jitter (10-30%)
    const jitter = delay * (0.1 + Math.random() * 0.2);
    return Math.floor(delay + jitter);
  }

  recordFailure(key: string): boolean {
    const count = (this.failures.get(key) || 0) + 1;
    this.failures.set(key, count);

    if (count > this.opts.maxRetries) {
      log.error(`${key}: max retries (${this.opts.maxRetries}) exceeded — giving up`);
      return false;
    }

    const delay = this.getDelay(key);
    log.warn(`${key}: failure #${count}, next retry in ${delay}ms`);
    return true;
  }

  recordSuccess(key: string): void {
    if (this.failures.has(key)) {
      log.info(`${key}: recovered after ${this.failures.get(key)} failures`);
      this.failures.delete(key);
    }
  }

  shouldRetry(key: string): boolean {
    return (this.failures.get(key) || 0) <= this.opts.maxRetries;
  }

  getFailureCount(key: string): number {
    return this.failures.get(key) || 0;
  }

  /** Reset failure count for a specific key (e.g. after auth refresh) */
  reset(key: string): void {
    this.failures.delete(key);
  }

  /** Reset all failure counts matching a prefix */
  resetByPrefix(prefix: string): void {
    for (const key of this.failures.keys()) {
      if (key.startsWith(prefix)) {
        this.failures.delete(key);
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
