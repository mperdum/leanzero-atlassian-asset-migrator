/**
 * Cloud API Client Module
 *
 * Centralized API client for Jira Cloud Assets API calls.
 * Reuses the same authentication and endpoints as the main migration script.
 */

const https = require("https");

class CloudApiClient {
  constructor(workspaceId, apiToken, baseUrl) {
    this.workspaceId = workspaceId;
    this.apiToken = apiToken;
    this.baseUrl = baseUrl;
    this.hostname = "api.atlassian.com";
    this.requestCount = 0;
    this.errorCount = 0;
    this.retryDelay = 1000;
    this.maxRetries = 3;
  }

  /**
   * Get the Jira instance hostname from baseUrl
   * Extracts hostname from URLs like "https://your-company.atlassian.net" or "your-company.atlassian.net"
   */
  getJiraHostname() {
    if (!this.baseUrl) {
      return null;
    }
    // Remove protocol if present
    const withoutProtocol = this.baseUrl.replace(/^https?:\/\//, "");
    // Remove path if present
    const withoutPath = withoutProtocol.split("/")[0];
    return withoutPath;
  }

  /**
   * Get all schemas from Jira Cloud Assets
   */
  async getSchemas() {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/objectschema/list`;
    const response = await this.makeRequest("GET", endpoint);
    return response.values || [];
  }

  /**
   * Get all object types for a specific schema
   */
  async getObjectTypes(schemaId) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/objectschema/${schemaId}/objecttypes`;
    const response = await this.makeRequest("GET", endpoint);
    return Array.isArray(response) ? response : [];
  }

  /**
   * Get all attributes for a specific object type
   */
  async getObjectTypeAttributes(objectTypeId) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/objecttype/${objectTypeId}/attributes`;
    return await this.makeRequest("GET", endpoint);
  }

  /**
   * Create a new object in Jira Cloud Assets
   */
  async createObject(objectData) {
    await this.sleep(100); // 100ms delay between creates
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/object/create`;
    return await this.makeRequest("POST", endpoint, objectData);
  }

  /**
   * Update an existing object in Jira Cloud Assets
   */
  async updateObject(objectId, objectData) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/object/${objectId}`;
    return await this.makeRequest("PUT", endpoint, objectData);
  }

  /**
   * Get an object by ID
   */
  async getObject(objectId) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/object/${objectId}`;
    return await this.makeRequest("GET", endpoint);
  }

  /**
   * Execute AQL query
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
   * Search for Jira Platform user by email, name, or accountId
   * Returns user object with accountId, emailAddress, displayName
   */
  async searchJiraUser(query) {
    const jiraHostname = this.getJiraHostname();
    if (!jiraHostname) {
      console.error(
        "Error: No Jira hostname available. Check CLOUD_BASE_URL environment variable.",
      );
      return null;
    }

    const endpoint = `/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=50`;
    const response = await this.makeRequest(
      "GET",
      endpoint,
      null,
      0,
      jiraHostname,
    );

    if (!Array.isArray(response) || response.length === 0) {
      return null;
    }

    // Filter to only active, non-app users
    const activeUsers = response.filter(
      (u) => u.active !== false && u.accountType === "atlassian",
    );

    if (activeUsers.length === 0) {
      if (process.env.DEBUG === "true") {
        console.log(
          `      DEBUG: ${response.length} results for "${query}" but none are active atlassian users`,
        );
      }
      return null;
    }

    const queryLower = query.toLowerCase();

    // 1. Exact email match (if emailAddress is available)
    const emailMatch = activeUsers.find(
      (u) => u.emailAddress && u.emailAddress.toLowerCase() === queryLower,
    );
    if (emailMatch) {
      return emailMatch;
    }

    // 2. Match by displayName containing the email prefix (before @)
    const emailPrefix = queryLower.split("@")[0];
    if (emailPrefix) {
      const displayNameMatch = activeUsers.find((u) => {
        const dn = (u.displayName || "").toLowerCase();
        // Check if display name parts match the email prefix parts (e.g. "john.doe" -> "John Doe")
        const prefixParts = emailPrefix.split(/[._-]/);
        return prefixParts.every((part) => dn.includes(part));
      });
      if (displayNameMatch) {
        return displayNameMatch;
      }
    }

    // 3. Fallback: return first active user
    if (process.env.DEBUG === "true") {
      console.log(
        `      DEBUG: No exact match for "${query}", using first active result: ${activeUsers[0].displayName} (${activeUsers[0].accountId})`,
      );
    }
    return activeUsers[0];
  }

  /**
   * Make HTTP request with retries
   */
  async makeRequest(
    method,
    endpoint,
    body = null,
    retryCount = 0,
    hostnameOverride = null,
  ) {
    this.requestCount++;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: hostnameOverride || this.hostname,
        path: endpoint,
        method: method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      };

      if (process.env.DEBUG === "true") {
        console.log(`    [API] ${method} https://${this.hostname}${endpoint}`);
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
            console.log(`    Rate limited. Waiting ${retryAfter} seconds...`);
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
              `    Server error ${res.statusCode}. Retrying in ${this.retryDelay}ms...`,
            );
            await this.sleep(this.retryDelay);
            this.retryDelay = Math.min(this.retryDelay * 2, 10000);
            resolve(
              await this.makeRequest(method, endpoint, body, retryCount + 1),
            );
          }
          // Give up
          else {
            this.errorCount++;
            if (res.statusCode === 500) {
              console.log(
                `    Server error 500 after ${this.maxRetries} retries. Continuing...`,
              );
              resolve(null);
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
          console.log(`    Request error: ${error.message}. Retrying...`);
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
          console.log(`    Request timeout. Retrying...`);
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

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  async testConnection() {
    try {
      console.log("  Testing cloud connection...");
      const schemas = await this.getSchemas();
      console.log(`  Connected! Found ${schemas.length} schemas.`);
      return true;
    } catch (error) {
      console.error(`  Connection failed:`, error.message);
      return false;
    }
  }
}

module.exports = CloudApiClient;
