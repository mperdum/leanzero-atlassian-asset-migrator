#!/usr/bin/env node

/**
 * Sync Comment Visibility to Cloud
 *
 * Reads comment visibility data extracted from Datacenter (JSON file)
 * and updates Cloud comments to match the visibility settings.
 *
 * Uses worker pool pattern for parallel processing with multiple API keys.
 *
 * Usage:
 *   node sync_comment_visibility_to_cloud.js --input <dc_comment_visibility.json>
 *
 * Options:
 *   --input <file>     Path to DC comment visibility JSON file (required)
 *   --dry-run          Preview changes without updating Cloud
 *   --workers <n>      Number of parallel workers (default: 10)
 *   --limit <n>        Limit number of comments to process (for testing)
 *   --filter-type <t>  Only process comments with specific visibility type (role|group|null)
 *   --help             Show this help message
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

// Load .env from asset-migration-script
require("dotenv").config({
  path: path.resolve(__dirname, "../../../asset-migration-script/.env"),
});

// =============================================================================
// Configuration
// =============================================================================
const CLOUD_BASE_URL = process.env.CLOUD_BASE_URL?.replace(/\/$/, "") || "";
const CLOUD_API_TOKEN = process.env.CLOUD_API_TOKEN || "";

// Parse hostname from CLOUD_BASE_URL
const CLOUD_HOSTNAME = CLOUD_BASE_URL.replace(/^https?:\/\//, "").replace(
  /\/.*$/,
  "",
);

// =============================================================================
// Cloud API Client (simplified for Jira REST API v3)
// =============================================================================
class JiraCloudClient {
  constructor(apiToken, hostname) {
    this.apiToken = apiToken;
    this.hostname = hostname;
    this.requestCount = 0;
    this.maxRetries = 5;
    this.baseRetryDelay = 5000;
    this.maxRetryDelay = 120000;
  }

  async makeRequest(method, endpoint, body = null, retryCount = 0) {
    this.requestCount++;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: 443,
        path: endpoint,
        method: method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      };

      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", async () => {
          // Success
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (e) {
              resolve({});
            }
            return;
          }

          // Rate limited - retry with backoff
          if (res.statusCode === 429) {
            if (retryCount < this.maxRetries) {
              const retryAfter = res.headers["retry-after"];
              const delay = retryAfter
                ? parseInt(retryAfter) * 1000
                : Math.min(
                    this.baseRetryDelay * Math.pow(2, retryCount),
                    this.maxRetryDelay,
                  );
              console.log(
                `    Rate limited. Retrying in ${delay / 1000}s... (attempt ${retryCount + 1}/${this.maxRetries})`,
              );
              await this.sleep(delay);
              resolve(this.makeRequest(method, endpoint, body, retryCount + 1));
              return;
            }
            reject(
              new Error(`Rate limit exceeded after ${this.maxRetries} retries`),
            );
            return;
          }

          // Server error - retry
          if (res.statusCode >= 500 && retryCount < this.maxRetries) {
            const delay = Math.min(
              this.baseRetryDelay * Math.pow(2, retryCount),
              this.maxRetryDelay,
            );
            console.log(
              `    Server error ${res.statusCode}. Retrying in ${delay / 1000}s...`,
            );
            await this.sleep(delay);
            resolve(this.makeRequest(method, endpoint, body, retryCount + 1));
            return;
          }

          // Client error - don't retry
          reject(
            new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`),
          );
        });
      });

      req.on("error", async (error) => {
        if (retryCount < this.maxRetries) {
          const delay = this.baseRetryDelay * Math.pow(2, retryCount);
          console.log(`    Request error: ${error.message}. Retrying...`);
          await this.sleep(delay);
          resolve(this.makeRequest(method, endpoint, body, retryCount + 1));
          return;
        }
        reject(error);
      });

      req.on("timeout", async () => {
        req.destroy();
        if (retryCount < this.maxRetries) {
          console.log(`    Request timeout. Retrying...`);
          resolve(this.makeRequest(method, endpoint, body, retryCount + 1));
          return;
        }
        reject(new Error("Request timeout after retries"));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get current user (for auth validation)
   */
  async getCurrentUser() {
    return this.makeRequest("GET", "/rest/api/3/myself");
  }

  /**
   * Search issues using new /search/jql endpoint with nextPageToken
   */
  async searchIssues(
    jql,
    fields = ["key"],
    maxResults = 100,
    nextPageToken = null,
  ) {
    const body = {
      jql,
      maxResults,
      fields,
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }
    return this.makeRequest("POST", "/rest/api/3/search/jql", body);
  }

  /**
   * Get comments for an issue (with properties to detect internal/public)
   */
  async getIssueComments(issueKey, startAt = 0, maxResults = 100) {
    return this.makeRequest(
      "GET",
      `/rest/api/3/issue/${issueKey}/comment?startAt=${startAt}&maxResults=${maxResults}&expand=properties`,
    );
  }

  /**
   * Set comment property (for sd.public.comment internal flag)
   */
  async setCommentProperty(commentId, propertyKey, value) {
    return this.makeRequest(
      "PUT",
      `/rest/api/3/comment/${commentId}/properties/${propertyKey}`,
      value,
    );
  }

  /**
   * Update comment visibility
   * For Cloud API v3:
   * - To SET visibility: {visibility: {type: "role", value: "Name", identifier: "Name"}}
   * - To REMOVE visibility (make public): {visibility: null}
   */
  async updateCommentVisibility(issueKey, commentId, visibility) {
    const body = { visibility };
    return this.makeRequest(
      "PUT",
      `/rest/api/3/issue/${issueKey}/comment/${commentId}`,
      body,
    );
  }
}

