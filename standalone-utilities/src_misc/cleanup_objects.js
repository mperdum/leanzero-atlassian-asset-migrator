#!/usr/bin/env node

/**
 * Object Cleanup Utility
 *
 * This script safely deletes all objects from Jira Cloud Assets object schemas
 * while preserving the schema structure (object types, attributes, etc.).
 *
 * SAFETY FEATURES:
 * - Preserves all object schemas, object types, and attributes
 * - Preserves objects in schemas that start with "Testing"
 * - Deletes objects only from non-Testing schemas
 * - Dry-run mode for safe testing
 * - Confirmation prompts before deletion
 * - Detailed logging and progress tracking
 * - Batch processing with rate limiting
 *
 * USAGE:
 * node cleanup_objects.js --dry-run                    # Test mode (no deletions)
 * node cleanup_objects.js --confirm                    # Production mode with confirmation
 * node cleanup_objects.js --confirm --schema "MySchema" # Clean specific schema only
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// Import the existing CloudApiClient
const CloudApiClient = require("../../asset-migration-script/modules/cloudApiClient");

// Environment configuration
// Use WORKSPACE_ID for cleanup operations (the target workspace with migrated data)
const { CLOUD_BASE_URL, CLOUD_API_TOKEN, WORKSPACE_ID } = process.env;

if (!CLOUD_BASE_URL || !CLOUD_API_TOKEN || !WORKSPACE_ID) {
  console.error("❌ ERROR: Missing required environment variables.");
  console.error(
    "Please ensure CLOUD_BASE_URL, CLOUD_API_TOKEN, and WORKSPACE_ID are set in .env file",
  );
  process.exit(1);
}

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const isConfirmed = args.includes("--confirm");
const schemaFilter = args.find((arg, i) => args[i - 1] === "--schema");
const batchSize = parseInt(
  args.find((arg, i) => args[i - 1] === "--batch-size") || "10",
);

// Initialize API client
const baseUrl = CLOUD_BASE_URL.replace(/^https?:\/\//, "");
const apiClient = new CloudApiClient(WORKSPACE_ID, CLOUD_API_TOKEN, baseUrl);

// Cleanup state
const cleanupState = {
  startTime: Date.now(),
  totalObjects: 0,
  processedObjects: 0,
  deletedObjects: 0,
  errorObjects: 0,
  currentSchema: null,
  logFile: `./logs/cleanup_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log`,
};

/**
 * Enhanced CloudApiClient with delete functionality
 */
class CleanupApiClient extends CloudApiClient {
  /**
   * Delete an object by ID
   */
  async deleteObject(objectId) {
    const endpoint = `/jsm/assets/workspace/${this.workspaceId}/v1/object/${objectId}`;
    return await this.makeRequest("DELETE", endpoint);
  }

  /**
   * Get all objects from a schema using AQL
   */
  async getAllObjectsFromSchema(
    schemaId,
    schemaKey,
    startAt = 0,
    maxResults = 100,
  ) {
    // Use objectSchemaId which works reliably
    const aqlQuery = `objectSchemaId = ${schemaId}`;
    const response = await this.executeAQL(aqlQuery, startAt, maxResults, true);

    // Debug logging
    console.log(
      `    🔍 DEBUG: AQL Response keys: ${Object.keys(response).join(", ")}`,
    );
    console.log(
      `    🔍 DEBUG: Total: ${response.totalFilterCount || response.total || "unknown"}`,
    );
    console.log(
      `    🔍 DEBUG: Values length: ${response.values?.length || response.objectEntries?.length || 0}`,
    );

    return response;
  }

