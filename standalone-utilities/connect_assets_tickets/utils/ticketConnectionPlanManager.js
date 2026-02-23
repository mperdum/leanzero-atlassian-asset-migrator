#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

/**
 * Ticket Connection Plan Manager
 *
 * Manages a cached plan of ticket connections to avoid reprocessing all objects every time.
 * Similar to migration_plan.json but specifically for ticket connections.
 */

class TicketConnectionPlanManager {
  constructor(options = {}) {
    this.planPath = path.join(
      __dirname,
      "../logs",
      "ticket_connection_plan.json",
    );
    this.createdObjectsMappingPath = path.join(
      __dirname,
      "../../..",
      "asset-migration-script",
      "logs",
      "created_objects_mapping.json",
    );
    this.datacenterPath =
      options.datacenterPath ||
      path.join(__dirname, "../../..", "datacenter_assets");

    // Path to connectedTickets directory
    this.connectedTicketsPath = path.join(
      this.datacenterPath,
      "connectedTickets",
    );

    this.plan = null;
    this.stats = {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      skipped: 0, // Objects with no tickets
    };

    // Cache for objects.json files to prevent reading same file thousands of times
    // Key: schema/objectType path, Value: parsed objects array
    this.objectsFileCache = new Map();

    this.ensureLogDirectory();
  }

