/**
 * Microsoft Graph API Client Module
 *
 * Handles authentication and user retrieval from Microsoft Graph API (Azure AD).
 * Uses client credentials flow for application permissions.
 */

const https = require("https");

class MicrosoftGraphApiClient {
  constructor(clientId, tenantId, clientSecret) {
    this.clientId = clientId;
    this.tenantId = tenantId;
    this.clientSecret = clientSecret;

    // Microsoft Graph API endpoints
    this.tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    this.graphBaseUrl = "https://graph.microsoft.com/v1.0";

    // Token caching
    this.accessToken = null;
    this.tokenExpiry = null;

    // Request tracking
    this.requestCount = 0;
    this.errorCount = 0;

    // Retry configuration
    this.retryDelay = 1000;
    this.maxRetries = 3;
  }

  /**
   * Get access token using client credentials flow
   */
  async getAccessToken() {
    // Check if token is still valid (with 5 minute buffer)
    if (
      this.accessToken &&
      this.tokenExpiry &&
      Date.now() < this.tokenExpiry - 300000
    ) {
      return this.accessToken;
    }

    const params = new URLSearchParams();
    params.append("client_id", this.clientId);
    params.append("scope", "https://graph.microsoft.com/.default");
    params.append("client_secret", this.clientSecret);
    params.append("grant_type", "client_credentials");

    const options = {
      hostname: "login.microsoftonline.com",
      path: `/${this.tenantId}/oauth2/v2.0/token`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              this.accessToken = parsed.access_token;
              this.tokenExpiry = Date.now() + parsed.expires_in * 1000;
              this.requestCount++;
              resolve(this.accessToken);
            } catch (e) {
              reject(new Error(`Failed to parse token response: ${e.message}`));
            }
          } else {
            this.errorCount++;
            const error = new Error(
              `Authentication failed (HTTP ${res.statusCode}): ${data}`,
            );
            error.statusCode = res.statusCode;
            reject(error);
          }
        });
      });

      req.on("error", (error) => {
        this.errorCount++;
        reject(new Error(`Token request failed: ${error.message}`));
      });

      req.write(params.toString());
      req.end();
    });
  }

  /**
   * Fetch users from Microsoft Graph API with filtering and pagination
   * @param {Object} options - Options for fetching users
   * @param {string} options.filter - OData filter query (e.g., "userType eq 'Member'")
   * @param {string} options.select - Comma-separated list of user properties to select
   * @param {string} options.expand - OData expand query (e.g., "manager($levels=1;$select=id,displayName,mail)")
   * @param {number} options.maxResults - Maximum number of results to fetch (0 = unlimited)
   * @returns {Promise<Array>} Array of user objects
   */
  async fetchUsers(options = {}) {
    const filter = options.filter || "userType eq 'Member'";
    const select =
      options.select ||
      "id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation,businessPhones,mobilePhone,accountEnabled,companyName,employeeId,createdDateTime";
    const expand =
      options.expand ||
      "manager($levels=1;$select=id,displayName,mail,userPrincipalName)";
    const maxResults = options.maxResults || 0;

    let users = [];

    let nextLink = `${this.graphBaseUrl}/users?$filter=${encodeURIComponent(filter)}&$select=${select}&$expand=${encodeURIComponent(expand)}`;

    console.log(`Fetching users from Microsoft Graph with filter: ${filter}`);

    while (nextLink && (maxResults === 0 || users.length < maxResults)) {
      const response = await this.makeRequest("GET", nextLink);

      if (response && response.value) {
        // Add users to our collection
        const newUsers = response.value;

        // Apply maxResults limit if specified
        if (maxResults > 0 && users.length + newUsers.length > maxResults) {
          const remaining = maxResults - users.length;
          users = users.concat(newUsers.slice(0, remaining));
          break;
        }

        users = users.concat(newUsers);
        console.log(
          `  Fetched ${newUsers.length} users (total: ${users.length})`,
        );

        // Check for pagination
        nextLink = response["@odata.nextLink"] || null;
      } else {
        break;
      }
    }

    console.log(`✓ Total users fetched: ${users.length}`);
    return users;
  }

  /**
   * Make HTTP request to Microsoft Graph API with authentication
   */
  async makeRequest(method, url, body = null, retryCount = 0) {
    this.requestCount++;

    // Ensure we have a valid access token
    const token = await this.getAccessToken();

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        timeout: 30000,
      };

      if (body) {
        options.headers["Content-Type"] = "application/json";
      }

      if (process.env.DEBUG === "true") {
        console.log(`    [Graph API] ${method} ${url}`);
      }

      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", async () => {
          // Handle rate limiting (429)
          if (res.statusCode === 429) {
            const retryAfter = res.headers["retry-after"]
              ? parseInt(res.headers["retry-after"]) * 1000
              : Math.pow(2, retryCount) * 1000;
            console.log(
              `    Rate limited. Waiting ${retryAfter / 1000} seconds...`,
            );
            await this.sleep(retryAfter);

            if (retryCount < this.maxRetries) {
              return resolve(
                await this.makeRequest(method, url, body, retryCount + 1),
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
            resolve(await this.makeRequest(method, url, body, retryCount + 1));
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
            resolve(this.makeRequest(method, url, body, retryCount + 1));
          }, this.retryDelay);
        } else {
          reject(error);
        }
      });

      req.on("timeout", () => {
        req.destroy();
        if (retryCount < this.maxRetries) {
          console.log(`    Request timeout. Retrying...`);
          resolve(this.makeRequest(method, url, body, retryCount + 1));
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
   * Sleep utility function
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
   * Test connection by fetching a small number of users
   */
  async testConnection() {
    try {
      console.log("  Testing Microsoft Graph connection...");
      const users = await this.fetchUsers({
        filter: "userType eq 'Member'",
        select: "id,displayName",
        maxResults: 1,
      });
      console.log(`  Connected! Successfully fetched ${users.length} user(s).`);
      return true;
    } catch (error) {
      console.error(`  Connection failed:`, error.message);
      return false;
    }
  }
}

module.exports = MicrosoftGraphApiClient;
