/**
 * Ticket Connector Module
 *
 * Connects Jira tickets to migrated Assets objects by updating the ticket's
 * asset custom fields with references to the migrated objects.
 *
 * This module handles:
 * - Extracting ticket information from migrated objects
 * - Updating Jira issues with asset references
 * - Batch processing of ticket updates
 * - Error handling and retry logic
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

/**
 * Check if a field match is problematic and should be penalized
 * This prevents incorrect matches like "Deputy Asset Owner" → "Asset Owner"
 */
function checkProblematicFieldMatch(datacenterFieldName, cloudFieldName) {
  // Convert to lowercase for comparison
  const dcFieldLower = datacenterFieldName.toLowerCase();
  const cloudFieldLower = cloudFieldName.toLowerCase();

  // Check if one field name is contained within another (the problematic case)
  if (
    dcFieldLower.includes(cloudFieldLower) ||
    cloudFieldLower.includes(dcFieldLower)
  ) {
    // If the fields are significantly different in meaning, this is problematic
    // Create a list of common field names that should not be matched this way
    const problematicPatterns = [
      "asset owner",
      "deputy asset owner",
      "owner",
      "manager",
      "administrator",
      "support",
    ];

    // Check if either field contains any problematic pattern
    const hasProblematicPattern = problematicPatterns.some(
      (pattern) =>
        dcFieldLower.includes(pattern) || cloudFieldLower.includes(pattern),
    );

    // Additional heuristic: if one field is much shorter than the other
    const dcLength = dcFieldLower.length;
    const cloudLength = cloudFieldLower.length;

    // If one is significantly shorter than the other (more than 2x difference), it's suspicious
    if (
      (dcLength > cloudLength * 2 || cloudLength > dcLength * 2) &&
      hasProblematicPattern
    ) {
      // This could be a problematic match like "Asset Owner" vs "Deputy Asset Owner"
      return true;
    }

    // If the fields are very short but one contains another, it's likely problematic
    if (
      (dcLength < 15 && cloudLength > 20) ||
      (cloudLength < 15 && dcLength > 20)
    ) {
      return true;
    }
  }

  return false;
}

class TicketConnector {
  constructor(cloudApiClient, config = {}) {
    this.cloudApiClient = cloudApiClient;
    this.workspaceId = cloudApiClient.workspaceId;
    this.apiToken = cloudApiClient.apiToken;
    this.baseUrl = cloudApiClient.baseUrl;

    // Created objects mapping for resolving datacenter keys to cloud IDs
    this.createdObjectsMapping = null;

    // Logger function (can be overridden)
    this.logger = config.logger || console.log;

    // Configuration from environment or defaults
    this.config = {
      enabled:
        config.enabled || process.env.CONNECT_TICKETS_TO_OBJECTS === "true",
      parallelUpdates:
        config.parallelUpdates ||
        process.env.PARALLEL_TICKET_UPDATES === "true",
      updateWorkers: parseInt(
        config.updateWorkers || process.env.TICKET_UPDATE_WORKERS || "5",
      ),
      updateDelay: parseInt(
        config.updateDelay || process.env.TICKET_UPDATE_DELAY || "200",
      ),
      maxRetries: parseInt(config.maxRetries || process.env.MAX_RETRIES || "3"),
      retryDelay: parseInt(
        config.retryDelay || process.env.RETRY_DELAY || "1000",
      ),
    };

    // Statistics tracking
    this.stats = {
      totalTicketsProcessed: 0,
      successfulUpdates: 0,
      failedUpdates: 0,
      skippedTickets: 0,
      errors: [],
    };

    // Cloud custom field cache (fieldName -> fieldId mapping)
    this.cloudCustomFieldsCache = null;
    this.cloudCustomFieldsByName = new Map();

    // Log file for ticket connection results
    this.logFile = path.join(process.cwd(), "logs", "ticket_connections.log");
    this.ensureLogDirectory();
  }

  /**
   * Ensure log directory exists
   */
  ensureLogDirectory() {
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Load created objects mapping for resolving datacenter keys to cloud IDs
   */
  loadCreatedObjectsMapping() {
    if (this.createdObjectsMapping) {
      return; // Already loaded
    }

    // Try multiple possible locations for the mapping file
    const possiblePaths = [
      path.join(process.cwd(), "logs", "created_objects_mapping.json"), // Current working directory
      path.join(__dirname, "..", "logs", "created_objects_mapping.json"), // Relative to module
      path.join(
        process.cwd(),
        "..",
        "asset-migration-script",
        "logs",
        "created_objects_mapping.json",
      ), // From standalone-utilities
    ];

    let mappingFilePath = null;
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        mappingFilePath = possiblePath;
        break;
      }
    }

    if (!mappingFilePath) {
      console.log(
        `      ⚠️  Created objects mapping not found in any of these locations:`,
      );
      possiblePaths.forEach((p) => console.log(`         - ${p}`));
      this.createdObjectsMapping = new Map();
      return;
    }

    console.log(
      `      📂 Loading created objects mapping from: ${mappingFilePath}`,
    );

