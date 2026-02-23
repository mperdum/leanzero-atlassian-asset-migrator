#!/usr/bin/env node

/**
 * Standalone Ticket Connection Utility
 *
 * Connects Jira tickets to existing migrated Assets objects by reading:
 * - created_objects_mapping.json for cloud object IDs
 * - Datacenter objects for connectedTickets data
 * - Uses TicketConnector for batch processing
 *
 * Multi-API-Key Support:
 * - Auto-detects API keys from .env: CLOUD_API_TOKEN, CLOUD_API_TOKEN_2, CLOUD_API_TOKEN_3, etc.
 * - Creates one worker per API key (Worker 1 = Key 1, Worker 2 = Key 2)
 * - To add more workers, add more keys to .env (e.g., CLOUD_API_TOKEN_3=your_token)
 * - Each worker has independent rate limiting (when one is paused, others continue)
 *
 * Rate Limiting:
 * - Exponential backoff: 5s → 10s → 20s → 40s → max 2 minutes per worker
 * - Workers pause independently when rate limited
 * - After 10 consecutive successes, pause duration gradually recovers to 5s
 *
 * Usage:
 * node connect_tickets_to_existing_objects.js [options]
 *
 * Options:
 * --mode [mode]            Processing mode: ALL, start-from-pending, or retry-failed-tickets (default: start-from-pending)
 * --schema [name]          Process specific schema only
 * --type [name]            Process specific object type only
 * --limit [n]              Limit number of objects to process
 * --dry-run                Show what would be processed without making changes
 * --parallel               Enable parallel ticket updates
 * --rebuild-plan           Force rebuild of ticket connection plan
 * --help                   Show this help message
 *
 * Examples:
 * # Run with single API key (CLOUD_API_TOKEN in .env)
 * node connect_tickets_to_existing_objects.js
 *
 * # Run with multiple API keys (auto-detects CLOUD_API_TOKEN_2, CLOUD_API_TOKEN_3, etc.)
 * node connect_tickets_to_existing_objects.js
 *
 * # Process only failed objects with 2 workers
 * node connect_tickets_to_existing_objects.js --mode retry-failed-tickets
 *
 * # Process specific schema
 * node connect_tickets_to_existing_objects.js --schema "IT Assets"
 */

const fs = require("fs");
const path = require("path");
const pLimit = require("p-limit");
require("dotenv").config({
  path: path.resolve(__dirname, "../../../asset-migration-script/.env"),
});

// Import required modules from the main migration script
const CloudApiClient = require("../../../asset-migration-script/modules/cloudApiClient");
const TicketConnector = require("../../../asset-migration-script/modules/ticketConnector");
const TicketConnectionPlanManager = require("../utils/ticketConnectionPlanManager");
const WorkerPool = require("./workerPool");