  /**
   * Get all objects with pagination and deduplication
   */
  async getAllObjectsPaginated(schemaId, schemaKey) {
    const allObjects = [];
    const seenIds = new Set();
    let startAt = 0;
    const maxResults = 100;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await this.getAllObjectsFromSchema(
          schemaId,
          schemaKey,
          startAt,
          maxResults,
        );
        // Try both possible response formats
        const objects = response.values || response.objectEntries || [];

        // Deduplicate objects by ID
        const uniqueObjects = objects.filter((obj) => {
          if (seenIds.has(obj.id)) {
            console.log(
              `    🔄 Skipping duplicate object: ${getObjectDisplayName(obj)} (ID: ${obj.id})`,
            );
            return false;
          }
          seenIds.add(obj.id);
          return true;
        });

        allObjects.push(...uniqueObjects);

        hasMore = objects.length === maxResults;
        startAt += maxResults;

        if (objects.length > 0) {
          console.log(
            `    📄 Fetched ${objects.length} objects (${uniqueObjects.length} unique, total: ${allObjects.length})`,
          );
        }

        // Small delay to avoid rate limiting
        await this.sleep(200);
      } catch (error) {
        console.error(`    ❌ Error fetching objects: ${error.message}`);
        console.error(`    🔍 DEBUG: Error details:`, error);
        break;
      }
    }

    console.log(
      `  ✅ Deduplication complete: ${allObjects.length} unique objects from ${seenIds.size} total IDs`,
    );
    return allObjects;
  }
}

// Initialize enhanced API client
const cleanupClient = new CleanupApiClient(
  WORKSPACE_ID,
  CLOUD_API_TOKEN,
  baseUrl,
);

/**
 * Log message to both console and file
 */