    try {
      const rawData = fs.readFileSync(mappingFilePath, "utf8");
      const mappingData = JSON.parse(rawData);

      this.createdObjectsMapping = new Map();

      if (mappingData.mappings && Array.isArray(mappingData.mappings)) {
        // Process Map-style array format
        for (const [key, value] of mappingData.mappings) {
          if (
            value &&
            typeof value === "object" &&
            value.datacenterKey &&
            value.cloudId
          ) {
            this.createdObjectsMapping.set(key, value);
            // Also map by name for additional lookup options
            if (value.name) {
              this.createdObjectsMapping.set(`name:${value.name}`, value);
            }
          }
        }
      }

      console.log(
        `      ✅ Loaded ${this.createdObjectsMapping.size} object mappings for ticket connections`,
      );
    } catch (error) {
      console.log(
        `      ⚠️  Failed to load created objects mapping: ${error.message}`,
      );
      this.createdObjectsMapping = new Map();
    }
  }

  /**
   * Log ticket connection attempt with detailed field and asset context
   *
   * @param {string} ticketKey - Jira ticket key (e.g. "PROJ-123")
   * @param {string} objectId - Cloud object ID being connected
   * @param {boolean} success - Whether the connection succeeded
   * @param {Error|string|null} error - Error object or message if failed
   * @param {Object} context - Additional context about the connection attempt
   * @param {Array} context.fieldGroups - Array of {cloudFieldId, datacenterFieldName, assets}
   * @param {Object} context.cloudObject - Cloud object details {id, objectKey, label}
   * @param {Object} context.dcObject - Datacenter object details {objectKey, label}
   */
  logConnection(ticketKey, objectId, success, error = null, context = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      ticketKey,
      objectId,
      success,
      error: error ? error.message || String(error) : null,
    };

    // Add detailed field context if provided
    if (context.fieldGroups && context.fieldGroups.length > 0) {
      logEntry.customFields = context.fieldGroups.map((fg) => ({
        cloudFieldId: fg.cloudFieldId,
        datacenterFieldName: fg.datacenterFieldName || "unknown",
        assetCount: fg.assets ? fg.assets.length : 0,
        assetIds: fg.assets ? fg.assets.map((a) => a.objectId).slice(0, 5) : [], // First 5 asset IDs
      }));
    }

    // Add object context if provided
    if (context.cloudObject) {
      logEntry.cloudObjectKey =
        context.cloudObject.objectKey || context.cloudObject.id;
      logEntry.cloudObjectLabel = context.cloudObject.label;
    }

    if (context.dcObject) {
      logEntry.datacenterObjectKey = context.dcObject.objectKey;
      logEntry.datacenterObjectLabel = context.dcObject.label;
    }

    fs.appendFileSync(this.logFile, JSON.stringify(logEntry) + "\n");
  }

  /**
   * Load and cache cloud custom fields for automatic name-to-ID mapping
   *
   * @returns {Promise} - Completes when custom fields are loaded and cached
   *
   * AI INSTRUCTIONS:
   * - Fetches all cloud custom fields via Jira Platform API for automatic mapping
   * - Creates name-to-ID mapping cache for efficient field resolution
   * - Uses case-insensitive exact matching only (no fuzzy matching)
   * - Critical for connecting tickets to migrated assets via custom field updates
   * - Only loads once per migration run (cached after first load)
   * - Used by ticket-asset connection feature when enabled
   */
  async loadCloudCustomFields() {
    if (this.cloudCustomFieldsCache) {
      return; // Already loaded
    }

    console.log("    📋 Loading cloud custom field definitions...");

    try {
      const allFields = await this.fetchAllCustomFields();

      // CRITICAL FIX: Filter for ONLY CMDB Asset object fields to avoid conflicts
      // with non-CMDB fields that have the same name
      const cmdbFields = allFields.filter((field) => {
        const isCMDBField =
          field.schema?.custom ===
          "com.atlassian.jira.plugins.cmdb:cmdb-object-cftype";
        return isCMDBField;
      });

      this.cloudCustomFieldsCache = cmdbFields;

      // Build name-to-ID mapping from CMDB fields only
      this.cloudCustomFieldsByName.clear();
      cmdbFields.forEach((field) => {
        // Store both exact name and lowercase normalized version for case-insensitive matching
        this.cloudCustomFieldsByName.set(field.name, field.id);
        this.cloudCustomFieldsByName.set(
          field.name.toLowerCase().trim(),
          field.id,
        );
      });

      console.log(
        `    ✅ Loaded ${cmdbFields.length} CMDB Asset custom field definitions (filtered from ${allFields.length} total)`,
      );
    } catch (error) {
      console.error(
        "    ❌ Failed to load cloud custom fields:",
        error.message,
      );
      throw new Error(`Failed to load cloud custom fields: ${error.message}`);
    }
  }

  /**
   * Fetch all custom fields from Jira Platform API using field search endpoint
   *
   * @returns {Array} - Array of custom field objects with id, name, and schema
   *
   * AI INSTRUCTIONS:
   * - Uses Jira Platform API /rest/api/3/field/search to get all custom fields
   * - Filters for custom type fields only using type=custom parameter
   * - Returns field definitions needed for automatic datacenter→cloud field mapping
   * - Used by loadCloudCustomFields() for building name-to-ID mapping cache
   * - Critical for automatic ticket-asset connections without manual field mapping
   */
  async fetchAllCustomFields() {
    const fields = [];
    let startAt = 0;
    const maxResults = 100; // Use larger page size for efficiency
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await this.makeJiraApiRequest(
          "GET",
          `/rest/api/3/field/search?type=custom&startAt=${startAt}&maxResults=${maxResults}&expand=key`,
        );

        if (response.values && Array.isArray(response.values)) {
          fields.push(
            ...response.values.map((field) => ({
              id: field.id || field.key,
              name: field.name,
              description: field.description || "",
              schema: field.schema,
              key: field.key,
            })),
          );

          // Check if we have more results
          hasMore = !response.isLast && response.values.length === maxResults;
          startAt += maxResults;
        } else {
          hasMore = false;
        }
      } catch (error) {
        // Fallback to older API if v3 fails
        console.log("    ℹ️  Trying fallback API for custom fields...");
        try {
          const fallbackResponse = await this.makeJiraApiRequest(
            "GET",
            "/rest/api/2/field",
          );
          const customFields = fallbackResponse.filter((field) => field.custom);
          return customFields.map((field) => ({
            id: field.id,
            name: field.name,
            description: field.description || "",
            schema: field.schema,
            key: field.id,
          }));
        } catch (fallbackError) {
          throw error; // Throw original error if fallback also fails
        }
      }
    }

    return fields;
  }

  /**
   * Search for a specific custom field by name using the field search API
   *
   * ONLY returns fields that are CMDB Asset object fields (schema.custom: cmdb-object-cftype)
   * Uses case-insensitive exact matching. If multiple exact matches exist, uses the first one.
   *
   * @param {string} fieldName - The name of the field to search for
   * @returns {Object|null} - Field object with id and name, or null if not found
   */
  async searchCustomFieldByName(fieldName) {
    try {
      console.log(
        `      🔍 Searching for custom field: "${fieldName}" (CMDB Asset type only)`,
      );

      const encodedQuery = encodeURIComponent(fieldName);
      const response = await this.makeJiraApiRequest(
        "GET",
        `/rest/api/3/field/search?type=custom&query=${encodedQuery}&maxResults=50&expand=key`,
      );

      if (!response.values || !Array.isArray(response.values)) {
        console.log(`      ❌ No fields found matching: "${fieldName}"`);
        return null;
      }

      // Filter for ONLY CMDB Asset object fields
      const cmdbAssetFields = response.values.filter((field) => {
        // Ensure it's a CMDB object field type
        const isCMDBField =
          field.schema?.custom ===
          "com.atlassian.jira.plugins.cmdb:cmdb-object-cftype";

        // Also verify it's a custom field (additional safety check)
        const isCustomField = field.custom === true || field.schema?.custom;

        return isCMDBField && isCustomField;
      });

      // If none found, return null
      if (cmdbAssetFields.length === 0) {
        console.log(
          `      ❌ No CMDB Asset field found matching: "${fieldName}"`,
        );
        return null;
      }

      // If multiple CMDB Asset fields found, prioritize exact matches
      if (cmdbAssetFields.length > 1) {
        // Look for exact matches first (case-insensitive)
        const exactMatches = cmdbAssetFields.filter(
          (field) => field.name.toLowerCase() === fieldName.toLowerCase(),
        );

        if (exactMatches.length >= 1) {
          // Found exact match(es) - use the first one
          const field = exactMatches[0];

          if (exactMatches.length > 1) {
            // Multiple exact matches - log warning but use first one
            const names = exactMatches
              .map((f) => `"${f.name}" (${f.id})`)
              .join(", ");
            console.log(
              `      ⚠️  Multiple exact matches found for "${fieldName}": [${names}]`,
            );
            console.log(
              `      ℹ️  Using first match: "${field.name}" (${field.id})`,
            );
          } else {
            console.log(
              `      ✅ Found exact CMDB Asset field match: "${field.name}" (${field.id})`,
            );
          }

          return {
            id: field.id || field.key,
            name: field.name,
            description: field.description || "",
            schema: field.schema,
          };
        }

        // No exact matches, but multiple partial matches found by API
        // Just use the first one
        const field = cmdbAssetFields[0];
        const names = cmdbAssetFields
          .map((f) => `"${f.name}" (${f.id})`)
          .join(", ");
        console.log(
          `      ⚠️  Multiple partial matches found for "${fieldName}": [${names}]`,
        );
        console.log(
          `      ℹ️  Using first match: "${field.name}" (${field.id})`,
        );

        return {
          id: field.id || field.key,
          name: field.name,
          description: field.description || "",
          schema: field.schema,
        };
      }

      // Exactly one match — success!
      const field = cmdbAssetFields[0];
      console.log(
        `      ✅ Found CMDB Asset field: "${field.name}" (${field.id})`,
      );

      return {
        id: field.id || field.key,
        name: field.name,
        description: field.description || "",
        schema: field.schema,
      };
    } catch (error) {
      console.log(
        `      ⚠️  Error searching for field "${fieldName}": ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get cloud custom field ID by name (with live search fallback)
   * Uses case-insensitive exact matching with field type verification
   */
  async getCloudFieldIdByName(fieldName) {
    // First try the cached fields
    if (this.cloudCustomFieldsByName.has(fieldName)) {
      return this.cloudCustomFieldsByName.get(fieldName);
    }

    // Try case-insensitive exact match in cache
    const normalized = fieldName.toLowerCase().trim();
    if (this.cloudCustomFieldsByName.has(normalized)) {
      return this.cloudCustomFieldsByName.get(normalized);
    }

    // Check for exact match (case-insensitive) in cache
    for (const [name, id] of this.cloudCustomFieldsByName.entries()) {
      if (name.toLowerCase() === normalized) {
        console.log(
          `      ℹ️  Found exact match in cache: "${fieldName}" → "${name}" (${id})`,
        );
        return id;
      }
    }

    // No cache hit - search Jira API for exact match with field type verification
    console.log(`      🔍 Searching Jira API for exact match: "${fieldName}"`);
    const searchResult = await this.searchCustomFieldByName(fieldName);

    if (searchResult) {
      // Add to cache for future use
      this.cloudCustomFieldsByName.set(fieldName, searchResult.id);
      this.cloudCustomFieldsByName.set(normalized, searchResult.id);
      console.log(
        `      ✅ Found and cached: "${fieldName}" → "${searchResult.name}" (${searchResult.id})`,
      );
      return searchResult.id;
    }

    return null;
  }

  /**
   * Connect tickets to a migrated object
   * @param {Object} dcObject - Original datacenter object with connectedTickets array
   * @param {Object} cloudObject - Newly created cloud object
   * @returns {Object} Results of ticket connection attempts
   */
  async connectTicketsToObject(dcObject, cloudObject) {
    if (!this.config.enabled) {
      console.log("    ⏭️  Ticket connection disabled by configuration");
      return { skipped: true, reason: "disabled" };
    }

    if (!dcObject.connectedTickets || dcObject.connectedTickets.length === 0) {
      return { skipped: true, reason: "no_tickets" };
    }

    // Ensure cloud custom fields are loaded
    await this.loadCloudCustomFields();

    console.log(
      `\n    🎫 Connecting ${dcObject.connectedTickets.length} ticket(s) to object:`,
    );
    console.log(
      `       Datacenter: ${dcObject.objectKey} → Cloud: ${cloudObject.objectKey} (ID: ${cloudObject.id})`,
    );

    const results = {
      objectId: cloudObject.id,
      objectKey: cloudObject.label,
      tickets: [],
      summary: {
        total: dcObject.connectedTickets.length,
        successful: 0,
        failed: 0,
        skipped: 0,
      },
    };

    // Process all tickets - no artificial limits
    const ticketsToProcess = dcObject.connectedTickets;

    if (this.config.parallelUpdates) {
      // Process tickets in parallel with worker limit
      const chunks = this.chunkArray(
        ticketsToProcess,
        this.config.updateWorkers,
      );
      for (const chunk of chunks) {
        const chunkResults = await Promise.all(
          chunk.map((ticket) =>
            this.updateTicketWithObject(ticket, cloudObject),
          ),
        );
        results.tickets.push(...chunkResults);
      }
    } else {
      // Process tickets sequentially
      for (const ticket of ticketsToProcess) {
        const result = await this.updateTicketWithObject(ticket, cloudObject);
        results.tickets.push(result);

        // Add delay between updates
        if (this.config.updateDelay > 0) {
          await this.sleep(this.config.updateDelay);
        }
      }
    }

    // Update summary
    results.tickets.forEach((result) => {
      if (result.success) {
        results.summary.successful++;
      } else if (result.skipped) {
        results.summary.skipped++;
      } else {
        results.summary.failed++;
      }
    });

    // Update global stats
    this.stats.totalTicketsProcessed += results.summary.total;
    this.stats.successfulUpdates += results.summary.successful;
    this.stats.failedUpdates += results.summary.failed;
    this.stats.skippedTickets += results.summary.skipped;

    // Log summary
    console.log(
      `    ✅ Ticket connections: ${results.summary.successful}/${results.summary.total} successful`,
    );
    if (results.summary.failed > 0) {
      console.log(`    ⚠️  Failed connections: ${results.summary.failed}`);
    }

    return results;
  }

  /**
   * Extract all custom field assets for a ticket, grouped by cloudFieldId
   *
   * Returns an array of { cloudFieldId, assets[] } for each field the ticket references
   * Each entry represents one custom field on the ticket with multiple asset values
   */
  async extractAllFieldAssets(ticketInfo) {
    if (
      !ticketInfo.customFieldsContainingObject ||
      ticketInfo.customFieldsContainingObject.length === 0
    ) {
      return [];
    }

    // Load created objects mapping for resolving datacenter keys to cloud IDs
    this.loadCreatedObjectsMapping();

    // Group by cloudFieldId (we'll resolve this from datacenterFieldName)
    const fieldGroups = new Map();

    for (const customField of ticketInfo.customFieldsContainingObject) {
      // Get the field name to map to cloud
      const datacenterFieldName =
        customField.datacenterFieldName || customField.fieldName;
      if (!datacenterFieldName) continue;

      // Resolve cloud field ID
      const cloudFieldId =
        await this.getCloudFieldIdByName(datacenterFieldName);
      if (!cloudFieldId) {
        console.log(
          `      ⚠️  Could not resolve cloud field for "${datacenterFieldName}" in ticket ${ticketInfo.key}`,
        );
        continue;
      }

      // The customField contains an array of field values, each with format "Object Name (OBJECT-KEY)"
      const fieldValues = Array.isArray(customField.fieldValue)
        ? customField.fieldValue
        : [customField.fieldValue];

      // Group by field ID (initialize if needed)
      if (!fieldGroups.has(cloudFieldId)) {
        fieldGroups.set(cloudFieldId, {
          cloudFieldId,
          datacenterFieldName,
          assets: [],
        });
      }

      // Process each field value to extract object keys and resolve cloud IDs
      for (const fieldValue of fieldValues) {
        const objectKeyMatch = fieldValue?.match(/\(([^)]+)\)$/);
        const datacenterObjectKey = objectKeyMatch ? objectKeyMatch[1] : null;

        if (!datacenterObjectKey) {
          console.log(
            `      ⚠️  Could not extract datacenter key from fieldValue: "${fieldValue}" in ticket ${ticketInfo.key}`,
          );
          continue;
        }

        // Resolve cloud object ID using the created objects mapping
        let cloudObjectMeta =
          this.createdObjectsMapping.get(datacenterObjectKey);
        if (!cloudObjectMeta) {
          // Try alternative lookups
          const objectName = fieldValue?.replace(/\s*\([^)]+\)\s*$/, "").trim();
          cloudObjectMeta = this.createdObjectsMapping.get(
            `name:${objectName}`,
          );
        }

        if (!cloudObjectMeta) {
          console.log(
            `      ⚠️  Could not resolve cloud object ID for datacenter key: "${datacenterObjectKey}", fieldValue: "${fieldValue}" in ticket ${ticketInfo.key}`,
          );
          continue; // Skip this reference
        }

        const objectId = cloudObjectMeta.cloudId;
        const globalId = `${this.workspaceId}:${objectId}`;
        const assetRef = {
          workspaceId: this.workspaceId,
          id: globalId,
          objectId: objectId,
        };

        // Add asset to group (avoid duplicates)
        const existing = fieldGroups
          .get(cloudFieldId)
          .assets.find((a) => a.id === assetRef.id);
        if (!existing) {
          fieldGroups.get(cloudFieldId).assets.push(assetRef);
        }
      }
    }

    return Array.from(fieldGroups.values());
  }

  /**
   * Update a single ticket with ALL object references in one call
   */
  async updateTicketWithObject(ticketInfo, cloudObject) {
    // Handle both string ticket keys and ticket objects
    const ticketKey =
      typeof ticketInfo === "string" ? ticketInfo : ticketInfo.key;
    const ticketData =
      typeof ticketInfo === "string" ? { key: ticketInfo } : ticketInfo;

    const result = {
      ticketKey: ticketKey,
      success: false,
      skipped: false,
      error: null,
    };

    try {
      // Get ALL field-grouped assets for this ticket
      const fieldGroups = await this.extractAllFieldAssets(ticketData);

      if (fieldGroups.length === 0) {
        console.log(
          `      ⚠️  Skipping ticket ${ticketKey} - No valid custom field references found`,
        );
        result.skipped = true;
        result.error = "No valid custom field references found";
        return result;
      }

      // FIX: Update each field SEPARATELY to avoid combined failures
      // When fields are batched together, if ONE field rejects, the ENTIRE request fails
      // and we can't tell which specific field caused the issue (e.g., customfield_10447 + customfield_10913)
      let totalSuccessfulFields = 0;
      let totalFailedFields = 0;
      const fieldResults = [];

      for (const fieldGroup of fieldGroups) {
        const { cloudFieldId, cloudFieldName, assets } = fieldGroup;

        if (assets.length === 0) {
          console.log(
            `      ⚠️  Skipping field ${cloudFieldId} - no valid assets`,
          );
          continue;
        }

        // JIRA ASSETS LIMIT: Maximum 20 assets per custom field
        let assetsToUpdate = assets;
        if (assets.length > 20) {
          // Sort by objectId (numeric) DESC to get most recent 20
          const sortedAssets = [...assets].sort((a, b) => {
            const aId = parseInt(a.objectId) || 0;
            const bId = parseInt(b.objectId) || 0;
            return bId - aId; // DESC: highest (most recent) first
          });

          assetsToUpdate = sortedAssets.slice(0, 20);
          const excludedAssets = sortedAssets.slice(20);

          console.log(
            `      ⚠️  Field ${cloudFieldId}: LIMITING ${assets.length} assets to 20 most recent (Jira limit)`,
          );
          console.log(
            `      📊 Including assets (IDs): ${assetsToUpdate.map((a) => a.objectId).join(", ")}`,
          );
          console.log(
            `      🚫 Excluding ${excludedAssets.length} assets (IDs): ${excludedAssets.map((a) => a.objectId).join(", ")}`,
          );
        }

        // Create SEPARATE payload for THIS field only
        const fieldPayload = {
          update: {
            [cloudFieldId]: [
              {
                set: assetsToUpdate.map((asset) => {
                  // Correct structure for Jira Assets custom field updates
                  return {
                    workspaceId: asset.workspaceId,
                    id: asset.id, // This is the globalId (workspaceId:objectId)
                    objectId: asset.objectId,
                  };
                }),
              },
            ],
          },
        };

        // Debug: Log field-by-field asset counts and individual assets
        if (process.env.DEBUG_TICKET_CONNECTIONS === "true") {
          console.log(
            `      📋 Field ${cloudFieldId}: ${assetsToUpdate.length} asset(s) to connect`,
          );
          assets.forEach((asset, index) => {
            console.log(
              `        🐛 Asset ${index + 1}: workspaceId="${asset.workspaceId}", id="${asset.id}", objectId="${asset.objectId}"`,
            );
          });
        }

        // Make SEPARATE API call for THIS field only
        this.logger(
          `      🔧 Updating ticket ${ticketKey} field ${cloudFieldId} (${cloudFieldName || "Unknown"}) with ${assetsToUpdate.length} asset(s)`,
        );

        // Debug: Log the exact payload being sent
        if (process.env.DEBUG_TICKET_CONNECTIONS === "true") {
          console.log(
            `      🐛 DEBUG - Payload for ${ticketKey} field ${cloudFieldId}:`,
            JSON.stringify(fieldPayload, null, 2),
          );
        }

        const updateResult = await this.updateJiraIssue(
          ticketKey,
          fieldPayload,
        );

        if (updateResult.success) {
          this.logger(
            `      ✅ Successfully updated ticket ${ticketKey} field ${cloudFieldId}`,
          );
          // Log success for THIS field
          this.logConnection(ticketKey, cloudObject.id, true, null, {
            fieldGroups: [fieldGroup],
            cloudObject,
            dcObject: { objectKey: ticketKey, label: ticketKey },
          });
          totalSuccessfulFields++;
          fieldResults.push({ fieldId: cloudFieldId, success: true });
        } else {
          // Build detailed error message with context for THIS field
          let detailedError = `Field ${cloudFieldId}: ${updateResult.error}`;

          // Add field and asset details to error message
          detailedError += `\n      📋 Context:`;
          detailedError += `\n         Ticket: ${ticketKey}`;
          detailedError += `\n         Asset Object: ${cloudObject.objectKey} (ID: ${cloudObject.id})`;
          detailedError += `\n         Fields being updated: 1`;

          const assetIds = assetsToUpdate.map((a) => a.objectId).join(", ");
          detailedError += `\n         - Field ID: ${cloudFieldId} (${cloudFieldName || "Unknown"})`;
          detailedError += `\n           Asset IDs: [${assetIds}] (${assetsToUpdate.length} asset(s))`;

          console.log(`      ❌ Failed to update ticket ${ticketKey}:`);
          console.log(detailedError);

          this.logConnection(ticketKey, cloudObject.id, false, detailedError, {
            fieldGroups: [fieldGroup],
            cloudObject,
            dcObject: { objectKey: ticketKey, label: ticketKey },
          });
          totalFailedFields++;
          fieldResults.push({
            fieldId: cloudFieldId,
            success: false,
            error: detailedError,
            isRateLimit: updateResult.isRateLimit,
          });

          // If rate limited on this field, propagate it immediately
          if (updateResult.isRateLimit) {
            result.isRateLimit = true;
          }
        }
      }

      // Check if we processed any fields
      if (fieldResults.length === 0) {
        console.log(
          `      ⚠️  Skipping ticket ${ticketKey} - No valid fields to update after processing`,
        );
        result.skipped = true;
        result.error = "No valid fields to update after processing";
        return result;
      }

      // Determine overall success based on field results
      if (totalSuccessfulFields > 0 && totalFailedFields === 0) {
        // ALL fields succeeded (already logged per-field above)
        this.logger(
          `      ✅ Successfully updated ticket ${ticketKey} with ${totalSuccessfulFields} field(s)`,
        );
        result.success = true;
      } else if (totalSuccessfulFields > 0 && totalFailedFields > 0) {
        // PARTIAL success - some fields succeeded, some failed
        const partialError = `Partial success: ${totalSuccessfulFields} field(s) succeeded, ${totalFailedFields} field(s) failed`;
        console.log(`      ⚠️  ${partialError}`);
        result.error = partialError;
        result.success = false; // Consider partial success as failure for retry purposes
        result.fieldResults = fieldResults;
      } else {
        // ALL fields failed
        const allFailedError = `All ${totalFailedFields} field(s) failed to update`;
        result.error = allFailedError;
        result.success = false;
        result.fieldResults = fieldResults;
      }

      return result;
    } catch (error) {
      // Build detailed error message with context
      let detailedError = `${error.message}`;
      detailedError += `\n      📋 Context:`;
      detailedError += `\n         Ticket: ${ticketKey}`;
      detailedError += `\n         Asset Object: ${cloudObject.objectKey} (ID: ${cloudObject.id})`;

      // Try to get fieldGroups if available (may fail if error occurred early)
      let fieldGroups = [];
      try {
        fieldGroups = await this.extractAllFieldAssets(ticketData);

        if (fieldGroups.length > 0) {
          detailedError += `\n         Fields attempted: ${fieldGroups.length}`;
          for (const fieldGroup of fieldGroups) {
            const assetIds =
              fieldGroup.assets?.map((a) => a.objectId).join(", ") || "none";
            detailedError += `\n         - Field ID: ${fieldGroup.cloudFieldId} (${fieldGroup.cloudFieldName || "Unknown"})`;
            detailedError += `\n           Asset IDs: [${assetIds}] (${fieldGroup.assets?.length || 0} asset(s))`;
          }
        }
      } catch (extractError) {
        detailedError += `\n         (Could not extract field details: ${extractError.message})`;
      }

      result.error = detailedError;
      console.log(`      ❌ Error updating ${ticketKey}:`);
      console.log(detailedError);

      this.logConnection(ticketKey, cloudObject.id, false, detailedError, {
        fieldGroups,
        cloudObject,
        dcObject: { objectKey: ticketKey, label: ticketKey },
      });

      if (!this.stats.errors.find((e) => e.message === error.message)) {
        this.stats.errors.push({
          message: detailedError,
          ticketKey: ticketKey,
          timestamp: new Date().toISOString(),
        });
      }

      return result;
    }
  }

  /**
   * Update a Jira issue via REST API with screen fallback strategy
   * Smart rate limit handling: 1s wait, then 5s wait before failing
   */
  async updateJiraIssue(issueKey, payload) {
    const maxRetries = this.config.maxRetries;
    let lastError = null;
    let rateLimitRetries = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.makeJiraApiRequest(
          "PUT",
          `/rest/api/3/issue/${issueKey}`,
          payload,
        );

        return { success: true, data: result };
      } catch (error) {
        lastError = error;

        // Check for screen configuration errors
        if (this.isScreenConfigurationError(error)) {
          console.log(
            `      🔧 Screen configuration error detected for ${issueKey}. Attempting fallback...`,
          );

          const fallbackResult = await this.handleScreenConfigurationFallback(
            issueKey,
            payload,
            error,
          );
          if (fallbackResult.success) {
            console.log(
              `      ✅ Screen configuration fallback successful for ${issueKey}`,
            );
            return fallbackResult;
          } else {
            console.log(
              `      ❌ Screen configuration fallback failed for ${issueKey}: ${fallbackResult.error}`,
            );
          }
        }

        // SMART RATE LIMIT HANDLING: Check if it's a rate limit error
        if (this.isRateLimitError(error)) {
          rateLimitRetries++;

          if (rateLimitRetries === 1) {
            // First rate limit hit: wait 5s and retry
            console.log(
              `      ⏳ Rate limit detected - waiting 5s before retry...`,
            );
            await this.sleep(5000);
            attempt--; // Don't count this as a regular retry
            continue;
          } else if (rateLimitRetries === 2) {
            // Second rate limit hit: wait 10s and retry ONE MORE TIME
            console.log(
              `      ⏳ Rate limit again - waiting 10s before final retry...`,
            );
            await this.sleep(10000);
            attempt--; // Don't count this as a regular retry, allow one more attempt
            continue;
          } else {
            // Third rate limit hit (or more): Give up and reduce worker
            console.log(
              `      ❌ Rate limit persists after retries - failing request`,
            );
            error.isRateLimit = true;
            lastError = error;
            break;
          }
        }

        // Check if it's a retryable error (but not rate limit - handled above)
        if (
          this.isRetryableError(error) &&
          !this.isRateLimitError(error) &&
          attempt < maxRetries
        ) {
          const delay = this.config.retryDelay * Math.pow(2, attempt - 1);
          console.log(
            `        🔄 Retrying in ${delay}ms... (attempt ${attempt}/${maxRetries})`,
          );
          await this.sleep(delay);
        } else {
          break;
        }
      }
    }

    return {
      success: false,
      error: lastError.message || "Unknown error",
      isRateLimit: lastError.isRateLimit,
    };
  }

  /**
   * Check if an error is a rate limit error
   */
  isRateLimitError(error) {
    if (!error) return false;

    const errorMsg = (error.message || error.toString()).toLowerCase();
    const rateLimitIndicators = [
      "429",
      "rate limit",
      "too many requests",
      "timeout",
      "econnreset",
      "econnrefused",
      "socket hang up",
    ];

    return rateLimitIndicators.some((indicator) =>
      errorMsg.includes(indicator),
    );
  }

  /**
   * Check if an error is a screen configuration error
   */
  isScreenConfigurationError(error) {
    if (!error.message) return false;

    // Common patterns for screen configuration errors
    const screenErrorPatterns = [
      "cannot be set. It is not on the appropriate screen",
      "is not on the appropriate screen",
      "field is not on the screen",
      "not on the appropriate screen",
      "an error occurred", // Jira's useless generic error - often means screen config issue
    ];

    const errorMessage = error.message.toLowerCase();
    return screenErrorPatterns.some((pattern) =>
      errorMessage.includes(pattern),
    );
  }

  /**
   * Handle screen configuration fallback strategy
   * Complete flow: Issue → Project → Issue Type Screen Scheme → Screen Scheme → Screens → Tabs → Add Field
   */
  async handleScreenConfigurationFallback(issueKey, payload, originalError) {
    try {
      // Extract field ID from error message
      const fieldIdMatch = originalError.message.match(/customfield_\d+/);
      if (!fieldIdMatch) {
        return {
          success: false,
          error: "Could not extract field ID from error message",
        };
      }

      const fieldId = fieldIdMatch[0];
      console.log(`      🔍 Detected missing field on screen: ${fieldId}`);

      // Step 1: Get issue details (project + issue type)
      const issueData = await this.getIssueDetails(issueKey);
      if (!issueData) {
        return { success: false, error: "Could not retrieve issue details" };
      }

      const projectId = issueData.fields?.project?.id;
      const projectKey = issueData.fields?.project?.key;
      const issueTypeId = issueData.fields?.issuetype?.id;

      if (!projectId || !issueTypeId) {
        return {
          success: false,
          error: "Could not determine project ID or issue type ID",
        };
      }

      console.log(
        `      📋 Project: ${projectKey} (${projectId}), Issue Type: ${issueTypeId}`,
      );

      // Step 2: Find the issue type screen scheme for this project
      console.log(
        `      🔍 Finding issue type screen scheme for project ${projectId}...`,
      );
      const issueTypeScreenScheme =
        await this.getIssueTypeScreenSchemeForProject(projectId);
      if (!issueTypeScreenScheme) {
        console.log(
          `      ⚠️  Could not find issue type screen scheme, trying default screens fallback...`,
        );
        const defaultResult = await this.addFieldToDefaultScreens(fieldId);
        if (defaultResult.success) {
          console.log(
            `      ✅ Added field to default screens, retrying ticket update...`,
          );
          const retryResult = await this.retryTicketUpdateSafely(
            issueKey,
            payload,
          );
          return retryResult;
        } else {
          return defaultResult;
        }
      }

      console.log(
        `      📋 Issue Type Screen Scheme: ${issueTypeScreenScheme.name} (${issueTypeScreenScheme.id})`,
      );

      // Step 3: Get the screen scheme mapping for this issue type
      console.log(
        `      🔍 Finding screen scheme for issue type ${issueTypeId}...`,
      );
      const screenSchemeId = await this.getScreenSchemeForIssueType(
        issueTypeScreenScheme.id,
        issueTypeId,
      );
      if (!screenSchemeId) {
        console.log(
          `      ⚠️  Could not find screen scheme for issue type, trying default screens fallback...`,
        );
        const defaultResult = await this.addFieldToDefaultScreens(fieldId);
        if (defaultResult.success) {
          console.log(
            `      ✅ Added field to default screens, retrying ticket update...`,
          );
          const retryResult = await this.retryTicketUpdateSafely(
            issueKey,
            payload,
          );
          return retryResult;
        } else {
          return defaultResult;
        }
      }

      console.log(`      📋 Screen Scheme ID: ${screenSchemeId}`);

      // Step 4: Get the actual screens from the screen scheme (create, edit, view)
      console.log(
        `      🔍 Getting screens from screen scheme ${screenSchemeId}...`,
      );
      const screens = await this.getScreensFromScreenScheme(screenSchemeId);
      if (!screens || Object.keys(screens).length === 0) {
        console.log(
          `      ⚠️  Could not find screens in screen scheme, trying default screens fallback...`,
        );
        const defaultResult = await this.addFieldToDefaultScreens(fieldId);
        if (defaultResult.success) {
          console.log(
            `      ✅ Added field to default screens, retrying ticket update...`,
          );
          const retryResult = await this.retryTicketUpdateSafely(
            issueKey,
            payload,
          );
          return retryResult;
        } else {
          return defaultResult;
        }
      }

      console.log(
        `      📋 Found screens:`,
        Object.entries(screens)
          .map(([op, id]) => `${op}=${id}`)
          .join(", "),
      );

      // Step 5: Add field to ALL screens used by this project + issue type combination
      // This ensures the field is available everywhere (create, edit, view screens)
      // Edit screen is most critical for ticket updates, but adding to all for consistency
      let addedToAnyScreen = false;
      for (const [operation, screenId] of Object.entries(screens)) {
        if (screenId) {
          console.log(
            `      🔧 Adding field ${fieldId} to ${operation} screen ${screenId} (all tabs)...`,
          );
          const result = await this.addFieldToAllScreenTabs(screenId, fieldId);
          if (result.success) {
            console.log(
              `      ✅ Successfully added field to ${operation} screen`,
            );
            addedToAnyScreen = true;
          } else {
            console.log(
              `      ⚠️  Failed to add field to ${operation} screen: ${result.error}`,
            );
          }
        }
      }

      if (addedToAnyScreen) {
        console.log(
          `      ✅ Field added to screens, retrying ticket update...`,
        );
        // Retry the original update - but first get current issue data to avoid required field issues
        const retryResult = await this.retryTicketUpdateSafely(
          issueKey,
          payload,
        );
        return retryResult;
      } else {
        return { success: false, error: "Failed to add field to any screens" };
      }
    } catch (error) {
      console.log(
        `      ❌ Screen configuration fallback error: ${error.message}`,
      );
      return {
        success: false,
        error: `Screen configuration fallback failed: ${error.message}`,
      };
    }
  }

  /**
   * Get issue details including issue type and project
   */
  async getIssueDetails(issueKey) {
    try {
      return await this.makeJiraApiRequest(
        "GET",
        `/rest/api/3/issue/${issueKey}?fields=issuetype,project`,
      );
    } catch (error) {
      console.log(
        `      ⚠️ Failed to get issue details for ${issueKey}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get the issue type screen scheme for a project
   */
  async getIssueTypeScreenSchemeForProject(projectId) {
    try {
      const response = await this.makeJiraApiRequest(
        "GET",
        `/rest/api/3/issuetypescreenscheme/project?projectId=${projectId}`,
      );
      if (response.values && response.values.length > 0) {
        // Return the first (and usually only) issue type screen scheme for this project
        return response.values[0].issueTypeScreenScheme;
      }
      return null;
    } catch (error) {
      console.log(
        `      ⚠️ Failed to get issue type screen scheme for project ${projectId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get the screen scheme ID for a specific issue type in an issue type screen scheme
   */
  async getScreenSchemeForIssueType(issueTypeScreenSchemeId, issueTypeId) {
    try {
      const response = await this.makeJiraApiRequest(
        "GET",
        `/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${issueTypeScreenSchemeId}`,
      );

      if (response.values && response.values.length > 0) {
        // Look for specific issue type mapping first
        const specificMapping = response.values.find(
          (mapping) => mapping.issueTypeId === issueTypeId,
        );
        if (specificMapping) {
          return specificMapping.screenSchemeId;
        }

        // Fall back to default mapping if no specific one found
        const defaultMapping = response.values.find(
          (mapping) => mapping.issueTypeId === "default",
        );
        if (defaultMapping) {
          return defaultMapping.screenSchemeId;
        }
      }

      return null;
    } catch (error) {
      console.log(
        `      ⚠️ Failed to get screen scheme for issue type ${issueTypeId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get the actual screen IDs from a screen scheme
   */
  async getScreensFromScreenScheme(screenSchemeId) {
    try {
      const response = await this.makeJiraApiRequest(
        "GET",
        `/rest/api/3/screenscheme?id=${screenSchemeId}`,
      );

      if (response.values && response.values.length > 0) {
        const screenScheme = response.values[0];
        return screenScheme.screens || {};
      }

      return null;
    } catch (error) {
      console.log(
        `      ⚠️ Failed to get screens from screen scheme ${screenSchemeId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Add field to all tabs of a specific screen
   */
  async addFieldToAllScreenTabs(screenId, fieldId) {
    try {
      // Get all tabs for this screen
      const tabsResponse = await this.makeJiraApiRequest(
        "GET",
        `/rest/api/3/screens/${screenId}/tabs`,
      );

      if (!tabsResponse || !Array.isArray(tabsResponse)) {
        return { success: false, error: "No tabs found for screen" };
      }

      let addedToAnyTab = false;
      const errors = [];

      // Add field to each tab
      for (const tab of tabsResponse) {
        try {
          await this.makeJiraApiRequest(
            "POST",
            `/rest/api/3/screens/${screenId}/tabs/${tab.id}/fields`,
            {
              fieldId: fieldId,
            },
          );
          console.log(
            `        ✅ Added field ${fieldId} to tab "${tab.name}" (${tab.id})`,
          );
          addedToAnyTab = true;
        } catch (tabError) {
          const errorMsg = `Failed to add field to tab "${tab.name}": ${tabError.message}`;
          console.log(`        ⚠️ ${errorMsg}`);
          errors.push(errorMsg);
        }
      }

      if (addedToAnyTab) {
        return { success: true };
      } else {
        return {
          success: false,
          error: `Failed to add field to any tabs: ${errors.join("; ")}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to get tabs for screen ${screenId}: ${error.message}`,
      };
    }
  }

  /**
   * Retry ticket update safely by using update operations only (not full field replacement)
   */
  async retryTicketUpdateSafely(issueKey, originalPayload) {
    try {
      // Use update operations which are safer than field replacement
      // This avoids "required field" issues by only updating specific fields
      const safePayload = {
        update: originalPayload.update || {},
      };

      console.log(`      🔄 Safely retrying ticket update for ${issueKey}...`);
      const retryResult = await this.makeJiraApiRequest(
        "PUT",
        `/rest/api/3/issue/${issueKey}`,
        safePayload,
      );
      return { success: true, data: retryResult };
    } catch (error) {
      console.log(
        `      ❌ Safe retry failed for ${issueKey}: ${error.message}`,
      );
      return { success: false, error: `Safe retry failed: ${error.message}` };
    }
  }

  /**
   * Add field to default screens (fallback approach)
   */
  async addFieldToDefaultScreens(fieldId) {
    try {
      await this.makeJiraApiRequest(
        "POST",
        `/rest/api/3/screens/addToDefault/${fieldId}`,
      );
      return { success: true };
    } catch (error) {
      console.log(
        `      ⚠️ Failed to add field ${fieldId} to default screens: ${error.message}`,
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Make a request to Jira REST API (not Assets API)
   */
  async makeJiraApiRequest(method, endpoint, data = null) {
    return new Promise((resolve, reject) => {
      const payload = data ? JSON.stringify(data) : null;

      const options = {
        hostname: this.baseUrl.replace("https://", "").replace("http://", ""),
        port: 443,
        path: endpoint,
        method: method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      };

      if (payload) {
        options.headers["Content-Length"] = Buffer.byteLength(payload);
      }

      // DEBUG: Log which API token is being used (first 20 chars)
      if (this.logger) {
        this.logger(
          `      🔐 HTTP Request using token: ${this.apiToken.substring(0, 25)}...`,
        );
      }

      const req = https.request(options, (res) => {
        let responseData = "";

        res.on("data", (chunk) => {
          responseData += chunk;
        });

        res.on("end", () => {
          // Success responses (2xx)
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (responseData) {
              try {
                resolve(JSON.parse(responseData));
              } catch (e) {
                resolve(responseData);
              }
            } else {
              resolve({ success: true });
            }
          } else {
            // Error responses - build detailed error message
            let errorMessage = `HTTP ${res.statusCode}`;
            let errorDetails = null;

            try {
              const errorData = JSON.parse(responseData);
              errorDetails = errorData; // Store full error data

              if (
                errorData.errorMessages &&
                errorData.errorMessages.length > 0
              ) {
                errorMessage = errorData.errorMessages.join(", ");
              } else if (errorData.errors) {
                // If errors is an object with field-specific errors, format them nicely
                const fieldErrors = [];
                for (const [field, fieldError] of Object.entries(
                  errorData.errors,
                )) {
                  fieldErrors.push(`Field ${field}: ${fieldError}`);
                }
                errorMessage = fieldErrors.join("; ");
              } else if (errorData.message) {
                errorMessage = errorData.message;
              }

              // Add any additional context from the error response
              if (
                errorData.warningMessages &&
                errorData.warningMessages.length > 0
              ) {
                errorMessage += ` [Warnings: ${errorData.warningMessages.join(", ")}]`;
              }

              // If we get a useless "An error occurred" message, include the full raw response
              if (
                errorMessage.includes("An error occurred") ||
                errorMessage === `HTTP ${res.statusCode}`
              ) {
                console.log(
                  `\n🔍 DEBUG: Jira returned useless error. Full API response:`,
                );
                console.log(JSON.stringify(errorData, null, 2));
                errorMessage += ` [RAW: ${JSON.stringify(errorData)}]`;
              }
            } catch (e) {
              errorMessage += `: ${responseData}`;
            }

            const error = new Error(errorMessage);
            error.statusCode = res.statusCode;
            error.response = responseData;
            error.errorDetails = errorDetails; // Attach parsed error details for later use
            reject(error);
          }
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error("Request timeout after 30 seconds"));
      });

      if (payload) {
        req.write(payload);
      }

      req.end();
    });
  }

  /**
   * Check if an error is retryable
   */
  isRetryableError(error) {
    if (!error.statusCode) return true; // Network errors are retryable

    // Retry on specific status codes
    const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
    return retryableStatusCodes.includes(error.statusCode);
  }

  /**
   * Split array into chunks
   */
  chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get statistics summary
   */
  getStatsSummary() {
    return {
      ...this.stats,
      successRate:
        this.stats.totalTicketsProcessed > 0
          ? (
              (this.stats.successfulUpdates /
                this.stats.totalTicketsProcessed) *
              100
            ).toFixed(2) + "%"
          : "0%",
    };
  }

  /**
   * Generate a report of all ticket connections
   */
  generateReport() {
    const reportPath = path.join(
      process.cwd(),
      "logs",
      "ticket_connection_report.json",
    );
    const report = {
      generatedAt: new Date().toISOString(),
      configuration: this.config,
      statistics: this.getStatsSummary(),
      errors: this.stats.errors,
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📊 Ticket connection report saved to: ${reportPath}`);

    return report;
  }

  /**
   * Process tickets for multiple objects in batch
   */
  async connectTicketsForBatch(objectPairs) {
    console.log(
      `\n🎫 Processing ticket connections for ${objectPairs.length} objects...`,
    );

    // Load cloud custom fields once for the entire batch
    await this.loadCloudCustomFields();

    const batchResults = [];
    let processedCount = 0;

    for (const { dcObject, cloudObject } of objectPairs) {
      processedCount++;

      if (dcObject.connectedTickets && dcObject.connectedTickets.length > 0) {
        console.log(
          `\n[${processedCount}/${objectPairs.length}] Processing ${dcObject.label || dcObject.objectKey}...`,
        );
        const result = await this.connectTicketsToObject(dcObject, cloudObject);
        batchResults.push(result);
      }
    }

    // Generate summary
    const summary = {
      totalObjects: objectPairs.length,
      objectsWithTickets: batchResults.filter(
        (r) => !r.skipped || r.reason !== "no_tickets",
      ).length,
      totalTicketsProcessed: this.stats.totalTicketsProcessed,
      successfulConnections: this.stats.successfulUpdates,
      failedConnections: this.stats.failedUpdates,
      skippedTickets: this.stats.skippedTickets,
    };

    console.log("\n" + "=".repeat(60));
    console.log("📊 TICKET CONNECTION SUMMARY");
    console.log("=".repeat(60));
    console.log(`Total objects processed: ${summary.totalObjects}`);
    console.log(`Objects with tickets: ${summary.objectsWithTickets}`);
    console.log(`Total tickets processed: ${summary.totalTicketsProcessed}`);
    console.log(`✅ Successful connections: ${summary.successfulConnections}`);
    if (summary.failedConnections > 0) {
      console.log(`❌ Failed connections: ${summary.failedConnections}`);
    }
    if (summary.skippedTickets > 0) {
      console.log(`⏭️  Skipped tickets: ${summary.skippedTickets}`);
    }
    console.log("=".repeat(60));

    return summary;
  }
}

module.exports = TicketConnector;