// =============================================================================
// Worker Pool (reused pattern from connect_tickets)
// =============================================================================
class WorkerPool {
  constructor(apiClients, numWorkers) {
    this.workers = [];
    for (let i = 0; i < numWorkers; i++) {
      this.workers.push({
        id: i,
        apiClient: apiClients[i % apiClients.length],
        paused: false,
        pauseUntil: null,
        currentPauseDuration: 5000,
        minPauseDuration: 5000,
        maxPauseDuration: 120000,
        consecutiveSuccesses: 0,
        totalSuccesses: 0,
        totalErrors: 0,
        lastAssignmentTime: 0,
      });
    }
    console.log(`Created ${this.workers.length} worker(s)`);
  }

  getAvailableWorker() {
    const now = Date.now();

    // Unpause workers whose pause has expired
    for (const worker of this.workers) {
      if (worker.paused && worker.pauseUntil && now >= worker.pauseUntil) {
        worker.paused = false;
        worker.pauseUntil = null;
        console.log(`Worker ${worker.id + 1} resumed`);
      }
    }

    const available = this.workers.filter((w) => !w.paused);
    if (available.length === 0) return null;

    // Return least recently used worker
    const lruWorker = available.reduce((prev, curr) =>
      curr.lastAssignmentTime < prev.lastAssignmentTime ? curr : prev,
    );
    lruWorker.lastAssignmentTime = now;
    return lruWorker;
  }

  recordSuccess(workerId) {
    const worker = this.workers[workerId];
    if (!worker) return;
    worker.totalSuccesses++;
    worker.consecutiveSuccesses++;

    // Reduce pause duration after 10 consecutive successes
    if (worker.consecutiveSuccesses >= 10) {
      worker.currentPauseDuration = Math.max(
        worker.currentPauseDuration / 2,
        worker.minPauseDuration,
      );
      worker.consecutiveSuccesses = 0;
    }
  }

  recordRateLimitError(workerId) {
    const worker = this.workers[workerId];
    if (!worker) return;
    worker.totalErrors++;
    worker.consecutiveSuccesses = 0;

    worker.paused = true;
    worker.pauseUntil = Date.now() + worker.currentPauseDuration;

    console.log(
      `Worker ${workerId + 1} paused for ${worker.currentPauseDuration / 1000}s due to rate limit`,
    );

    // Increase pause for next time
    worker.currentPauseDuration = Math.min(
      worker.currentPauseDuration * 2,
      worker.maxPauseDuration,
    );
  }

