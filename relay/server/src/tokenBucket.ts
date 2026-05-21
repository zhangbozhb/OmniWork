/**
 * 简易 token bucket，用于 auth.proof 失败次数限流。
 *
 * - 每个 key 对应一个独立的桶；
 * - 失败一次消耗一个 token；
 * - 桶内 token 用尽后进入封禁状态 blockMs，期间任何 consume 都返回 false；
 * - 封禁结束后桶被填满，重新计时。
 *
 * 用法：在 auth.proof 失败时调用 consume(key)，true 表示允许继续尝试，
 * false 表示当前 key 已被限流。
 */
export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  blockMs: number;
  now?: () => number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
  blockedUntilMs: number;
}

export class TokenBucketLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, BucketState>();

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerSecond / 1000;
    this.blockMs = options.blockMs;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 尝试为 key 消耗 1 个 token。
   * @returns true 表示通过；false 表示已被限流（含处于封禁窗口期间）。
   */
  consume(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, {
        tokens: this.capacity - 1,
        lastRefillMs: now,
        blockedUntilMs: 0,
      });
      return true;
    }

    if (bucket.blockedUntilMs > now) {
      return false;
    }

    if (bucket.blockedUntilMs !== 0 && bucket.blockedUntilMs <= now) {
      bucket.tokens = this.capacity;
      bucket.lastRefillMs = now;
      bucket.blockedUntilMs = 0;
    }

    const elapsed = now - bucket.lastRefillMs;
    if (elapsed > 0) {
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + elapsed * this.refillPerMs,
      );
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens < 1) {
      bucket.blockedUntilMs = now + this.blockMs;
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }

  /**
   * 显式重置某个 key 的桶（例如鉴权成功后立即放行）。
   */
  reset(key: string): void {
    this.buckets.delete(key);
  }
}