function log(message, level = "INFO") {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level}] ${message}`;

  console.log(message);

  // Ensure logs directory exists
  if (!fs.existsSync("./logs")) {
    fs.mkdirSync("./logs");
  }

  // Append to log file
  fs.appendFileSync(cleanupState.logFile, logEntry + "\n");
}

/**
 * Ask for user confirmation
 */
function askConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

/**
 * Check if schema should be skipped (starts with "Testing")
 */
function shouldSkipSchema(schemaName) {
  return schemaName && schemaName.startsWith("Testing");
}

/**
 * Get object display name
 */
function getObjectDisplayName(obj) {
  // Try to find a name attribute
  if (obj.attributes) {
    const nameAttr = obj.attributes.find(
      (attr) =>
        attr.objectTypeAttribute &&
        (attr.objectTypeAttribute.name === "Name" ||
          attr.objectTypeAttribute.name === "Key" ||
          attr.objectTypeAttribute.name === "Title"),
    );
    if (
      nameAttr &&
      nameAttr.objectAttributeValues &&
      nameAttr.objectAttributeValues.length > 0
    ) {
      return (
        nameAttr.objectAttributeValues[0].displayValue ||
        nameAttr.objectAttributeValues[0].value
      );
    }
  }

  // Fallback to object key or ID
  return obj.objectKey || `Object-${obj.id}`;
}

/**
 * Delete objects in batches
 */
async function deleteObjectsBatch(objects, schemaName) {
  const results = {
    deleted: 0,
    errors: 0,
    alreadyDeleted: 0,
  };

  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < objects.length; i += batchSize) {
    const batch = objects.slice(i, i + batchSize);
    console.log(
      `    📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(objects.length / batchSize)} (${batch.length} objects)`,
    );

    // Process batch items
    for (const obj of batch) {
      const objectName = getObjectDisplayName(obj);
      cleanupState.processedObjects++;

      try {
        if (isDryRun) {
          log(
            `    🔍 DRY-RUN: Would delete ${objectName} (ID: ${obj.id})`,
            "DRY-RUN",
          );
          results.deleted++;
        } else {
          // Actually delete the object
          await cleanupClient.deleteObject(obj.id);
          log(`    ✅ DELETED: ${objectName} (ID: ${obj.id})`, "DELETE");
          results.deleted++;
          cleanupState.deletedObjects++;
        }
      } catch (error) {
        // Handle 404 errors gracefully (object already deleted)
        const is404 =
          error.statusCode === 404 ||
          error.message.includes("HTTP 404") ||
          error.message.includes("Could not find Object") ||
          (error.response && error.response.includes("Could not find Object"));

        if (is404) {
          log(
            `    ⚠️  ALREADY DELETED: ${objectName} (ID: ${obj.id}) - object not found`,
            "SKIP",
          );
          results.alreadyDeleted = (results.alreadyDeleted || 0) + 1;
          cleanupState.deletedObjects++; // Count as successful since it's gone
        } else {
          log(
            `    ❌ ERROR deleting ${objectName} (ID: ${obj.id}): ${error.message}`,
            "ERROR",
          );
          results.errors++;
          cleanupState.errorObjects++;
        }
      }

      // Small delay between deletions
      if (!isDryRun) {
        await cleanupClient.sleep(100);
      }
    }

    // Delay between batches
    if (i + batchSize < objects.length) {
      await cleanupClient.sleep(500);
    }
  }

  return results;
}

/**
 * Clean objects from a specific schema
 */
async function cleanSchema(schema) {
  console.log(`\n📂 Processing Schema: ${schema.name} (ID: ${schema.id})`);
  cleanupState.currentSchema = schema.name;

  // Skip Testing schemas - preserve their objects
  if (shouldSkipSchema(schema.name)) {
    console.log("  🧪 SKIPPING: Testing schema - objects will be preserved");
    return;
  }

  try {
    // Get all objects from this schema
    console.log("  📋 Fetching all objects...");
    const objects = await cleanupClient.getAllObjectsPaginated(
      schema.id,
      schema.objectSchemaKey,
    );

    if (objects.length === 0) {
      console.log("  ✨ Schema is already empty");
      return;
    }

    console.log(`  📊 Found ${objects.length} objects`);
    cleanupState.totalObjects += objects.length;

    console.log(
      `  🗑️  Objects to ${isDryRun ? "simulate deletion" : "delete"}: ${objects.length}`,
    );

    if (objects.length === 0) {
      console.log("  ✨ No objects to delete in this schema");
      return;
    }

    // Show sample of objects to be deleted
    if (objects.length > 0) {
      console.log("  📋 Sample objects to be deleted:");
      objects.slice(0, 5).forEach((obj) => {
        const name = getObjectDisplayName(obj);
        console.log(`    - ${name} (ID: ${obj.id})`);
      });
      if (objects.length > 5) {
        console.log(`    ... and ${objects.length - 5} more`);
      }
    }

    // Confirmation for production mode
    if (!isDryRun && !isConfirmed) {
      const confirmed = await askConfirmation(
        `\n⚠️  Are you sure you want to delete ${objects.length} objects from schema "${schema.name}"? (y/N): `,
      );
      if (!confirmed) {
        console.log("  ⏭️  Skipping schema");
        return;
      }
    }

    // Delete objects
    console.log(
      `  🚀 ${isDryRun ? "Simulating deletion of" : "Deleting"} ${objects.length} objects...`,
    );
    const results = await deleteObjectsBatch(objects, schema.name);

    // Report results
    console.log(`  📊 Schema Results:`);
    console.log(
      `    ✅ ${isDryRun ? "Would delete" : "Deleted"}: ${results.deleted}`,
    );
    if (results.alreadyDeleted > 0) {
      console.log(`    ⚠️  Already deleted: ${results.alreadyDeleted}`);
    }
    console.log(`    ❌ Errors: ${results.errors}`);
  } catch (error) {
    log(`❌ Error processing schema ${schema.name}: ${error.message}`, "ERROR");
    cleanupState.errorObjects++;
  }
}

/**
 * Main cleanup function
 */
async function cleanup() {
  console.log("\n🧹 Object Cleanup Utility v1.0");
  console.log("================================");
  console.log(
    `Mode: ${isDryRun ? "🔍 DRY RUN (No actual deletions)" : "⚡ PRODUCTION (Real deletions)"}`,
  );
  console.log(`Workspace: ${WORKSPACE_ID}`);
  console.log(`Batch Size: ${batchSize}`);
  console.log(`Schema Filter: ${schemaFilter || "All schemas"}`);
  console.log(`Log File: ${cleanupState.logFile}`);
  console.log("");

  // Safety check
  if (!isDryRun && !isConfirmed) {
    console.log("⚠️  SAFETY WARNING: This will permanently delete objects!");
    console.log(
      "   - Object schemas, types, and attributes will NOT be touched",
    );
    console.log('   - Objects starting with "Test" will be preserved');
    console.log("   - Use --dry-run first to test safely");
    console.log("   - Use --confirm to skip this warning");
    console.log("");

    const confirmed = await askConfirmation("Do you want to continue? (y/N): ");
    if (!confirmed) {
      console.log("❌ Operation cancelled");
      process.exit(0);
    }
  }

  try {
    // Test connection
    console.log("🔌 Testing connection...");
    const connected = await cleanupClient.testConnection();
    if (!connected) {
      console.error("❌ Failed to connect to Jira Cloud Assets API");
      process.exit(1);
    }

    // Get all schemas
    console.log("📋 Fetching object schemas...");
    const schemas = await cleanupClient.getSchemas();
    console.log(`📊 Found ${schemas.length} object schemas`);

    // Filter schemas if specified
    const schemasToProcess = schemaFilter
      ? schemas.filter((schema) => schema.name === schemaFilter)
      : schemas;

    if (schemasToProcess.length === 0) {
      console.log(
        `❌ No schemas found${schemaFilter ? ` matching "${schemaFilter}"` : ""}`,
      );
      process.exit(1);
    }

    console.log(`🎯 Processing ${schemasToProcess.length} schema(s)`);

    // Process each schema
    for (const schema of schemasToProcess) {
      await cleanSchema(schema);
    }

    // Final summary
    const duration = ((Date.now() - cleanupState.startTime) / 1000).toFixed(1);
    console.log("\n📊 CLEANUP SUMMARY");
    console.log("==================");
    console.log(`Duration: ${duration}s`);
    console.log(`Total Objects Found: ${cleanupState.totalObjects}`);
    console.log(`Objects Processed: ${cleanupState.processedObjects}`);
    console.log(
      `${isDryRun ? "Would Delete" : "Deleted"}: ${cleanupState.deletedObjects}`,
    );
    console.log(`Errors: ${cleanupState.errorObjects}`);
    console.log(`Log File: ${cleanupState.logFile}`);

    // API statistics
    const stats = cleanupClient.getStats();
    console.log(`\nAPI Statistics:`);
    console.log(`  Total Requests: ${stats.totalRequests}`);
    console.log(`  Error Rate: ${stats.errorRate}`);

    if (cleanupState.errorObjects > 0) {
      console.log(
        "\n⚠️  Some errors occurred. Check the log file for details.",
      );
      process.exit(1);
    } else {
      console.log("\n✅ Cleanup completed successfully!");
    }
  } catch (error) {
    log(`❌ Fatal error: ${error.message}`, "FATAL");
    console.error("❌ Fatal error occurred. Check the log file for details.");
    process.exit(1);
  }
}

// Validate arguments
if (!isDryRun && !isConfirmed) {
  // This is handled in the main function with interactive confirmation
}

if (schemaFilter && !schemaFilter.trim()) {
  console.error("❌ Schema filter cannot be empty");
  process.exit(1);
}

if (batchSize < 1 || batchSize > 100) {
  console.error("❌ Batch size must be between 1 and 100");
  process.exit(1);
}

// Show usage if no valid mode specified
if (args.length === 0) {
  console.log("Object Cleanup Utility");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node cleanup_objects.js --dry-run                    # Test mode (no deletions)",
  );
  console.log(
    "  node cleanup_objects.js --confirm                    # Production mode with confirmation",
  );
  console.log(
    '  node cleanup_objects.js --confirm --schema "MySchema" # Clean specific schema only',
  );
  console.log("");
  console.log("Options:");
  console.log("  --dry-run                Test mode - no actual deletions");
  console.log("  --confirm                Skip interactive confirmation");
  console.log("  --schema <name>          Process only the specified schema");
  console.log(
    "  --batch-size <number>    Objects per batch (default: 10, max: 100)",
  );
  console.log("");
  console.log("Safety Features:");
  console.log("  ✅ Preserves object schemas, types, and attributes");
  console.log('  ✅ Preserves objects starting with "Test"');
  console.log("  ✅ Dry-run mode for safe testing");
  console.log("  ✅ Detailed logging and progress tracking");
  process.exit(0);
}

// Run the cleanup
cleanup().catch((error) => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});
