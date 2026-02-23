/**
 * Worker Pool Manager
 * Manages a pool of workers, each with its own API key (1:1 mapping)
 * Features:
 * - One worker per API key
 * - Per-worker rate limit tracking and pausing
 * - Independent exponential backoff per worker
 * - Other workers continue when one is paused
 */
class WorkerPool {
  constructor(apiClients, apiKeys) {
    this.apiClients = apiClients;
    this.apiKeys = apiKeys;

    // Create one worker per API key
    this.workers = apiClients.map((client, index) => ({
      id: index,
      apiClient: client,
      apiKey: apiKeys[index],

      // Rate limit state
      paused: false,
      pauseUntil: null,
      currentPauseDuration: 5000, // Start with 5s
      minPauseDuration: 5000,
      maxPauseDuration: 120000, // Max 2 minutes
      pauseMultiplier: 2,

      // Error tracking
      consecutiveRateLimitErrors: 0,
      consecutiveSuccesses: 0,
      lastErrorTime: null,
      lastSuccessTime: 0, // Start at 0 so all workers are equal initially
      lastAssignmentTime: 0, // Track when worker was last assigned a task

      // Stats
      totalSuccesses: 0,
      totalErrors: 0,
      totalRateLimitErrors: 0,
    }));

    console.log(
      `\n👷 Created ${this.workers.length} worker(s) (1 per API key)`,
    );
  }

  /**
   * Get next available (non-paused) worker
   * Returns null if all workers are paused
   */
  getAvailableWorker() {
    const now = Date.now();

    // Check if any paused workers can be unpaused
    for (const worker of this.workers) {
      if (worker.paused && worker.pauseUntil && now >= worker.pauseUntil) {
        worker.paused = false;
        worker.pauseUntil = null;
        console.log(
          `\n✅ Worker ${worker.id + 1} (Key ${worker.id + 1}) resumed after rate limit pause`,
        );
      }
    }

    // Find first non-paused worker (round-robin would be here, but simple first-available works)
    const availableWorkers = this.workers.filter((w) => !w.paused);

    if (availableWorkers.length === 0) {
      return null; // All workers paused
    }

    // Return least recently assigned available worker (for proper load balancing)
    const lruWorker = availableWorkers.reduce((prev, curr) =>
      curr.lastAssignmentTime < prev.lastAssignmentTime ? curr : prev,
    );

    // Update assignment time
    lruWorker.lastAssignmentTime = Date.now();

    return lruWorker;
  }

  /**
   * Get count of available (non-paused) workers
   */
  getAvailableWorkerCount() {
    const now = Date.now();
    return this.workers.filter((w) => {
      if (!w.paused) return true;
      if (w.pauseUntil && now >= w.pauseUntil) return true;
      return false;
    }).length;
  }

  /**
   * Record a successful operation for a worker
   */
  recordSuccess(workerId) {
    const worker = this.workers[workerId];
    if (!worker) return;

    worker.totalSuccesses++;
    worker.lastSuccessTime = Date.now();
    worker.consecutiveSuccesses++;
    worker.consecutiveRateLimitErrors = 0; // Reset on success

    // Gradually reduce pause duration after successful operations
    if (worker.consecutiveSuccesses >= 10) {
      worker.currentPauseDuration = Math.max(
        worker.currentPauseDuration / worker.pauseMultiplier,
        worker.minPauseDuration,
      );
      worker.consecutiveSuccesses = 0;
    }
  }

  /**
   * Record a rate limit error for a worker and pause it
   */
  recordRateLimitError(workerId) {
    const worker = this.workers[workerId];
    if (!worker) return;

    worker.totalErrors++;
    worker.totalRateLimitErrors++;
    worker.lastErrorTime = Date.now();
    worker.consecutiveSuccesses = 0;
    worker.consecutiveRateLimitErrors++;

    // Pause this worker with exponential backoff
    const pauseDuration = worker.currentPauseDuration;
    worker.paused = true;
    worker.pauseUntil = Date.now() + pauseDuration;

    console.log(
      `\n🛑 Worker ${workerId + 1} (Key ${workerId + 1}) PAUSED for ${pauseDuration / 1000}s due to rate limit (error #${worker.consecutiveRateLimitErrors})`,
    );

    // Increase pause duration for next time
    worker.currentPauseDuration = Math.min(
      worker.currentPauseDuration * worker.pauseMultiplier,
      worker.maxPauseDuration,
    );

    console.log(
      `   Next pause for this worker: ${worker.currentPauseDuration / 1000}s if rate limit persists`,
    );

    // Show other workers' status
    const otherWorkers = this.workers.filter((w) => w.id !== workerId);
    const activeOthers = otherWorkers.filter((w) => !w.paused).length;
    console.log(`   ${activeOthers} other worker(s) continue processing`);
  }

  /**
   * Check if we need to wait for workers to become available
   */
  async waitForAvailableWorker() {
    const available = this.getAvailableWorkerCount();
    if (available > 0) return;

    // All workers paused - find shortest wait time
    const now = Date.now();
    const waitTimes = this.workers
      .filter((w) => w.paused && w.pauseUntil)
      .map((w) => w.pauseUntil - now);

    if (waitTimes.length === 0) return;

    const minWait = Math.min(...waitTimes);
    if (minWait > 0) {
      console.log(
        `\n⏸️  ALL workers paused. Waiting ${Math.ceil(minWait / 1000)}s for next available worker...`,
      );
      await new Promise((resolve) => setTimeout(resolve, minWait));
    }
  }

  /**
   * Get statistics for all workers
   */
  getStats() {
    const totalSuccesses = this.workers.reduce(
      (sum, w) => sum + w.totalSuccesses,
      0,
    );
    const totalErrors = this.workers.reduce((sum, w) => sum + w.totalErrors, 0);
    const totalRateLimits = this.workers.reduce(
      (sum, w) => sum + w.totalRateLimitErrors,
      0,
    );
    const activeworkers = this.workers.filter((w) => !w.paused).length;

    return {
      totalWorkers: this.workers.length,
      activeWorkers: activeworkers,
      pausedWorkers: this.workers.length - activeworkers,
      totalSuccesses,
      totalErrors,
      totalRateLimits,
      workers: this.workers.map((w) => ({
        id: w.id,
        paused: w.paused,
        consecutiveRateLimitErrors: w.consecutiveRateLimitErrors,
        consecutiveSuccesses: w.consecutiveSuccesses,
        currentPauseDuration: w.currentPauseDuration / 1000, // seconds
        totalSuccesses: w.totalSuccesses,
        totalErrors: w.totalErrors,
        totalRateLimitErrors: w.totalRateLimitErrors,
      })),
    };
  }
}

module.exports = WorkerPool;