  async waitForAvailableWorker() {
    const available = this.workers.filter((w) => !w.paused);
    if (available.length > 0) return;

    const now = Date.now();
    const waitTimes = this.workers
      .filter((w) => w.paused && w.pauseUntil)
      .map((w) => w.pauseUntil - now);

    if (waitTimes.length === 0) return;

    const minWait = Math.min(...waitTimes);
    if (minWait > 0) {
      console.log(
        `All workers paused. Waiting ${Math.ceil(minWait / 1000)}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, minWait));
    }
  }

  getStats() {
    const totalSuccesses = this.workers.reduce(
      (s, w) => s + w.totalSuccesses,
      0,
    );
    const totalErrors = this.workers.reduce((s, w) => s + w.totalErrors, 0);
    const activeWorkers = this.workers.filter((w) => !w.paused).length;
    return {
      totalSuccesses,
      totalErrors,
      activeWorkers,
      totalWorkers: this.workers.length,
    };
  }
}

// =============================================================================
// Comment Visibility Sync
// =============================================================================
class CommentVisibilitySync {
  constructor(options) {
    this.options = options;
    this.inputFile = options.input;
    this.dryRun = options.dryRun || false;
    this.limit = options.limit || 0;
    this.filterType = options.filterType || null;
    this.numWorkers = options.workers || 10;

    // Stats
    this.stats = {
      totalDcComments: 0,
      commentsProcessed: 0,
      commentsMatched: 0,
      commentsUpdated: 0,
      commentsFailed: 0,
      commentsSkipped: 0,
      commentsAlreadyCorrect: 0,
    };

    // Results for logging
    this.updatedComments = [];
    this.failedComments = [];

    // Initialize logging
    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.timestamp = Date.now();
    this.logFile = path.join(
      this.logDir,
      `sync_visibility_${this.timestamp}.log`,
    );
  }

  log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    fs.appendFileSync(this.logFile, line + "\n");
  }

  async run() {
    this.log("==========================================");
    this.log("Comment Visibility Sync: DC -> Cloud");
    this.log("==========================================");
    this.log(`Input File: ${this.inputFile}`);
    this.log(`Dry Run: ${this.dryRun}`);
    this.log(`Workers: ${this.numWorkers}`);
    this.log(`Cloud: ${CLOUD_HOSTNAME}`);
    this.log("==========================================");

    // Validate config
    if (!CLOUD_API_TOKEN) {
      this.log("ERROR: CLOUD_API_TOKEN not set in .env");
      process.exit(1);
    }

    // Load DC data
    this.log("\nLoading DC comment visibility data...");
    const dcData = JSON.parse(fs.readFileSync(this.inputFile, "utf-8"));
    this.stats.totalDcComments = dcData.comments.length;
    this.log(`Loaded ${dcData.comments.length} comments from DC`);
    this.log(`  Internal: ${dcData.commentsInternal}`);
    this.log(`  Public: ${dcData.commentsPublic}`);

    // Filter comments if needed
    let commentsToProcess = dcData.comments;

    // Only process internal comments (internal: true)
    // Public comments don't need syncing
    commentsToProcess = commentsToProcess.filter((c) => c.internal === true);
    this.log(
      `Filtering to ${commentsToProcess.length} internal comments to sync`,
    );

    if (this.limit > 0) {
      commentsToProcess = commentsToProcess.slice(0, this.limit);
      this.log(`Limited to ${commentsToProcess.length} comments`);
    }

    // Create API clients and worker pool
    const apiClients = this.detectApiClients();
    this.workerPool = new WorkerPool(apiClients, this.numWorkers);

    // Validate Cloud connectivity
    this.log("\nValidating Cloud connectivity...");
    try {
      const user = await apiClients[0].getCurrentUser();
      this.log(
        `Connected to Cloud as: ${user.displayName || user.emailAddress}`,
      );
    } catch (err) {
      this.log(`ERROR: Failed to connect to Cloud: ${err.message}`);
      process.exit(1);
    }

    // Group comments by issue for efficient Cloud fetching
    this.log("\nGrouping comments by issue...");
    const commentsByIssue = new Map();
    for (const comment of commentsToProcess) {
      if (!commentsByIssue.has(comment.issueKey)) {
        commentsByIssue.set(comment.issueKey, []);
      }
      commentsByIssue.get(comment.issueKey).push(comment);
    }
    this.log(`Processing ${commentsByIssue.size} issues`);

    // Process issues in parallel using worker pool
    this.log("\n==========================================");
    this.log("Starting parallel processing...");
    this.log("==========================================");

    const issues = Array.from(commentsByIssue.entries());
    const concurrency = this.numWorkers;
    let issueIndex = 0;
    const activeTasks = new Map();

    const processNextIssue = async () => {
      while (issueIndex < issues.length) {
        await this.workerPool.waitForAvailableWorker();
        const worker = this.workerPool.getAvailableWorker();
        if (!worker) continue;

        const [issueKey, dcComments] = issues[issueIndex++];
        const taskPromise = this.processIssue(worker, issueKey, dcComments)
          .then(() => {
            activeTasks.delete(taskPromise);
            this.workerPool.recordSuccess(worker.id);
          })
          .catch((err) => {
            activeTasks.delete(taskPromise);
            if (err.message.includes("429") || err.message.includes("rate")) {
              this.workerPool.recordRateLimitError(worker.id);
            }
          });
        activeTasks.set(taskPromise, worker.id);

        // Log progress periodically
        if (issueIndex % 100 === 0) {
          const stats = this.workerPool.getStats();
          this.log(
            `Progress: ${issueIndex}/${issues.length} issues, ` +
              `${this.stats.commentsUpdated} updated, ${this.stats.commentsFailed} failed ` +
              `(${stats.activeWorkers}/${stats.totalWorkers} workers active)`,
          );
        }

        // Limit concurrency
        if (activeTasks.size >= concurrency) {
          await Promise.race(activeTasks.keys());
        }
      }
    };

    await processNextIssue();
    await Promise.all(activeTasks.keys());

    // Generate summary
    this.log("\n==========================================");
    this.log("SUMMARY");
    this.log("==========================================");
    this.log(`Total DC comments: ${this.stats.totalDcComments}`);
    this.log(`Comments processed: ${this.stats.commentsProcessed}`);
    this.log(`Comments matched in Cloud: ${this.stats.commentsMatched}`);
    this.log(`Comments already correct: ${this.stats.commentsAlreadyCorrect}`);
    this.log(`Comments updated: ${this.stats.commentsUpdated}`);
    this.log(`Comments failed: ${this.stats.commentsFailed}`);
    this.log(`Comments skipped: ${this.stats.commentsSkipped}`);
    this.log("==========================================");

    // Write results
    const resultsFile = path.join(
      this.logDir,
      `sync_results_${this.timestamp}.json`,
    );
    fs.writeFileSync(
      resultsFile,
      JSON.stringify(
        {
          stats: this.stats,
          updatedComments: this.updatedComments,
          failedComments: this.failedComments,
        },
        null,
        2,
      ),
    );
    this.log(`Results written to: ${resultsFile}`);
    this.log(`Log file: ${this.logFile}`);

    if (this.stats.commentsFailed > 0) {
      this.log(
        `\nWARNING: ${this.stats.commentsFailed} comments failed to update`,
      );
      process.exit(1);
    }

    this.log("\nSync completed successfully!");
  }

  detectApiClients() {
    const clients = [];

    // Primary key
    if (process.env.CLOUD_API_TOKEN) {
      clients.push(
        new JiraCloudClient(process.env.CLOUD_API_TOKEN, CLOUD_HOSTNAME),
      );
    }

    // Additional keys (CLOUD_API_TOKEN_2, CLOUD_API_TOKEN_3, etc.)
    let i = 2;
    while (process.env[`CLOUD_API_TOKEN_${i}`]) {
      clients.push(
        new JiraCloudClient(
          process.env[`CLOUD_API_TOKEN_${i}`],
          CLOUD_HOSTNAME,
        ),
      );
      i++;
    }

    this.log(`Detected ${clients.length} API key(s)`);
    return clients;
  }

  async processIssue(worker, issueKey, dcComments) {
    try {
      // Fetch Cloud comments for this issue (with properties expanded)
      const cloudComments = await this.getAllCloudComments(
        worker.apiClient,
        issueKey,
      );

      for (const dcComment of dcComments) {
        this.stats.commentsProcessed++;

        // Match by created timestamp
        const cloudComment = cloudComments.find(
          (c) => c.created === dcComment.created,
        );

        if (!cloudComment) {
          // No match found
          continue;
        }

        this.stats.commentsMatched++;

        // DC says this comment should be internal (internal: true)
        // Check if Cloud already has it as internal
        const cloudIsInternal = this.isCloudCommentInternal(cloudComment);

        if (cloudIsInternal) {
          // Already internal in Cloud, nothing to do
          this.stats.commentsAlreadyCorrect++;
          continue;
        }

        // Need to make this comment internal in Cloud
        if (this.dryRun) {
          this.log(
            `[DRY-RUN] Would set ${issueKey} comment ${cloudComment.id} as internal`,
          );
          this.stats.commentsUpdated++;
          this.updatedComments.push({
            issueKey,
            commentId: cloudComment.id,
            action: "would_set_internal",
          });
        } else {
          try {
            // Set sd.public.comment property to make it internal
            // NOTE: There's a known Atlassian issue (JSDCLOUD-6050) where updating
            // this property via REST API may not reflect in the UI immediately.
            await worker.apiClient.setCommentProperty(
              cloudComment.id,
              "sd.public.comment",
              { internal: true },
            );
            this.stats.commentsUpdated++;
            this.updatedComments.push({
              issueKey,
              commentId: cloudComment.id,
              action: "set_internal",
            });
          } catch (err) {
            this.stats.commentsFailed++;
            this.failedComments.push({
              issueKey,
              commentId: cloudComment.id,
              error: err.message,
            });
            this.log(
              `FAILED: ${issueKey} comment ${cloudComment.id}: ${err.message}`,
            );
          }
        }
      }
    } catch (err) {
      // Issue-level error
      this.log(`ERROR processing issue ${issueKey}: ${err.message}`);
      for (const dc of dcComments) {
        this.stats.commentsFailed++;
        this.failedComments.push({
          issueKey,
          commentId: dc.commentId,
          error: err.message,
        });
      }
      throw err; // Re-throw for worker pool rate limit detection
    }
  }

  /**
   * Check if Cloud comment is internal
   * Internal comments have: {"key": "sd.public.comment", "value": {"internal": true}}
   */
  isCloudCommentInternal(cloudComment) {
    const properties = cloudComment.properties || [];
    const sdPublicComment = properties.find(
      (p) => p.key === "sd.public.comment",
    );
    return sdPublicComment?.value?.internal === true;
  }

  async getAllCloudComments(apiClient, issueKey) {
    const comments = [];
    let startAt = 0;
    const maxResults = 100;

    while (true) {
      const response = await apiClient.getIssueComments(
        issueKey,
        startAt,
        maxResults,
      );
      const batch = response.comments || [];
      comments.push(...batch);

      if (
        batch.length < maxResults ||
        startAt + batch.length >= response.total
      ) {
        break;
      }
      startAt += maxResults;
    }

    return comments;
  }
}

// =============================================================================
// CLI
// =============================================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    input: null,
    dryRun: false,
    workers: 10,
    limit: 0,
    filterType: null,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--input":
        options.input = args[++i];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--workers":
        options.workers = parseInt(args[++i], 10);
        break;
      case "--limit":
        options.limit = parseInt(args[++i], 10);
        break;
      case "--filter-type":
        options.filterType = args[++i];
        break;
      case "--help":
        options.help = true;
        break;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Sync Comment Visibility to Cloud

Usage:
  node sync_comment_visibility_to_cloud.js --input <file> [options]

Required:
  --input <file>       Path to DC comment visibility JSON file

Options:
  --dry-run            Preview changes without updating Cloud
  --workers <n>        Number of parallel workers (default: 10)
  --limit <n>          Limit number of comments to process
  --filter-type <t>    Only process comments with visibility type (role|group)
  --help               Show this help message

Examples:
  # Dry run to preview changes
  node sync_comment_visibility_to_cloud.js --input dc_data.json --dry-run

  # Process with 20 workers
  node sync_comment_visibility_to_cloud.js --input dc_data.json --workers 20

  # Process only role-restricted comments
  node sync_comment_visibility_to_cloud.js --input dc_data.json --filter-type role
`);
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (!options.input) {
    console.error("ERROR: --input is required");
    showHelp();
    process.exit(1);
  }

  if (!fs.existsSync(options.input)) {
    console.error(`ERROR: Input file not found: ${options.input}`);
    process.exit(1);
  }

  const sync = new CommentVisibilitySync(options);
  await sync.run();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