class StandaloneTicketConnector {
  constructor(options = {}) {
    this.options = {
      mode: options.mode || "start-from-pending",
      schema: options.schema || null,
      type: options.type || null,
      limit: options.limit || 0,
      dryRun: options.dryRun || false,
      parallel: options.parallel || false,
      rebuildPlan: options.rebuildPlan || false,
      workers: options.workers || 10, // Default to 10 parallel workers
      ...options,
    };

    // Auto-detect all available API keys from environment
    const baseUrl = process.env.CLOUD_BASE_URL.replace(/^https?:\/\//, "");
    this.apiKeys = this.detectApiKeys();

    console.log(`\n🔑 Detected ${this.apiKeys.length} API key(s)`);
    this.apiKeys.forEach((key, i) => {
      console.log(`   Key ${i + 1}: ${key.substring(0, 20)}...`);
    });

    // Create API clients for each key (one worker per key)
    this.apiClients = this.apiKeys.map(
      (token) => new CloudApiClient(process.env.WORKSPACE_ID, token, baseUrl),
    );

    // For backwards compatibility, keep first client as main
    this.apiClient = this.apiClients[0];

    // Create one ticket connector per API client (one per worker)
    this.ticketConnectors = this.apiClients.map(
      (client, workerIndex) =>
        new TicketConnector(client, {
          enabled: true,
          parallelUpdates: this.options.parallel,
          maxRetries: 3,
          retryDelay: 1000,
          // Pass our logging function with worker ID to capture ALL ticket connector output
          logger: (message) => this.logDetailed(message, workerIndex + 1),
        }),
    );

    // For backwards compatibility
    this.ticketConnector = this.ticketConnectors[0];

    // Initialize plan manager
    this.planManager = new TicketConnectionPlanManager({
      datacenterPath:
        process.env.DATACENTER_PATH ||
        path.join(__dirname, "../../..", "datacenter_assets"),
    });

    // Paths (removed JSON log - all info is in detailed log)
    this.detailedLogFilePath = path.join(
      __dirname,
      "../logs",
      `ticket_connection_detailed_${Date.now()}.log`,
    );

    // Statistics
    this.stats = {
      totalObjectsProcessed: 0,
      objectsWithTickets: 0,
      objectsSkipped: 0,
      totalTicketsProcessed: 0,
      successfulConnections: 0,
      failedConnections: 0,
      errors: [], // Limited to last 100 errors to prevent memory leak
      maxErrors: 100, // Maximum errors to keep in memory
    };

    // Worker pool (one worker per API key)
    this.workerPool = new WorkerPool(this.apiClients, this.apiKeys);

    // Plan update queue for thread-safe updates
    this.planUpdateQueue = [];
    this.planUpdateInProgress = false;

    // Initialize detailed logging with real-time file writing
    this.detailedLogStream = null;

    // Cache now handled by TicketConnectionPlanManager

    this.ensureLogDirectory();
    this.initializeDetailedLogging();
  }

  /**
   * Auto-detect all available API keys from environment variables
   * Looks for CLOUD_API_TOKEN, CLOUD_API_TOKEN_2, CLOUD_API_TOKEN_3, etc.
   */
  detectApiKeys() {
    const keys = [];

    // Check for primary key
    if (process.env.CLOUD_API_TOKEN) {
      keys.push(process.env.CLOUD_API_TOKEN);
    }

    // Check for numbered keys (CLOUD_API_TOKEN_2, CLOUD_API_TOKEN_3, etc.)
    let i = 2;
    while (process.env[`CLOUD_API_TOKEN_${i}`]) {
      keys.push(process.env[`CLOUD_API_TOKEN_${i}`]);
      i++;
    }

    if (keys.length === 0) {
      throw new Error("No API keys found! Please set CLOUD_API_TOKEN in .env");
    }

    return keys;
  }

  ensureLogDirectory() {
    const logDir = path.dirname(this.detailedLogFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Initialize detailed logging with GUARANTEED real-time writing
   */
  initializeDetailedLogging() {
    try {
      // Initialize the log file with header
      const header = `Ticket Connection Detailed Log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`;
      fs.writeFileSync(this.detailedLogFilePath, header);

      console.log(`📝 Detailed log streaming to: ${this.detailedLogFilePath}`);

      // CAPTURE ALL CONSOLE OUTPUT - Override console.log with SYNC writing (GUARANTEED REAL-TIME)
      this.originalConsoleLog = console.log;
      console.log = (...args) => {
        const message = args.join(" ");
        this.originalConsoleLog(message);

        // IMMEDIATE SYNC WRITE - GUARANTEED to hit disk immediately
        try {
          const logLine = `[${new Date().toISOString()}] ${message}\n`;
          fs.appendFileSync(this.detailedLogFilePath, logLine);
        } catch (error) {
          this.originalConsoleLog(`⚠️ Log write failed: ${error.message}`);
        }
      };

      // Log the start
      console.log(`📝 Detailed log streaming started - REAL-TIME GUARANTEED`);
    } catch (error) {
      console.warn(
        `⚠️ Failed to initialize detailed logging: ${error.message}`,
      );
    }
  }

  /**
   * Log detailed information to both console and file (REAL-TIME)
   */
  logDetailed(message, workerId = null) {
    // Add worker ID to message if provided
    const formattedMessage = workerId
      ? `${message} [Worker ${workerId}]`
      : message;

    // Use original console to avoid double-logging
    if (this.originalConsoleLog) {
      this.originalConsoleLog(formattedMessage);
    } else {
      console.log(formattedMessage);
    }

    // IMMEDIATE SYNC WRITE - same as console hijacking
    try {
      const logLine = `[${new Date().toISOString()}] ${formattedMessage}\n`;
      fs.appendFileSync(this.detailedLogFilePath, logLine);
    } catch (error) {
      console.warn(`⚠️  Failed to write to detailed log: ${error.message}`);
    }
  }

  /**
   * Close detailed log and restore console
   */
  closeDetailedLog() {
    // Restore original console.log
    if (this.originalConsoleLog) {
      console.log = this.originalConsoleLog;
    }

    // Write completion marker
    try {
      const completion = `\n${"=".repeat(80)}\nCompleted: ${new Date().toISOString()}\n`;
      fs.appendFileSync(this.detailedLogFilePath, completion);
      console.log(
        `\n💾 Detailed activity log completed: ${this.detailedLogFilePath}`,
      );
    } catch (error) {
      console.warn(`⚠️ Failed to write completion marker: ${error.message}`);
    }
  }

  // Removed loadCreatedObjectsMapping - now handled by TicketConnectionPlanManager

  // Removed loadDatacenterObject - now handled by TicketConnectionPlanManager

  // Removed cache methods - caching now handled by TicketConnectionPlanManager

  // Removed filterObjects - filtering now handled by TicketConnectionPlanManager.getObjectsToProcess()

  /**
   * Process ticket connections using cached plan
   */
  async processTicketConnections() {
    this.logDetailed("\n🎫 STANDALONE TICKET CONNECTION UTILITY (CACHED)");
    this.logDetailed("=====================================");
    this.logDetailed(`📋 Mode: ${this.options.mode.toUpperCase()}`);

    if (this.options.dryRun) {
      this.logDetailed("🔍 DRY RUN MODE - No tickets will be updated");
    }

    // Test API connection
    this.logDetailed("\n🔌 Testing API connection...");
    if (!(await this.apiClient.testConnection())) {
      throw new Error("Cannot connect to Jira Cloud API");
    }
    this.logDetailed("   ✅ API connection successful");

    // Load or create ticket connection plan
    this.logDetailed("\n📂 Loading ticket connection plan...");
    const plan = this.planManager.loadOrCreatePlan(this.options.rebuildPlan);

    // Show plan summary
    const summary = this.planManager.getPlanSummary();
    this.logDetailed(`   📊 Plan Summary:`);
    this.logDetailed(`      Total objects: ${summary.totalObjects}`);
    this.logDetailed(
      `      Objects with tickets: ${summary.objectsWithTickets}`,
    );
    this.logDetailed(`      Total tickets: ${summary.totalTickets}`);
    this.logDetailed(`      Pending: ${summary.stats.pending}`);
    this.logDetailed(`      Completed: ${summary.stats.completed}`);
    this.logDetailed(`      Failed: ${summary.stats.failed}`);
    this.logDetailed(`      Skipped: ${summary.stats.skipped}`);

    // Get objects to process based on mode and filters
    const objectsToProcess = this.planManager.getObjectsToProcess(
      this.options.mode,
      {
        schema: this.options.schema,
        type: this.options.type,
        limit: this.options.limit,
      },
    );

    if (objectsToProcess.length === 0) {
      this.logDetailed("\n❌ No objects match the specified criteria");

      // Show overall progress report even when nothing to process
      this.showOverallProgress();

      return;
    }

    this.logDetailed(
      `\n🎯 Found ${objectsToProcess.length} objects to process (mode: ${this.options.mode})`,
    );

    if (this.options.dryRun) {
      this.logDetailed("\n🔍 DRY RUN SUMMARY:");
      this.logDetailed(
        `   Objects that would be processed: ${objectsToProcess.length}`,
      );
      const totalTickets = objectsToProcess.reduce(
        (sum, obj) => sum + obj.ticketCount,
        0,
      );
      this.logDetailed(
        `   Total tickets that would be updated: ${totalTickets}`,
      );
      return;
    }

    // Process ticket connections
    this.logDetailed("\n🚀 Starting ticket connection process...");
    await this.processTicketConnectionsBatch(objectsToProcess);

    // Generate final report
    this.generateReport();

    // Close detailed log stream
    this.closeDetailedLog();
  }

  /**
   * Queue a plan update for thread-safe processing
   */
  async queuePlanUpdate(datacenterKey, status, updateData = {}) {
    // Simply update in memory - plan saves happen periodically in batch loop
    this.planManager.updateObjectStatus(datacenterKey, status, updateData);
  }

  /**
   * Process plan update queue sequentially (DEPRECATED - not used anymore)
   */
  async processPlanUpdateQueue() {
    // No longer needed - updates are synchronous now
  }

  /**
   * Process a single object (for parallel execution)
   * Returns result object with stats for thread-safe aggregation
   */
  async processSingleObject(planObject, objectIndex, totalObjects, worker) {
    this.logDetailed(
      `\n[${objectIndex + 1}/${totalObjects}] Processing ${planObject.name} [Worker ${worker.id + 1}]`,
    );
    this.logDetailed(
      `   📍 Datacenter: ${planObject.datacenterKey} → Cloud: ${planObject.cloudKey} (ID: ${planObject.cloudId})`,
    );

    // Don't update to "processing" - keep as "pending" until we're done
    // This prevents objects from getting stuck if the script crashes

    // Initialize result stats (for thread-safe aggregation later)
    const resultStats = {
      objectsSkipped: 0,
      objectsWithTickets: 0,
      totalObjectsProcessed: 0,
      successfulConnections: 0,
      failedConnections: 0,
      errors: [],
      workerId: worker.id, // Track which worker processed this
    };

    try {
      // Create object pair for ticket connector
      const dcObject = {
        objectKey: planObject.datacenterKey,
        label: planObject.name,
        connectedTickets: planObject.tickets,
      };

      const cloudObject = {
        id: planObject.cloudId,
        objectKey: planObject.cloudKey,
        label: planObject.name,
      };

      this.logDetailed(
        `   🎫 Processing ${planObject.ticketCount} connected tickets`,
      );

      // Use this worker's ticket connector
      const ticketConnector = this.ticketConnectors[worker.id];

      // Debug: Log which API key is being used
      const apiKeyPreview = ticketConnector.apiToken.substring(0, 30);
      this.logDetailed(
        `   🔑 Using API Key for Worker ${worker.id + 1}: ${apiKeyPreview}...`,
      );

      // Process the tickets for this object
      const result = await ticketConnector.connectTicketsToObject(
        dcObject,
        cloudObject,
      );

      if (result.skipped) {
        this.logDetailed(`   ⏭️  Skipped: ${result.reason}`);
        await this.queuePlanUpdate(planObject.datacenterKey, "skipped", {
          processedTickets: 0,
          successfulTickets: 0,
          failedTickets: 0,
          error: `Skipped: ${result.reason}`,
        });
        resultStats.objectsSkipped++;
        this.workerPool.recordSuccess(worker.id);
      } else {
        // Update status based on results
        const hasFailures = result.summary.failed > 0;
        const hasSuccesses = result.summary.successful > 0;
        const totalTicketsInObject = planObject.ticketCount;
        const processedTickets = result.summary.total;
        const wasLimited = processedTickets < totalTicketsInObject;

        let finalStatus = "completed";
        let errorMessage = null;

        if (hasFailures && !hasSuccesses) {
          finalStatus = "failed";
          errorMessage = `All ${result.summary.failed} ticket connections failed`;
          // Only record error to worker pool if it's a rate limit error
          // Check if any tickets had rate limit errors
          const hadRateLimitError = result.tickets?.some((t) => t.isRateLimit);
          if (hadRateLimitError) {
            this.workerPool.recordRateLimitError(worker.id);
          }
        } else if (hasFailures && hasSuccesses) {
          finalStatus = wasLimited ? "pending" : "completed";
          errorMessage = `${result.summary.failed} of ${result.summary.total} tickets failed`;
          if (wasLimited) {
            errorMessage += ` (${totalTicketsInObject - processedTickets} tickets not processed due to limit)`;
          }
          // Only record error if it was a rate limit issue
          const hadRateLimitError = result.tickets?.some((t) => t.isRateLimit);
          if (hadRateLimitError) {
            this.workerPool.recordRateLimitError(worker.id);
          } else {
            this.workerPool.recordSuccess(worker.id);
          }
        } else if (wasLimited) {
          finalStatus = "pending";
          errorMessage = `${processedTickets} of ${totalTicketsInObject} tickets processed (limited)`;
          this.workerPool.recordSuccess(worker.id);
        } else {
          this.workerPool.recordSuccess(worker.id);
        }

        await this.queuePlanUpdate(planObject.datacenterKey, finalStatus, {
          processedTickets: result.summary.total,
          successfulTickets: result.summary.successful,
          failedTickets: result.summary.failed,
          error: errorMessage,
        });

        this.logDetailed(
          `   ✅ Completed: ${result.summary.successful}/${result.summary.total} successful`,
        );

        if (finalStatus === "completed") {
          resultStats.successfulConnections += result.summary.successful;
        } else {
          resultStats.failedConnections++;
        }

        resultStats.objectsWithTickets++;
      }

      resultStats.totalObjectsProcessed++;
      return { success: true, planObject, stats: resultStats };
    } catch (error) {
      this.logDetailed(
        `   ❌ Error processing ${planObject.datacenterKey}: ${error.message}`,
      );

      await this.queuePlanUpdate(planObject.datacenterKey, "failed", {
        processedTickets: 0,
        successfulTickets: 0,
        failedTickets: planObject.ticketCount,
        error: error.message,
      });

      resultStats.failedConnections++;
      resultStats.errors.push({
        message: error.message,
        objectKey: planObject.datacenterKey,
        timestamp: new Date().toISOString(),
      });

      // Record rate limit error for this worker if applicable
      // Check if error message indicates rate limiting
      const isRateLimit =
        error.message &&
        (error.message.includes("429") ||
          error.message.includes("rate limit") ||
          error.message.includes("too many requests"));

      if (isRateLimit) {
        this.workerPool.recordRateLimitError(worker.id);
      }

      return { success: false, error, planObject, stats: resultStats };
    }
  }

  /**
   * Process ticket connections using worker pool
   * Each worker processes tasks independently with its own API key
   */
  async processTicketConnectionsBatch(objectsToProcess) {
    const totalObjects = objectsToProcess.length;
    const saveInterval = 30000; // Save every 30 seconds

    this.logDetailed(
      `\n🚀 Starting processing with ${this.workerPool.workers.length} worker(s) (one per API key)...`,
    );

    // Track count instead of storing all results to prevent memory leak
    let processedCount = 0;
    let objectIndex = 0;
    let lastSaveTime = Date.now();

    // Create a queue of pending tasks
    const pendingTasks = [...objectsToProcess];
    const activeTasks = new Map(); // workerId -> Promise

    while (pendingTasks.length > 0 || activeTasks.size > 0) {
      // Wait if all workers are paused
      await this.workerPool.waitForAvailableWorker();

      // Assign tasks to available workers (fill all available worker slots)
      // Get all workers that are not paused AND not currently processing
      const availableWorkerIds = new Set(
        this.workerPool.workers
          .filter((w) => !w.paused && !activeTasks.has(w.id))
          .map((w) => w.id),
      );

      while (pendingTasks.length > 0 && availableWorkerIds.size > 0) {
        // Get the least recently assigned worker from available workers
        const availableWorkers = Array.from(availableWorkerIds).map(
          (id) => this.workerPool.workers[id],
        );
        const worker = availableWorkers.reduce((prev, curr) =>
          curr.lastAssignmentTime < prev.lastAssignmentTime ? curr : prev,
        );

        // Update assignment time
        worker.lastAssignmentTime = Date.now();

        // Remove from available set
        availableWorkerIds.delete(worker.id);

        // Assign next task to this worker
        const planObject = pendingTasks.shift();
        const currentIndex = objectIndex++;

        console.log(
          `\n🔄 Task ${currentIndex + 1}/${totalObjects} assigned to Worker ${worker.id + 1}`,
        );

        // Start processing on this worker
        const taskPromise = this.processSingleObject(
          planObject,
          currentIndex,
          totalObjects,
          worker,
        );

        activeTasks.set(worker.id, taskPromise);
      }

      // Wait for at least one task to complete before continuing
      if (activeTasks.size > 0) {
        // Wait for ANY task to complete and get the worker ID
        const completedWorkerId = await Promise.race(
          Array.from(activeTasks.entries()).map(([workerId, promise]) =>
            promise.then((result) => ({ workerId, result })),
          ),
        ).then(({ workerId, result }) => {
          // Remove completed task
          activeTasks.delete(workerId);
          return { workerId, result };
        });

        const result = completedWorkerId.result;

        // Aggregate stats immediately
        if (result.stats) {
          this.stats.objectsSkipped += result.stats.objectsSkipped;
          this.stats.objectsWithTickets += result.stats.objectsWithTickets;
          this.stats.totalObjectsProcessed +=
            result.stats.totalObjectsProcessed;
          this.stats.successfulConnections +=
            result.stats.successfulConnections;
          this.stats.failedConnections += result.stats.failedConnections;

          // Add errors but limit array size to prevent memory leak
          this.stats.errors.push(...result.stats.errors);
          if (this.stats.errors.length > this.stats.maxErrors) {
            this.stats.errors = this.stats.errors.slice(-this.stats.maxErrors);
          }
        }
        processedCount++;
      }

      // Periodic save and progress logging (safe - happens between batches)
      const now = Date.now();
      if (now - lastSaveTime > saveInterval) {
        this.planManager.savePlan();
        lastSaveTime = now;

        // Log progress with worker pool stats
        const poolStats = this.workerPool.getStats();
        this.logDetailed(
          `\n📊 Progress: ${processedCount}/${totalObjects} objects (${((processedCount / totalObjects) * 100).toFixed(1)}%)`,
        );
        this.logDetailed(
          `   👷 Workers: ${poolStats.activeWorkers}/${poolStats.totalWorkers} active, ${poolStats.pausedWorkers} paused`,
        );
        this.logDetailed(
          `   ✅ Success rate: ${poolStats.totalSuccesses}/${poolStats.totalSuccesses + poolStats.totalErrors} (${((poolStats.totalSuccesses / (poolStats.totalSuccesses + poolStats.totalErrors || 1)) * 100).toFixed(1)}%)`,
        );
        this.logDetailed(
          `   🚨 Total rate limit errors: ${poolStats.totalRateLimits}`,
        );

        // Show per-worker status
        poolStats.workers.forEach((w) => {
          const status = w.paused ? "⏸️  PAUSED" : "✅ ACTIVE";
          this.logDetailed(
            `   Worker ${w.id + 1}: ${status} | Successes: ${w.totalSuccesses} | Rate limits: ${w.totalRateLimitErrors}`,
          );
        });
      }
    }

    // Final save of the plan
    this.planManager.savePlan();

    // Calculate actual tickets processed (not total in plan)
    // Total tickets = sum of tickets in objects we actually processed
    const actualTicketsProcessed = objectsToProcess.reduce(
      (sum, obj) => sum + obj.ticketCount,
      0,
    );
    this.stats.totalTicketsProcessed = actualTicketsProcessed;

    // Get final plan summary for status counts
    const finalSummary = this.planManager.getPlanSummary();

    // Log final worker pool statistics
    const finalPoolStats = this.workerPool.getStats();
    this.logDetailed(`\n📊 Final Status Summary:`);
    this.logDetailed(`   Completed: ${finalSummary.stats.completed}`);
    this.logDetailed(`   Failed: ${finalSummary.stats.failed}`);
    this.logDetailed(`   Pending: ${finalSummary.stats.pending}`);
    this.logDetailed(`   Skipped: ${finalSummary.stats.skipped}`);
    this.logDetailed(`\n👷 Worker Pool Statistics:`);
    this.logDetailed(
      `   Total workers: ${finalPoolStats.totalWorkers} (one per API key)`,
    );
    this.logDetailed(`   Active workers: ${finalPoolStats.activeWorkers}`);
    this.logDetailed(`   Paused workers: ${finalPoolStats.pausedWorkers}`);
    this.logDetailed(`   Total successes: ${finalPoolStats.totalSuccesses}`);
    this.logDetailed(`   Total errors: ${finalPoolStats.totalErrors}`);
    this.logDetailed(
      `   Total rate limit errors: ${finalPoolStats.totalRateLimits}`,
    );

    this.logDetailed(`\n📋 Per-Worker Statistics:`);
    finalPoolStats.workers.forEach((w) => {
      this.logDetailed(`   Worker ${w.id + 1}:`);
      this.logDetailed(`      Status: ${w.paused ? "PAUSED" : "ACTIVE"}`);
      this.logDetailed(`      Successes: ${w.totalSuccesses}`);
      this.logDetailed(`      Errors: ${w.totalErrors}`);
      this.logDetailed(`      Rate limit errors: ${w.totalRateLimitErrors}`);
      this.logDetailed(
        `      Consecutive successes: ${w.consecutiveSuccesses}`,
      );
      this.logDetailed(
        `      Current pause duration: ${w.currentPauseDuration}s`,
      );
    });
  }

  /**
   * Generate final report
   */
  generateReport() {
    this.logDetailed("\n" + "=".repeat(60));
    this.logDetailed("📊 FINAL TICKET CONNECTION REPORT");
    this.logDetailed("=".repeat(60));
    this.logDetailed(
      `Total Objects Processed: ${this.stats.totalObjectsProcessed}`,
    );
    this.logDetailed(`Objects with Tickets: ${this.stats.objectsWithTickets}`);
    this.logDetailed(`Objects Skipped: ${this.stats.objectsSkipped}`);
    this.logDetailed(
      `Total Tickets Processed: ${this.stats.totalTicketsProcessed}`,
    );
    this.logDetailed(
      `Successful Connections: ${this.stats.successfulConnections}`,
    );
    this.logDetailed(`Failed Connections: ${this.stats.failedConnections}`);

    if (this.stats.errors.length > 0) {
      this.logDetailed(`\n❌ Errors encountered: ${this.stats.errors.length}`);
      this.stats.errors.slice(0, 5).forEach((error, index) => {
        this.logDetailed(`   ${index + 1}. ${error.message || error}`);
      });
      if (this.stats.errors.length > 5) {
        this.logDetailed(
          `   ... and ${this.stats.errors.length - 5} more errors`,
        );
      }
    }

    // Success rate
    const successRate =
      this.stats.totalTicketsProcessed > 0
        ? (
            (this.stats.successfulConnections /
              this.stats.totalTicketsProcessed) *
            100
          ).toFixed(1)
        : "0";
    this.logDetailed(`\n🎯 Success Rate: ${successRate}%`);

    // Show overall progress report with percentages against ORIGINAL totals
    this.showOverallProgress();

    // Generate permanent_failures.csv
    this.generatePermanentFailuresCSV();
  }

  /**
   * Generate permanent_failures.csv from all detailed log files
   * Analyzes all log files chronologically to find true permanent failures
   */
  generatePermanentFailuresCSV() {
    this.logDetailed("\n📝 Generating permanent_failures.csv...");

    const logDir = path.join(__dirname, "../logs");
    const csvPath = path.join(logDir, "permanent_failures.csv");

    try {
      // Read ONLY the current detailed log file (this.detailedLogFile)
      if (!this.detailedLogFile || !fs.existsSync(this.detailedLogFile)) {
        this.logDetailed("   ⚠️  Current detailed log file not found");
        return;
      }

      this.logDetailed(`   📂 Analyzing current log file...`);

      // Read current log file only
      const content = fs.readFileSync(this.detailedLogFile, "utf8");
      const lines = content.split("\n");

      // Track failures from current run
      const failures = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for failures
        if (line.includes("❌ Failed to update ticket")) {
          const ticketMatch = line.match(/ticket ([A-Z]+-\d+):/);
          if (ticketMatch) {
            const ticket = ticketMatch[1];

            // Get error details from same line
            let errorMsg = "";
            let fieldId = "";
            let assetId = "";
            let assetKey = "";

            const fieldMatch = line.match(/Field (customfield_\d+): (.+)/);
            if (fieldMatch) {
              fieldId = fieldMatch[1];
              errorMsg = fieldMatch[2];
            }

            // Look for context in following lines
            for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
              if (lines[j].includes("Asset Object:")) {
                const assetMatch = lines[j].match(
                  /Asset Object: ([A-Z]+-\d+) \(ID: (\d+)\)/,
                );
                if (assetMatch) {
                  assetKey = assetMatch[1];
                  assetId = assetMatch[2];
                }
              }
              if (lines[j].includes("Field ID:") && !fieldId) {
                const fMatch = lines[j].match(/Field ID: (customfield_\d+)/);
                if (fMatch) fieldId = fMatch[1];
              }
            }

            // Store failure
            if (fieldId) {
              failures.push({
                ticket,
                fieldId,
                errorMsg,
                assetId,
                assetKey,
              });
            }
          }
        }
      }

      const finalFailures = failures;

      // Generate CSV
      const csvLines = [
        "Ticket Key,Field ID,Field Name,Error Message,Asset Object ID,Asset Object Key",
      ];
      for (const failure of finalFailures.sort((a, b) =>
        a.ticket.localeCompare(b.ticket),
      )) {
        const fieldName = "Unknown"; // We don't have field names in logs
        csvLines.push(
          `${failure.ticket},${failure.fieldId},${fieldName},${failure.errorMsg},${failure.assetId},${failure.assetKey}`,
        );
      }

      // Write CSV
      fs.writeFileSync(csvPath, csvLines.join("\n"));

      this.logDetailed(`   ✅ Generated permanent_failures.csv`);
      this.logDetailed(`   📍 Location: ${csvPath}`);
      this.logDetailed(
        `   📊 Total permanent failures: ${finalFailures.length}`,
      );

      // Show top failing fields
      const fieldCounts = new Map();
      for (const failure of finalFailures) {
        const count = fieldCounts.get(failure.fieldId) || 0;
        fieldCounts.set(failure.fieldId, count + 1);
      }

      const sortedFields = Array.from(fieldCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      if (sortedFields.length > 0) {
        this.logDetailed("   📋 Top failing fields:");
        for (const [field, count] of sortedFields) {
          const pct = ((count / finalFailures.length) * 100).toFixed(1);
          this.logDetailed(`      ${field}: ${count} (${pct}%)`);
        }
      }
    } catch (error) {
      this.logDetailed(`   ❌ Error generating CSV: ${error.message}`);
    }
  }

  /**
   * Show overall progress report calculated against ORIGINAL baseline
   * This ensures percentages don't change as you fix issues
   */
  showOverallProgress() {
    const summary = this.planManager.getPlanSummary();
    const ORIGINAL_TOTAL_OBJECTS = summary.totalObjects;
    const ORIGINAL_OBJECTS_WITH_TICKETS = summary.objectsWithTickets;
    const ORIGINAL_TOTAL_TICKETS = summary.totalTickets;

    const stats = summary.stats;

    this.logDetailed("\n" + "=".repeat(80));
    this.logDetailed("📊 OVERALL PROGRESS REPORT (Against Original Baseline)");
    this.logDetailed("=".repeat(80));

    const completedPct = (
      (stats.completed / ORIGINAL_OBJECTS_WITH_TICKETS) *
      100
    ).toFixed(2);
    const failedPct = (
      (stats.failed / ORIGINAL_OBJECTS_WITH_TICKETS) *
      100
    ).toFixed(2);
    const successRate =
      stats.completed + stats.failed > 0
        ? ((stats.completed / (stats.completed + stats.failed)) * 100).toFixed(
            2,
          )
        : "0.00";

    this.logDetailed("\n📈 BASELINE TOTALS");
    this.logDetailed(
      `   Total Objects:              ${ORIGINAL_TOTAL_OBJECTS.toLocaleString()}`,
    );
    this.logDetailed(
      `   Objects with Tickets:       ${ORIGINAL_OBJECTS_WITH_TICKETS.toLocaleString()}`,
    );
    this.logDetailed(
      `   Total Tickets:              ${ORIGINAL_TOTAL_TICKETS.toLocaleString()}`,
    );

    this.logDetailed("\n✅ OBJECT-LEVEL PROGRESS");
    this.logDetailed(
      `   Completed:                  ${stats.completed.toLocaleString()} (${completedPct}%)`,
    );
    this.logDetailed(
      `   Failed:                     ${stats.failed.toLocaleString()} (${failedPct}%)`,
    );
    this.logDetailed(`   Success Rate:               ${successRate}%`);

    // Calculate ticket-level stats
    let totalSuccessfulTickets = 0;
    let totalFailedTickets = 0;
    let totalProcessedTickets = 0;

    this.planManager.plan.objects.forEach((obj) => {
      if (obj.status === "completed" || obj.status === "failed") {
        totalSuccessfulTickets += obj.successfulTickets || 0;
        totalFailedTickets += obj.failedTickets || 0;
        totalProcessedTickets += obj.processedTickets || 0;
      }
    });

    const ticketSuccessRate =
      totalProcessedTickets > 0
        ? ((totalSuccessfulTickets / totalProcessedTickets) * 100).toFixed(2)
        : "0.00";
    const ticketOverallProgress = (
      (totalSuccessfulTickets / ORIGINAL_TOTAL_TICKETS) *
      100
    ).toFixed(2);

    // Calculate skipped tickets (processed but not successful or failed)
    const totalSkippedTickets =
      totalProcessedTickets - totalSuccessfulTickets - totalFailedTickets;

    this.logDetailed("\n🎫 TICKET-LEVEL PROGRESS");
    this.logDetailed(
      `   Processed:                  ${totalProcessedTickets.toLocaleString()} / ${ORIGINAL_TOTAL_TICKETS.toLocaleString()}`,
    );
    this.logDetailed(
      `   Successfully Connected:     ${totalSuccessfulTickets.toLocaleString()} (${ticketOverallProgress}% of all tickets)`,
    );
    this.logDetailed(
      `   Failed:                     ${totalFailedTickets.toLocaleString()}`,
    );
    if (totalSkippedTickets > 0) {
      this.logDetailed(
        `   Skipped:                    ${totalSkippedTickets.toLocaleString()} (custom field not found in cloud)`,
      );
    }
    this.logDetailed(`   Success Rate:               ${ticketSuccessRate}%`);

    // Show details about skipped tickets
    if (totalSkippedTickets > 0) {
      this.logDetailed("\n⏭️  SKIPPED TICKETS");
      const skippedObjects = this.planManager.plan.objects.filter(
        (obj) =>
          obj.processedTickets > 0 &&
          obj.processedTickets !== obj.successfulTickets + obj.failedTickets,
      );

      if (skippedObjects.length > 0) {
        // Group by custom field
        const fieldGroups = new Map();
        skippedObjects.forEach((obj) => {
          // Calculate how many tickets were actually skipped for this object
          const skippedCount =
            obj.processedTickets - obj.successfulTickets - obj.failedTickets;

          // Only count if there are actually skipped tickets
          if (skippedCount > 0 && obj.tickets && obj.tickets.length > 0) {
            // Get the first ticket's fields (assuming all tickets in object use same fields)
            const firstTicket = obj.tickets[0];
            if (firstTicket && firstTicket.customFieldsContainingObject) {
              firstTicket.customFieldsContainingObject.forEach((field) => {
                const fieldName = field.datacenterFieldName || field.fieldName;
                const fieldId = field.fieldId;
                const key = `${fieldName} (${fieldId})`;
                if (!fieldGroups.has(key)) {
                  fieldGroups.set(key, { count: 0, objects: new Set() });
                }
                // Add the actual number of skipped tickets, not total tickets
                fieldGroups.get(key).count += skippedCount;
                fieldGroups.get(key).objects.add(obj.datacenterKey);
              });
            }
          }
        });

        this.logDetailed(
          `   ${totalSkippedTickets} tickets skipped because their custom fields don't exist in cloud Jira:`,
        );

        for (const [fieldName, data] of fieldGroups.entries()) {
          this.logDetailed(`   • ${fieldName}`);
          this.logDetailed(`     Tickets affected: ${data.count}`);
          this.logDetailed(
            `     Objects affected: ${data.objects.size} (${Array.from(data.objects).slice(0, 3).join(", ")}${data.objects.size > 3 ? "..." : ""})`,
          );
        }

        this.logDetailed(
          `\n   ℹ️  These fields were not migrated to cloud or don't exist as CMDB Asset fields`,
        );
      }
    }

    if (stats.failed > 0) {
      this.logDetailed("\n⚠️  REMAINING FAILURES");
      const failedObjects = this.planManager.plan.objects.filter(
        (obj) => obj.status === "failed",
      );
      const errorTypes = {};

      failedObjects.forEach((obj) => {
        const error = obj.error || "Unknown error";
        if (!errorTypes[error]) {
          errorTypes[error] = { count: 0, tickets: 0, objects: [] };
        }
        errorTypes[error].count++;
        errorTypes[error].tickets += obj.failedTickets || 0;
        if (errorTypes[error].objects.length < 5) {
          errorTypes[error].objects.push(obj.datacenterKey);
        }
      });

      Object.entries(errorTypes)
        .sort((a, b) => b[1].count - a[1].count)
        .forEach(([error, data]) => {
          this.logDetailed(`   • ${error}`);
          this.logDetailed(
            `     Objects: ${data.count}, Tickets: ${data.tickets}`,
          );
          this.logDetailed(`     Examples: ${data.objects.join(", ")}`);
        });
    }

    this.logDetailed("\n" + "=".repeat(80));
    this.logDetailed(
      `🎉 BOTTOM LINE: ${completedPct}% objects complete, ${ticketSuccessRate}% tickets connected`,
    );
    this.logDetailed("=".repeat(80));
  }

  /**
   * Show help message
   */
  static showHelp() {
    console.log(`
Standalone Ticket Connection Utility

Connects Jira tickets to existing migrated Assets objects.

Multi-API-Key Support:
  - Auto-detects API keys: CLOUD_API_TOKEN, CLOUD_API_TOKEN_2, CLOUD_API_TOKEN_3, etc.
  - Creates one worker per API key (Worker 1 = Key 1, Worker 2 = Key 2)
  - To add more workers, add more keys to .env (e.g., CLOUD_API_TOKEN_3=your_token)
  - Each worker has independent rate limiting (when one pauses, others continue)

Rate Limiting:
  - Exponential backoff: 5s → 10s → 20s → 40s → max 2 minutes per worker
  - Workers pause independently when rate limited
  - After 10 consecutive successes, pause duration gradually recovers to 5s

Usage:
  node connect_tickets_to_existing_objects.js [options]

Options:
  --mode [mode]            Processing mode: ALL, start-from-pending, or retry-failed-tickets (default: start-from-pending)
                           - ALL: Process all objects with tickets
                           - start-from-pending: Only process pending/failed objects
                           - retry-failed-tickets: Retry objects with partial ticket failures
  --schema [name]          Process specific schema only
  --type [name]            Process specific object type only
  --limit [n]              Limit number of objects to process
  --dry-run                Show what would be processed without making changes
  --parallel               Enable parallel ticket updates
  --rebuild-plan           Force rebuild of ticket connection plan
  --help                   Show this help message

Environment Variables (Required):
  CLOUD_BASE_URL          Your Jira Cloud domain
  CLOUD_API_TOKEN         Primary API token (Worker 1)
  WORKSPACE_ID            Assets workspace ID
  DATACENTER_PATH         Path to datacenter assets (optional)

Environment Variables (Optional - for multiple workers):
  CLOUD_API_TOKEN_2       Secondary API token (Worker 2)
  CLOUD_API_TOKEN_3       Third API token (Worker 3)
  CLOUD_API_TOKEN_N       Nth API token (Worker N)
  ... and so on

Examples:
  # Dry run to see what would be processed (pending items only)
  node connect_tickets_to_existing_objects.js --dry-run

  # Process ALL objects with tickets (force full processing)
  node connect_tickets_to_existing_objects.js --mode ALL

  # Process only pending/failed items (default, fastest)
  node connect_tickets_to_existing_objects.js --mode start-from-pending

  # Process specific schema with pending items only
  node connect_tickets_to_existing_objects.js --schema "Asset_Management"

  # Rebuild the plan cache (if objects have changed)
  node connect_tickets_to_existing_objects.js --rebuild-plan

  # Process specific type with limit and parallel processing
  node connect_tickets_to_existing_objects.js --schema "Asset_Management" --type "Server" --limit 10 --parallel

  # Run with multiple API keys (auto-detected from .env)
  # Just add CLOUD_API_TOKEN_2, CLOUD_API_TOKEN_3, etc. to your .env file
  node connect_tickets_to_existing_objects.js
        `);
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
        StandaloneTicketConnector.showHelp();
        process.exit(0);
        break;
      case "--mode":
        const mode = args[++i];
        if (
          mode !== "ALL" &&
          mode !== "start-from-pending" &&
          mode !== "retry-failed-tickets"
        ) {
          console.error(
            `❌ Invalid mode: ${mode}. Must be 'ALL', 'start-from-pending', or 'retry-failed-tickets'`,
          );
          process.exit(1);
        }
        options.mode = mode;
        break;
      case "--schema":
        options.schema = args[++i];
        break;
      case "--type":
        options.type = args[++i];
        break;
      case "--limit":
        options.limit = parseInt(args[++i]) || 0;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--parallel":
        options.parallel = true;
        break;
      case "--workers":
        options.workers = parseInt(args[++i]) || 10;
        break;
      case "--rebuild-plan":
        options.rebuildPlan = true;
        break;
      default:
        if (arg.startsWith("--")) {
          console.warn(`Unknown option: ${arg}`);
        }
        break;
    }
  }

  return options;
}

// Main execution
async function main() {
  let connector = null;
  try {
    const options = parseArgs();
    connector = new StandaloneTicketConnector(options);
    await connector.processTicketConnections();

    console.log("\n✅ Ticket connection process completed");
    if (connector) {
      connector.logDetailed("\n✅ Ticket connection process completed");
    }
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Fatal error:", error.message);
    console.error(error.stack);

    // Ensure detailed log is closed even on error
    if (connector && connector.closeDetailedLog) {
      try {
        connector.closeDetailedLog();
      } catch (logError) {
        console.warn(
          "Warning: Failed to close detailed log:",
          logError.message,
        );
      }
    }

    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = StandaloneTicketConnector;
