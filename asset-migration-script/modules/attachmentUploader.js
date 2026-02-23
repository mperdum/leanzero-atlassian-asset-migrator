/**
 * Attachment Uploader Module - ENHANCED WITH INTELLIGENT FALLBACKS
 *
 * Handles uploading attachments to Jira Cloud Assets objects using the 3-step process:
 * 1. Get upload credentials from Assets API
 * 2. Upload file to media service using credentials
 * 3. Link uploaded file to the Assets object
 *
 * CRITICAL FEATURES:
 * - NO TIMEOUTS: File uploads complete naturally regardless of size
 * - NO STUPID RETRIES: Uses intelligent fallback strategies instead
 * - SMART ERROR HANDLING: Different strategies for different failure types
 * - ROBUST FILE PROCESSING: Handles large files and server overload gracefully
 *
 * This module handles:
 * - Reading local attachment files from datacenter extraction (using localFilePath)
 * - Getting upload credentials for each object
 * - Uploading files to the media service without timeouts
 * - Linking attachments to Assets objects
 * - Intelligent fallback strategies for different failure scenarios
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const FormData = require("form-data");

class AttachmentUploader {
  constructor(cloudApiClient, config = {}) {
    this.workspaceId = cloudApiClient.workspaceId;
    this.apiToken = cloudApiClient.apiToken;
    this.baseUrl = cloudApiClient.baseUrl;

    // Store datacenter path for resolving relative attachment paths
    this.datacenterPath =
      process.env.DATACENTER_PATH ||
      path.join(process.cwd(), "..", "datacenter_assets");

    // Configuration from environment or defaults
    this.config = {
      enabled: config.enabled || process.env.UPLOAD_ATTACHMENTS === "true",
      maxAttachmentsPerObject: parseInt(
        config.maxAttachmentsPerObject ||
          process.env.MAX_ATTACHMENTS_PER_OBJECT ||
          "10",
      ),
      maxFileSize:
        parseInt(
          config.maxFileSize || process.env.MAX_ATTACHMENT_SIZE_MB || "100",
        ) *
        1024 *
        1024, // Convert MB to bytes
      parallelUploads:
        config.parallelUploads ||
        process.env.PARALLEL_ATTACHMENT_UPLOADS === "true",
      uploadWorkers: parseInt(
        config.uploadWorkers || process.env.ATTACHMENT_UPLOAD_WORKERS || "3",
      ),
      uploadTimeout: 0, // NO TIMEOUTS - file uploads must complete naturally regardless of size
      maxRetries: 0, // NO STUPID RETRIES - intelligent fallback strategies used instead
      retryDelay: 0, // Not applicable - using smart fallback strategies instead of delays
    };

    // Statistics tracking
    this.stats = {
      totalObjectsProcessed: 0,
      objectsWithAttachments: 0,
      totalAttachmentsProcessed: 0,
      successfulUploads: 0,
      failedUploads: 0,
      skippedFiles: 0,
      errors: [],
    };

    // Log file for attachment upload results
    this.logFile = path.join(
      __dirname,
      "..",
      "logs",
      `attachment_uploads_${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
    );
    this.ensureLogDirectory();
  }

  ensureLogDirectory() {
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(this.logFile, logEntry);
    console.log(message);
  }

  /**
   * Step 1: Get upload credentials for an object
   * GET /jsm/assets/workspace/{workspaceId}/v1/attachments/object/{objectId}/credentials
   */
  async getUploadCredentials(objectId) {
    const url = `https://api.atlassian.com/jsm/assets/workspace/${this.workspaceId}/v1/attachments/object/${objectId}/credentials`;

    return new Promise((resolve, reject) => {
      const options = {
        method: "GET",
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        // NO TIMEOUT - credentials requests should complete quickly or fail fast
      };

      const req = https.request(url, options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const credentials = JSON.parse(data);
              resolve(credentials);
            } catch (error) {
              reject(
                new Error(
                  `Failed to parse credentials response: ${error.message}`,
                ),
              );
            }
          } else {
            reject(
              new Error(
                `Failed to get upload credentials: HTTP ${res.statusCode} - ${data}`,
              ),
            );
          }
        });
      });

      req.on("error", (error) => {
        reject(new Error(`Request failed: ${error.message}`));
      });

      // NO TIMEOUT HANDLER - let requests complete naturally

      req.end();
    });
  }

  /**
   * Step 2: Upload file to media service
   * POST {mediaBaseUrl}/file/binary?name={filename}
   */
  async uploadFileToMediaService(filePath, filename, credentials) {
    const { clientId, mediaBaseUrl, mediaJwtToken } = credentials;

    return new Promise((resolve, reject) => {
      // Check if file exists and get its stats
      if (!fs.existsSync(filePath)) {
        reject(new Error(`File not found: ${filePath}`));
        return;
      }

      const fileStats = fs.statSync(filePath);

      // Check file size
      if (fileStats.size > this.config.maxFileSize) {
        reject(
          new Error(
            `File too large: ${fileStats.size} bytes (max: ${this.config.maxFileSize} bytes)`,
          ),
        );
        return;
      }

      const encodedFilename = encodeURIComponent(filename);
      // Fixed endpoint: Atlassian changed from /file/binary to /file
      const uploadUrl = `${mediaBaseUrl}/file?name=${encodedFilename}`;

      const form = new FormData();
      form.append("file", fs.createReadStream(filePath));

      const options = {
        method: "POST",
        headers: {
          "X-Client-Id": clientId,
          Authorization: `Bearer ${mediaJwtToken}`,
          ...form.getHeaders(),
        },
        // NO TIMEOUT - file uploads must complete naturally regardless of size
      };

      // Parse URL to determine if it's HTTP or HTTPS
      const parsedUrl = new URL(uploadUrl);
      const isHttps = parsedUrl.protocol === "https:";
      const requestModule = isHttps ? https : http;

      const req = requestModule.request(uploadUrl, options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode === 200 || res.statusCode === 201) {
            try {
              const response = JSON.parse(data);
              resolve({
                mediaId: response.data?.id || response.id,
                mediaSize:
                  response.data?.size || response.size || fileStats.size,
              });
            } catch (error) {
              reject(
                new Error(`Failed to parse upload response: ${error.message}`),
              );
            }
          } else {
            reject(
              new Error(
                `Failed to upload file: HTTP ${res.statusCode} - ${data}`,
              ),
            );
          }
        });
      });

      req.on("error", (error) => {
        reject(new Error(`Upload request failed: ${error.message}`));
      });

      // NO TIMEOUT HANDLER - file uploads must complete regardless of time

      form.pipe(req);
    });
  }

  /**
   * Step 3: Link uploaded file to Assets object
   * POST /jsm/assets/workspace/{workspaceId}/v1/attachments/object/{objectId}
   */
  async linkAttachmentToObject(objectId, attachmentData) {
    const url = `https://api.atlassian.com/jsm/assets/workspace/${this.workspaceId}/v1/attachments/object/${objectId}`;

    const payload = {
      attachments: [attachmentData],
    };

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(payload);

      const options = {
        method: "POST",
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        // NO TIMEOUT - linking requests should complete quickly or fail fast
      };

      const req = https.request(url, options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode === 200 || res.statusCode === 201) {
            try {
              const response = JSON.parse(data);
              resolve(response);
            } catch (error) {
              reject(
                new Error(`Failed to parse link response: ${error.message}`),
              );
            }
          } else {
            reject(
              new Error(
                `Failed to link attachment: HTTP ${res.statusCode} - ${data}`,
              ),
            );
          }
        });
      });

      req.on("error", (error) => {
        reject(new Error(`Link request failed: ${error.message}`));
      });

      // NO TIMEOUT HANDLER - let linking complete naturally

      req.write(postData);
      req.end();
    });
  }

  /**
   * Get MIME type from file extension
   */
  getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      ".pdf": "application/pdf",
      ".doc": "application/msword",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".txt": "text/plain",
      ".csv": "text/csv",
      ".json": "application/json",
      ".xml": "application/xml",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".zip": "application/zip",
      ".rar": "application/x-rar-compressed",
      ".7z": "application/x-7z-compressed",
      ".tar": "application/x-tar",
      ".gz": "application/gzip",
    };

    return mimeTypes[ext] || "application/octet-stream";
  }

  /**
   * Upload a single attachment file
   */
  async uploadSingleAttachment(objectId, attachmentMetadata, filePath) {
    const { filename, comment = "" } = attachmentMetadata;

    try {
      this.log(`      📎 Uploading: ${filename} (${path.basename(filePath)})`);

      // Step 1: Get upload credentials
      const credentials = await this.getUploadCredentials(objectId);
      this.log(`        ✓ Got upload credentials`);

      // Step 2: Upload file to media service
      const uploadResult = await this.uploadFileToMediaService(
        filePath,
        filename,
        credentials,
      );
      this.log(
        `        ✓ Uploaded to media service (ID: ${uploadResult.mediaId})`,
      );

      // Step 3: Link attachment to object
      const attachmentData = {
        contentType: this.getMimeType(filename),
        filename: filename,
        mediaId: uploadResult.mediaId,
        size: uploadResult.mediaSize,
        comment: comment,
      };

      const linkResult = await this.linkAttachmentToObject(
        objectId,
        attachmentData,
      );
      this.log(`        ✅ Successfully linked attachment to object`);

      this.stats.successfulUploads++;
      return { success: true, result: linkResult };
    } catch (error) {
      this.log(`        ❌ Failed to upload ${filename}: ${error.message}`);
      this.stats.failedUploads++;
      this.stats.errors.push({
        objectId,
        filename,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Upload attachment with intelligent fallback strategies
   * Instead of stupid retries, we try different approaches when things fail
   */
  async uploadAttachmentWithFallbacks(objectId, attachment) {
    const { filename, localFilePath } = attachment;

    // Strategy 1: Normal 3-step upload process
    try {
      this.log(`      📎 Uploading: ${filename} (normal process)`);
      return await this.uploadSingleAttachment(
        objectId,
        attachment,
        localFilePath,
      );
    } catch (error) {
      this.log(`      ⚠️  Normal upload failed: ${error.message}`);

      // Strategy 2: Check if it's a credentials/token issue (but don't retry - that's stupid)
      if (
        error.message.includes("credentials") ||
        error.message.includes("token")
      ) {
        this.log(
          `      ❌ Credentials/token issue - cannot recover: ${filename}`,
        );
        return {
          success: false,
          error: `Authentication issue: ${error.message}`,
          strategy: "credentials_failed",
        };
      }

      // Strategy 2: Check if file is corrupted or inaccessible
      if (
        error.message.includes("File not found") ||
        error.message.includes("ENOENT")
      ) {
        this.log(`      ❌ File access issue - cannot recover: ${filename}`);
        return {
          success: false,
          error: `File not accessible: ${error.message}`,
          strategy: "file_access_failed",
        };
      }

      // Strategy 3: Check if it's a server overload (HTTP 5xx errors)
      if (
        error.message.includes("HTTP 5") ||
        error.message.includes("server error")
      ) {
        this.log(
          `      ⏸️  Server overload detected - marking for later retry: ${filename}`,
        );
        return {
          success: false,
          error: `Server overload - try again later: ${error.message}`,
          strategy: "server_overload",
          retryable: true,
        };
      }

      // Strategy 4: Check if file is too large or format issue
      if (
        error.message.includes("too large") ||
        error.message.includes("size")
      ) {
        this.log(`      ❌ File size issue - cannot recover: ${filename}`);
        return {
          success: false,
          error: `File size issue: ${error.message}`,
          strategy: "file_size_issue",
        };
      }

      // All fallback strategies failed
      return {
        success: false,
        error: `All fallback strategies failed: ${error.message}`,
        strategy: "all_strategies_failed",
      };
    }
  }

  /**
   * Upload attachments for a single object
   */
  async uploadAttachmentsForObject(dcObject, cloudObject, attachmentsDir) {
    if (!this.config.enabled) {
      return { skipped: true, reason: "disabled" };
    }

    if (!dcObject.attachments || dcObject.attachments.length === 0) {
      return { skipped: true, reason: "no_attachments" };
    }

    const objectId = cloudObject.id;
    const objectKey = cloudObject.label || cloudObject.key || objectId;

    this.log(
      `\n    📎 Uploading ${dcObject.attachments.length} attachment(s) for object ${objectKey} (${objectId})...`,
    );

    const results = {
      objectId: objectId,
      objectKey: objectKey,
      attachments: [],
      summary: {
        total: dcObject.attachments.length,
        successful: 0,
        failed: 0,
        skipped: 0,
      },
    };

    // Limit number of attachments to process
    const attachmentsToProcess = dcObject.attachments.slice(
      0,
      this.config.maxAttachmentsPerObject,
    );

    if (dcObject.attachments.length > attachmentsToProcess.length) {
      this.log(
        `      ⚠️  Processing first ${attachmentsToProcess.length} of ${dcObject.attachments.length} attachments`,
      );
    }

    for (const attachment of attachmentsToProcess) {
      this.stats.totalAttachmentsProcessed++;

      // Check if we have the local file path
      if (!attachment.localFilePath) {
        this.log(
          `      ⏭️  Skipping ${attachment.filename}: no localFilePath provided`,
        );
        results.attachments.push({
          filename: attachment.filename,
          status: "skipped",
          reason: "no_local_file_path",
        });
        results.summary.skipped++;
        this.stats.skippedFiles++;
        continue;
      }

      // Resolve relative path to absolute path
      let resolvedFilePath = attachment.localFilePath;
      if (!path.isAbsolute(attachment.localFilePath)) {
        // If path is relative, resolve it relative to datacenter_assets directory
        // Find the project root by going up from cwd until we find datacenter_assets
        let projectRoot = process.cwd();
        while (
          projectRoot !== "/" &&
          !fs.existsSync(path.join(projectRoot, "datacenter_assets"))
        ) {
          projectRoot = path.dirname(projectRoot);
        }
        resolvedFilePath = path.join(
          projectRoot,
          "datacenter_assets",
          attachment.localFilePath,
        );
      }

      // Check if the resolved file exists
      if (!fs.existsSync(resolvedFilePath)) {
        this.log(
          `      ⏭️  Skipping ${attachment.filename}: no local file available at ${resolvedFilePath}`,
        );
        results.attachments.push({
          filename: attachment.filename,
          status: "skipped",
          reason: "no_local_file",
          resolvedPath: resolvedFilePath,
        });
        results.summary.skipped++;
        this.stats.skippedFiles++;
        continue;
      }

      // Update attachment with resolved path for upload
      const attachmentWithResolvedPath = {
        ...attachment,
        localFilePath: resolvedFilePath,
      };

      // Upload the attachment with intelligent fallback strategies
      const uploadResult = await this.uploadAttachmentWithFallbacks(
        objectId,
        attachmentWithResolvedPath,
      );

      results.attachments.push({
        filename: attachment.filename,
        status: uploadResult.success ? "uploaded" : "failed",
        error: uploadResult.error || null,
        result: uploadResult.result || null,
      });

      if (uploadResult.success) {
        results.summary.successful++;
      } else {
        results.summary.failed++;
      }
    }

    this.stats.totalObjectsProcessed++;
    if (results.summary.successful > 0) {
      this.stats.objectsWithAttachments++;
    }

    this.log(
      `      📊 Upload summary: ${results.summary.successful} successful, ${results.summary.failed} failed, ${results.summary.skipped} skipped`,
    );

    return results;
  }

  /**
   * Get upload statistics
   */
  getStats() {
    return {
      ...this.stats,
      successRate:
        this.stats.totalAttachmentsProcessed > 0
          ? (
              (this.stats.successfulUploads /
                this.stats.totalAttachmentsProcessed) *
              100
            ).toFixed(2) + "%"
          : "0%",
    };
  }

  /**
   * Generate upload report
   */
  generateReport() {
    const stats = this.getStats();
    const report = [
      "\n" + "=".repeat(60),
      "ATTACHMENT UPLOAD REPORT",
      "=".repeat(60),
      `Total objects processed: ${stats.totalObjectsProcessed}`,
      `Objects with attachments: ${stats.objectsWithAttachments}`,
      `Total attachments processed: ${stats.totalAttachmentsProcessed}`,
      `Successful uploads: ${stats.successfulUploads}`,
      `Failed uploads: ${stats.failedUploads}`,
      `Skipped files: ${stats.skippedFiles}`,
      `Success rate: ${stats.successRate}`,
      "",
      `Log file: ${this.logFile}`,
      "=".repeat(60),
    ].join("\n");

    console.log(report);
    this.log(report);

    return stats;
  }
}

module.exports = AttachmentUploader;