  /**
   * Ensure log directory exists
   */
  ensureLogDirectory() {
    const logDir = path.dirname(this.planPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Load ticket associations from connectedTickets/*.json files
   * Returns a Map of objectKey -> array of ticket keys that reference it
   */
  loadTicketAssociations() {
    console.log("   📂 Loading ticket associations from connectedTickets/...");

    const objectToTicketsMap = new Map();

    if (!fs.existsSync(this.connectedTicketsPath)) {
      console.log(
        "   ⚠️  connectedTickets directory not found at:",
        this.connectedTicketsPath,
      );
      return objectToTicketsMap;
    }

    // Read all JSON files from connectedTickets directory
    const files = fs
      .readdirSync(this.connectedTicketsPath)
      .filter((f) => f.endsWith(".json"));

    console.log(`   📊 Found ${files.length} custom field files to process`);

    let totalTickets = 0;
    let totalObjectReferences = 0;

    for (const file of files) {
      const filePath = path.join(this.connectedTicketsPath, file);

      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const fieldId = data.fieldId;
        const fieldName = data.fieldName;
        const tickets = data.tickets || [];

        console.log(
          `   🔍 Processing ${fieldName} (${fieldId}): ${tickets.length} tickets`,
        );

        for (const ticket of tickets) {
          // Validate ticket has required properties
          if (!ticket || !ticket.key) {
            console.warn(
              `   ⚠️  Skipping invalid ticket in ${fieldName}: missing key`,
            );
            continue;
          }

          const ticketKey = ticket.key;
          const fieldValue = ticket.fieldValue;

          // Skip tickets with no field value (shouldn't happen but be safe)
          if (!fieldValue) {
            continue;
          }

          totalTickets++;

          // Parse fieldValue to extract object keys
          // fieldValue can be:
          // - Array of strings: ["Asset (AAM-123)", "Asset (AAM-456)"]
          // - Single string: "Asset (AAM-123)"
          // - Array of objects: [{key: "AAM-123", name: "Asset"}]
          const objectKeys = this.extractObjectKeysFromFieldValue(fieldValue);

          // Skip if no object keys could be extracted
          if (objectKeys.length === 0) {
            continue;
          }

          for (const objectKey of objectKeys) {
            if (!objectToTicketsMap.has(objectKey)) {
              objectToTicketsMap.set(objectKey, []);
            }

            // Add ticket object with field data if not already present
            const ticketList = objectToTicketsMap.get(objectKey);
            const existingTicket = ticketList.find((t) => t.key === ticketKey);

            if (!existingTicket) {
              // Store full ticket object with custom field data
              ticketList.push({
                key: ticketKey,
                customFieldsContainingObject: [
                  {
                    datacenterFieldName: fieldName,
                    fieldId: fieldId,
                    fieldValue: fieldValue,
                  },
                ],
              });
              totalObjectReferences++;
            } else {
              // Ticket already exists for this object, add this custom field to it
              existingTicket.customFieldsContainingObject.push({
                datacenterFieldName: fieldName,
                fieldId: fieldId,
                fieldValue: fieldValue,
              });
            }
          }
        }
      } catch (error) {
        console.error(`   ❌ Error processing ${file}:`, error.message);
      }
    }

    console.log(
      `   ✅ Loaded ${totalTickets} tickets with ${totalObjectReferences} object references`,
    );
    console.log(
      `   📦 Found ${objectToTicketsMap.size} unique objects with ticket associations`,
    );

    return objectToTicketsMap;
  }

  /**
   * Extract object keys from various field value formats
   */
  extractObjectKeysFromFieldValue(fieldValue) {
    const objectKeys = [];

    if (!fieldValue) {
      return objectKeys;
    }

    // Handle array of values
    if (Array.isArray(fieldValue)) {
      for (const value of fieldValue) {
        // Skip null/undefined values in array
        if (!value) {
          continue;
        }

        if (typeof value === "string") {
          // Extract from string like "Asset (AAM-123)" or "AAM-123"
          const keys = this.extractKeysFromString(value);
          objectKeys.push(...keys);
        } else if (typeof value === "object" && value !== null && value.key) {
          // Extract from object like {key: "AAM-123", name: "Asset"}
          // Extra check for null since typeof null === "object"
          objectKeys.push(value.key);
        }
      }
    } else if (typeof fieldValue === "string") {
      // Single string value
      const keys = this.extractKeysFromString(fieldValue);
      objectKeys.push(...keys);
    } else if (
      typeof fieldValue === "object" &&
      fieldValue !== null &&
      fieldValue.key
    ) {
      // Single object value
      // Extra check for null since typeof null === "object"
      objectKeys.push(fieldValue.key);
    }

    return objectKeys;
  }

  /**
   * Extract object keys from a string like "Asset (AAM-123)" or "AAM-123"
   * Matches patterns like: AAM-123, APP-456, etc.
   */
  extractKeysFromString(str) {
    const keys = [];

    // Defensive check - should never happen but be safe
    if (!str || typeof str !== "string") {
      return keys;
    }

    // Pattern to match object keys: 2+ uppercase letters followed by dash and numbers
    // Examples: AAM-123, APP-456, CMDB-789
    // Note: Won't match single-letter keys like A-123
    const keyPattern = /[A-Z]{2,}-\d+/g;
    const matches = str.match(keyPattern);

    if (matches) {
      keys.push(...matches);
    }

    return keys;
  }

  /**
   * Load existing plan or create new one
   */
  loadOrCreatePlan(forceRecreate = false) {
    if (forceRecreate || !fs.existsSync(this.planPath)) {
      console.log("📋 Creating new ticket connection plan...");
      this.createNewPlan();
    } else {
      console.log("📂 Loading existing ticket connection plan...");
      this.loadExistingPlan();
    }

    this.updateStats();
    return this.plan;
  }

  /**
   * Create a new ticket connection plan by analyzing all objects
   */
  createNewPlan() {
    console.log(
      "   🔍 Analyzing all created objects for ticket connections...",
    );

    // Load ticket associations from connectedTickets/*.json files
    const objectToTicketsMap = this.loadTicketAssociations();

    // Load created objects mapping
    const createdObjectsMapping = this.loadCreatedObjectsMapping();

    const ticketConnections = [];
    let processedCount = 0;
    const total = Object.keys(createdObjectsMapping).length;

    for (const [datacenterKey, cloudMeta] of Object.entries(
      createdObjectsMapping,
    )) {
      processedCount++;
      if (processedCount % 1000 === 0) {
        console.log(`   📊 Analyzed ${processedCount}/${total} objects...`);
      }

      // Load datacenter object metadata (name, label, etc.)
      const dcObject = this.loadDatacenterObject(datacenterKey, cloudMeta);
      if (!dcObject) {
        continue; // Skip if we can't load the datacenter object
      }

      // Get tickets for this object from the loaded associations
      const connectedTickets = objectToTicketsMap.get(datacenterKey) || [];
      const hasTickets = connectedTickets.length > 0;
      const ticketCount = connectedTickets.length;

      ticketConnections.push({
        datacenterKey: datacenterKey,
        name: cloudMeta.name || dcObject.label || datacenterKey,
        schema: cloudMeta.schema,
        objectType: cloudMeta.objectType,
        cloudId: cloudMeta.cloudId,
        cloudKey: cloudMeta.cloudKey || cloudMeta.cloudId,
        hasTickets: hasTickets,
        ticketCount: ticketCount,
        tickets: connectedTickets, // Now comes from connectedTickets/*.json files
        status: hasTickets ? "pending" : "skipped",
        createdAt: new Date().toISOString(),
        updatedAt: null,
        error: null,
        processedTickets: 0,
        successfulTickets: 0,
        failedTickets: 0,
      });
    }

    this.plan = {
      version: "1.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalObjects: ticketConnections.length,
      objectsWithTickets: ticketConnections.filter((obj) => obj.hasTickets)
        .length,
      totalTickets: ticketConnections.reduce(
        (sum, obj) => sum + obj.ticketCount,
        0,
      ),
      stats: this.stats,
      objects: ticketConnections,
    };

    this.savePlan();
    console.log(
      `   ✅ Created plan with ${this.plan.totalObjects} objects (${this.plan.objectsWithTickets} have tickets)`,
    );

    // Clear file cache after plan creation to free memory
    this.clearObjectsFileCache();
  }

  /**
   * Clear the objects.json file cache to free memory
   * Call this after plan creation is complete
   */
  clearObjectsFileCache() {
    const cacheSize = this.objectsFileCache.size;
    this.objectsFileCache.clear();
    console.log(
      `   🧹 Cleared file cache (${cacheSize} files freed from memory)`,
    );
  }

  /**
   * Load existing plan from file
   */
  loadExistingPlan() {
    try {
      const planData = fs.readFileSync(this.planPath, "utf8");
      this.plan = JSON.parse(planData);
      console.log(
        `   ✅ Loaded existing plan with ${this.plan.totalObjects} objects`,
      );
    } catch (error) {
      console.error(`   ❌ Failed to load existing plan: ${error.message}`);
      console.log("   🔄 Creating new plan...");
      this.createNewPlan();
    }
  }

  /**
   * Load created objects mapping
   */
  loadCreatedObjectsMapping() {
    if (!fs.existsSync(this.createdObjectsMappingPath)) {
      throw new Error(
        `Created objects mapping not found: ${this.createdObjectsMappingPath}`,
      );
    }

    const rawData = fs.readFileSync(this.createdObjectsMappingPath, "utf8");
    const mappingData = JSON.parse(rawData);

    const objectMappings = {};

    if (mappingData.mappings && Array.isArray(mappingData.mappings)) {
      // Process Map-style array format
      for (const [key, value] of mappingData.mappings) {
        if (
          value &&
          typeof value === "object" &&
          value.datacenterKey &&
          value.cloudId &&
          !key.startsWith("name:")
        ) {
          objectMappings[key] = value;
        }
      }
    }

    return objectMappings;
  }

  /**
   * Load datacenter object by key using cloud mapping metadata
   * Uses file cache to avoid reading same objects.json file thousands of times
   */
  loadDatacenterObject(datacenterKey, cloudMeta) {
    if (!cloudMeta || !cloudMeta.schema || !cloudMeta.objectType) {
      return null;
    }

    const objectsFilePath = path.join(
      this.datacenterPath,
      cloudMeta.schema,
      cloudMeta.objectType,
      "objects.json",
    );

    if (!fs.existsSync(objectsFilePath)) {
      return null;
    }

    try {
      // Check cache first to avoid re-reading same file thousands of times
      let objectsData = this.objectsFileCache.get(objectsFilePath);

      if (!objectsData) {
        // Cache miss - read and parse file, then cache it
        objectsData = JSON.parse(fs.readFileSync(objectsFilePath, "utf8"));
        this.objectsFileCache.set(objectsFilePath, objectsData);
      }

      const dcObject = objectsData.find(
        (obj) =>
          obj.objectKey === datacenterKey ||
          obj.objectKey === cloudMeta.datacenterKey ||
          obj.label === cloudMeta.name ||
          obj.name === cloudMeta.name,
      );

      return dcObject || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Update statistics based on current plan
   */
  updateStats() {
    if (!this.plan || !this.plan.objects) {
      return;
    }

    this.stats = {
      total: this.plan.objects.length,
      pending: this.plan.objects.filter((obj) => obj.status === "pending")
        .length,
      processing: this.plan.objects.filter((obj) => obj.status === "processing")
        .length,
      completed: this.plan.objects.filter((obj) => obj.status === "completed")
        .length,
      failed: this.plan.objects.filter((obj) => obj.status === "failed").length,
      skipped: this.plan.objects.filter((obj) => obj.status === "skipped")
        .length,
    };

    // Update plan stats
    this.plan.stats = this.stats;
    this.plan.updatedAt = new Date().toISOString();
  }

  /**
   * Get objects to process based on mode
   */
  getObjectsToProcess(mode = "ALL", filters = {}) {
    if (!this.plan || !this.plan.objects) {
      return [];
    }

    let objectsToProcess = [...this.plan.objects];

    // Apply mode filter
    if (mode === "start-from-pending") {
      objectsToProcess = objectsToProcess.filter(
        (obj) => obj.status === "pending" || obj.status === "failed",
      );
    } else if (mode === "retry-failed-tickets") {
      // Retry objects that have failed OR skipped tickets (even if status is "completed")
      objectsToProcess = objectsToProcess.filter((obj) => {
        const processed = obj.processedTickets || 0;
        const successful = obj.successfulTickets || 0;
        const failed = obj.failedTickets || 0;
        const skipped = processed - successful - failed;

        return (
          obj.status === "failed" ||
          (obj.status === "completed" && obj.failedTickets > 0) ||
          (obj.status === "completed" && skipped > 0)
        );
      });
    } else if (mode === "ALL") {
      // For ALL mode, include everything except skipped (no tickets)
      objectsToProcess = objectsToProcess.filter((obj) => obj.hasTickets);
    }

    // Apply additional filters
    if (filters.schema) {
      objectsToProcess = objectsToProcess.filter(
        (obj) => obj.schema === filters.schema,
      );
    }

    if (filters.type) {
      objectsToProcess = objectsToProcess.filter(
        (obj) =>
          obj.objectType === filters.type ||
          obj.objectType.endsWith(`/${filters.type}`),
      );
    }

    if (filters.limit > 0) {
      objectsToProcess = objectsToProcess.slice(0, filters.limit);
    }

    return objectsToProcess;
  }

  /**
   * Update object status in plan
   */
  updateObjectStatus(datacenterKey, status, updateData = {}) {
    if (!this.plan || !this.plan.objects) {
      return false;
    }

    const objectIndex = this.plan.objects.findIndex(
      (obj) => obj.datacenterKey === datacenterKey,
    );
    if (objectIndex === -1) {
      return false;
    }

    const object = this.plan.objects[objectIndex];
    object.status = status;
    object.updatedAt = new Date().toISOString();

    // Apply additional update data
    Object.assign(object, updateData);

    this.updateStats();
    return true;
  }

  /**
   * Reset failed objects to pending status
   */
  resetFailedToPending() {
    if (!this.plan || !this.plan.objects) {
      return 0;
    }

    let resetCount = 0;
    for (const object of this.plan.objects) {
      if (object.status === "failed") {
        object.status = "pending";
        object.updatedAt = new Date().toISOString();
        object.error = null;
        object.processedTickets = 0;
        object.successfulTickets = 0;
        object.failedTickets = 0;
        resetCount++;
      }
    }

    if (resetCount > 0) {
      this.updateStats();
      this.savePlan();
    }

    return resetCount;
  }

  /**
   * Save plan to file
   */
  savePlan() {
    try {
      fs.writeFileSync(this.planPath, JSON.stringify(this.plan, null, 2));
    } catch (error) {
      console.error(
        `❌ Failed to save ticket connection plan: ${error.message}`,
      );
    }
  }

  /**
   * Get plan summary
   */
  getPlanSummary() {
    if (!this.plan) {
      return null;
    }

    return {
      version: this.plan.version,
      createdAt: this.plan.createdAt,
      updatedAt: this.plan.updatedAt,
      totalObjects: this.plan.totalObjects,
      objectsWithTickets: this.plan.objectsWithTickets,
      totalTickets: this.plan.totalTickets,
      stats: this.stats,
    };
  }
}

module.exports = TicketConnectionPlanManager;
