/**
 * Semaphore — Spec 06
 *
 * A Promise-based counting semaphore for limiting concurrency of async operations.
 * Used by bulkAddMemories to cap parallel LLM/embedding calls.
 */

export class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  /** Acquire a permit. Resolves immediately if one is available, otherwise queues. */
  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /** Release a permit back, waking any queued waiter. */
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.permits++;
    }
  }

  /** Acquire a permit, run fn, then release — even if fn throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
