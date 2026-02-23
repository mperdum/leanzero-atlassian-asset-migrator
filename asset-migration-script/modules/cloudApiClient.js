/**
 * Cloud API Client Module
 *
 * Centralized API client for all Jira Cloud Assets API calls.
 * Handles authentication, retries, and error handling.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

class CloudApiClient {
  constructor(workspaceId, apiToken, baseUrl) {
    this.workspaceId = workspaceId;
    this.apiToken = apiToken;
    this.baseUrl = baseUrl;
    // For Jira Cloud Assets, always use api.atlassian.com
    this.hostname = "api.atlassian.com";
    this.requestCount = 0;
    this.errorCount = 0;
    this.retryDelay = 1000; // Start with 1 second
    this.maxRetries = 3;

    // Store schema status maps for Type 7 Status field mapping
    // Key: schemaId, Value: Map of statusId -> statusName
    this.schemaStatusMaps = new Map();

    // Store schema ID for each object type for status mapping lookups
    // Key: objectTypeId, Value: schemaId
    this.objectTypeToSchemaMap = new Map();

    // Global statuses - hardcoded fallback for Jira Assets global status types
    // These are system-wide statuses with IDs 1-7
    this.globalStatuses = new Map([
      ["1", "Action Needed"],
      ["2", "Active"],
      ["3", "Closed"],
      ["4", "In Service"],
      ["5", "Running"],
      ["6", "Stopped"],
      ["7", "Support Requested"],
    ]);
  }

  /**
   * Get all schemas from Jira Cloud Assets
   *
   * @returns {Array} - Array of schema objects with id, name, and other properties
   *
   * AI INSTRUCTIONS:
   * - Fetches all available schemas in the workspace using Assets API
   * - Used during cloud configuration loading to map datacenter schemas to cloud schemas
   * - Returns schema objects used by SchemaMapper for fuzzy matching
   * - Critical for plan creation phase - schemas must exist in cloud before migration
   */
  async getSchemas() {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/objectschema/list`;
    const response = await this.makeRequest("GET", endpoint);
    return response.values || [];
  }

  /**
   * Get all object types for a specific schema
   *
   * @param {string} schemaId - Cloud schema ID
   * @returns {Array} - Array of object type objects with id, name, attributes
   *
   * AI INSTRUCTIONS:
   * - Fetches object types for a specific schema using Assets API
   * - Used to map datacenter object types to cloud object types
   * - Object types must exist in cloud before objects can be created
   * - Response is directly an array (not wrapped in response object)
   */
  async getObjectTypes(schemaId) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/objectschema/${schemaId}/objecttypes`;
    const response = await this.makeRequest("GET", endpoint);
    // Response is directly an array, not wrapped in an object
    return Array.isArray(response) ? response : [];
  }

  /**
   * Set schema status map for Type 7 Status field mapping
   *
   * @param {string} schemaId - Cloud schema ID
   * @param {Map} statusMap - Map of statusId -> statusName
   */
  setSchemaStatusMap(schemaId, statusMap) {
    this.schemaStatusMaps.set(schemaId, statusMap);
  }

  /**
   * Set object type to schema mapping
   *
   * @param {string} objectTypeId - Cloud object type ID
   * @param {string} schemaId - Cloud schema ID
   */
  setObjectTypeSchema(objectTypeId, schemaId) {
    this.objectTypeToSchemaMap.set(objectTypeId, schemaId);
  }

  /**
   * Get all attributes for a specific object type
   *
   * @param {string} objectTypeId - Cloud object type ID
   * @returns {Array} - Array of attribute objects with id, name, type, cardinality
   *
   * AI INSTRUCTIONS:
   * - Fetches attribute definitions for object type validation and mapping
   * - Used by plan-driven system to understand cloud object structure
   * - Attribute IDs and types are used for proper field mapping
   * - Critical for ensuring datacenter fields map to existing cloud attributes
   * - Automatically applies schema-level status mapping for Type 7 Status fields
   */
  async getObjectTypeAttributes(objectTypeId) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/objecttype/${objectTypeId}/attributes`;
    const attributes = await this.makeRequest("GET", endpoint);

    // Apply schema status mapping for Type 7 fields
    const schemaId = this.objectTypeToSchemaMap.get(String(objectTypeId));

    for (const attr of attributes) {
      // Type 7 = Status fields - use schema-level + global status mapping
      if (
        attr.type === 7 &&
        attr.typeValueMulti &&
        attr.typeValueMulti.length > 0
      ) {
        const statusNames = [];

        for (const id of attr.typeValueMulti) {
          const idStr = String(id);
          let statusName = null;

          // First try schema-specific statuses
          if (schemaId) {
            const schemaStatusMap = this.schemaStatusMaps.get(schemaId);
            if (schemaStatusMap) {
              statusName = schemaStatusMap.get(idStr);
            }
          }

          // Fallback to global statuses (IDs 1-7)
          if (!statusName) {
            statusName = this.globalStatuses.get(idStr);
          }

          if (statusName) {
            statusNames.push(statusName);
          }
        }

        if (statusNames.length > 0) {
          attr.options = statusNames.join(",");
        }
      }
    }

    return attributes;
  }

  /**
   * Create a new object in Jira Cloud Assets
   *
   * @param {Object} objectData - Object data with objectTypeId and attributes array
   * @returns {Object} - Created object with id, objectKey, and other properties
   *
   * AI INSTRUCTIONS:
   * - Core method for object creation in plan-driven migration
   * - objectData must include objectTypeId and attributes array
   * - Each attribute must have objectTypeAttributeId and objectAttributeValues
   * - Returns created object which is immediately tracked in created_objects_mapping.json
   * - Used exclusively by plan-driven objectMigrator for deterministic object creation
   */
  async createObject(objectData) {
    // Add a small delay to prevent overwhelming the server
    // This helps avoid 500 errors caused by too many rapid requests
    await this.sleep(100); // 100ms delay between creates

    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/object/create`;
    return await this.makeRequest("POST", endpoint, objectData);
  }

  /**
   * Update an existing object in Jira Cloud Assets
   *
   * @param {string} objectId - Cloud object ID to update
   * @param {Object} objectData - Updated object data with attributes
   * @returns {Object} - Updated object response
   *
   * AI INSTRUCTIONS:
   * - Used for updating objects with reference fields after initial creation
   * - Critical for circular reference resolution in post-processing phase
   * - Updates existing objects with previously omitted circular reference fields
   * - Called by objectMigrator.updateObjectWithReferenceFields() method
   */
  async updateObject(objectId, objectData) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/object/${objectId}`;
    return await this.makeRequest("PUT", endpoint, objectData);
  }

  /**
   * Get an object by ID from Jira Cloud Assets
   *
   * @param {string} objectId - Cloud object ID
   * @returns {Object} - Object data with all attributes and properties
   *
   * AI INSTRUCTIONS:
   * - Retrieves complete object data for verification or analysis
   * - Used sparingly in plan-driven approach (system avoids cloud queries when possible)
   * - Primarily used for validation and debugging purposes
   * - Returns full object structure including objectKey, attributes, etc.
   */
  async getObject(objectId) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/object/${objectId}`;
    return await this.makeRequest("GET", endpoint);
  }

  /**
   * Execute AQL (Assets Query Language) query
   *
   * @param {string} aqlQuery - AQL query string
   * @param {number} startAt - Starting index for pagination
   * @param {number} maxResults - Maximum results to return
   * @param {boolean} includeAttributes - Whether to include object attributes
   * @returns {Object} - Query results with values array and pagination info
   *
   * AI INSTRUCTIONS:
   * - Used primarily by circularReferenceTracker for finding target objects
   * - Plan-driven approach minimizes AQL usage (prefers mapping lookups)
   * - When used, queries are for specific object resolution during circular reference processing
   * - Always include proper error handling for AQL syntax issues
   */
  async executeAQL(
    aqlQuery,
    startAt = 0,
    maxResults = 25,
    includeAttributes = true,
  ) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/object/aql`;
    const queryParams = `?startAt=${startAt}&maxResults=${maxResults}&includeAttributes=${includeAttributes}`;

    return await this.makeRequest("POST", endpoint + queryParams, {
      qlQuery: aqlQuery,
    });
  }

  /**
   * Get object change history from Jira Cloud Assets
   *
   * @param {string} objectId - Cloud object ID
   * @returns {Object} - Object history with change entries
   *
   * AI INSTRUCTIONS:
   * - Used for debugging and audit purposes
   * - Not part of core migration flow - primarily for troubleshooting
   * - Provides change tracking for migration validation
   * - Rarely used in plan-driven approach
   */
  async getObjectHistory(objectId) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/object/${objectId}/history`;
    return await this.makeRequest("GET", endpoint);
  }

  /**
   * Make HTTP request with retries
   */
  async makeRequest(method, endpoint, body = null, retryCount = 0) {
    this.requestCount++;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        path: endpoint,
        method: method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 30000, // 30 second timeout
      };

      // Debug logging
      if (process.env.DEBUG === "true" || retryCount === 0) {
        console.log(`    🔧 ${method} https://${this.hostname}${endpoint}`);
      }

      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", async () => {
          // Handle rate limiting
          if (res.statusCode === 429) {
            const retryAfter =
              res.headers["retry-after"] || Math.pow(2, retryCount);
            console.log(
              `    ⏸️  Rate limited. Waiting ${retryAfter} seconds...`,
            );
            await this.sleep(retryAfter * 1000);

            if (retryCount < this.maxRetries) {
              return resolve(
                await this.makeRequest(method, endpoint, body, retryCount + 1),
              );
            }
          }

          // Handle success
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = data ? JSON.parse(data) : {};
              resolve(parsed);
            } catch (e) {
              resolve(data);
            }
          }
          // Handle client errors (no retry)
          else if (
            res.statusCode >= 400 &&
            res.statusCode < 500 &&
            res.statusCode !== 429
          ) {
            this.errorCount++;
            const error = new Error(`HTTP ${res.statusCode}: ${data}`);
            error.statusCode = res.statusCode;
            error.response = data;
            reject(error);
          }
          // Handle server errors (retry)
          else if (res.statusCode >= 500 && retryCount < this.maxRetries) {
            console.log(
              `    ⚠️  Server error ${res.statusCode}. Retrying in ${this.retryDelay}ms...`,
            );
            await this.sleep(this.retryDelay);
            this.retryDelay = Math.min(this.retryDelay * 2, 10000); // Exponential backoff up to 10 seconds
            resolve(
              await this.makeRequest(method, endpoint, body, retryCount + 1),
            );
          }
          // Give up
          else {
            this.errorCount++;
            // For 500 errors, log but don't crash - return null to continue migration
            if (res.statusCode === 500) {
              console.log(
                `    ❌ Server error 500 after ${this.maxRetries} retries. Logging and continuing...`,
              );

              resolve(null); // Return null to indicate failure but continue
            } else {
              const error = new Error(`HTTP ${res.statusCode}: ${data}`);
              error.statusCode = res.statusCode;
              error.response = data;
              reject(error);
            }
          }
        });
      });

      req.on("error", (error) => {
        this.errorCount++;
        if (retryCount < this.maxRetries) {
          console.log(`    ⚠️  Request error: ${error.message}. Retrying...`);
          setTimeout(() => {
            resolve(this.makeRequest(method, endpoint, body, retryCount + 1));
          }, this.retryDelay);
        } else {
          reject(error);
        }
      });

      req.on("timeout", () => {
        req.destroy();
        if (retryCount < this.maxRetries) {
          console.log(`    ⚠️  Request timeout. Retrying...`);
          resolve(this.makeRequest(method, endpoint, body, retryCount + 1));
        } else {
          reject(new Error("Request timeout after retries"));
        }
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Sleep for specified milliseconds
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get API statistics
   */
  getStats() {
    return {
      totalRequests: this.requestCount,
      totalErrors: this.errorCount,
      errorRate:
        this.requestCount > 0
          ? ((this.errorCount / this.requestCount) * 100).toFixed(2) + "%"
          : "0%",
    };
  }

  /**
   * Batch create objects
   */
  async batchCreateObjects(objects, batchSize = 10) {
    const results = [];
    const batches = [];

    // Split into batches
    for (let i = 0; i < objects.length; i += batchSize) {
      batches.push(objects.slice(i, i + batchSize));
    }

    // Process batches
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(
        `    📦 Processing batch ${i + 1}/${batches.length} (${batch.length} objects)`,
      );

      // Process batch in parallel
      const batchPromises = batch.map((obj) =>
        this.createObject(obj)
          .then((result) => ({ success: true, result }))
          .catch((error) => ({ success: false, error, object: obj })),
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Small delay between batches to avoid rate limiting
      if (i < batches.length - 1) {
        await this.sleep(500);
      }
    }

    return results;
  }

  /**
   * Test connectivity
   */
  async testConnection() {
    try {
      console.log("  🔌 Testing cloud connection...");
      const schemas = await this.getSchemas();

      return true;
    } catch (error) {
      console.error(`  ❌ Connection failed:`, error.message);
      return false;
    }
  }
}

module.exports = CloudApiClient;
