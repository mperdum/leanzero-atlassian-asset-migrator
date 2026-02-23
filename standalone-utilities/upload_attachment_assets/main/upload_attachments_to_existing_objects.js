#!/usr/bin/env node

/**
 * Standalone Attachment Upload Utility
 *
 * Uploads attachments to existing migrated Assets objects by reading:
 * - created_objects_mapping.json for cloud object IDs
 * - Datacenter objects for attachments data with local file paths
 * - Uses AttachmentUploader for batch processing
 *
 * Usage:
 * node upload_attachments_to_existing_objects.js [options]
 *
 * Options:
 * --schema [name]          Process specific schema only
 * --type [name]            Process specific object type only
 * --limit [n]              Limit number of objects to process
 * --dry-run                Show what would be processed without making changes
 * --parallel               Enable parallel attachment uploads
 * --max-attachments [n]    Maximum attachments per object (default: 10)
 * --max-size [n]           Maximum file size in MB (default: 100)
 * --help                   Show this help message
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

// Import required modules from the main migration script
const CloudApiClient = require("../../../asset-migration-script/modules/cloudApiClient");
const AttachmentUploader = require("../../../asset-migration-script/modules/attachmentUploader");

class StandaloneAttachmentUploader {
  constructor(options = {}) {
    this.options = {
      schema: options.schema || null,
      type: options.type || null,
      limit: options.limit || 0,
      dryRun: options.dryRun || false,
      parallel: options.parallel || false,
      maxAttachmentsPerObject: options.maxAttachmentsPerObject || 10,
      maxFileSize: options.maxFileSize || 100,
      ...options,
    };

    // Initialize API client
    const baseUrl = process.env.CLOUD_BASE_URL.replace(/^https?:\/\//, "");
    this.apiClient = new CloudApiClient(
      process.env.WORKSPACE_ID,
      process.env.CLOUD_API_TOKEN,
      baseUrl,
    );

    // Initialize attachment uploader
    this.attachmentUploader = new AttachmentUploader(this.apiClient, {
      enabled: !this.options.dryRun,
      maxAttachmentsPerObject: this.options.maxAttachmentsPerObject,
      maxFileSize: this.options.maxFileSize,
      parallelUploads: this.options.parallel,
      maxRetries: 3,
      retryDelay: 2000,
    });

    // Paths
    this.datacenterPath =
      process.env.DATACENTER_PATH ||
      path.join(__dirname, "../../..", "datacenter_assets");
    this.mappingFile = path.join(
      __dirname,
      "../../..",
      "asset-migration-script",
      "logs",
      "created_objects_mapping.json",
    );

    // Statistics
    this.stats = {
      totalObjects: 0,
      processedObjects: 0,
      objectsWithAttachments: 0,
      skippedObjects: 0,
      errors: [],
    };

    console.log("🚀 Standalone Attachment Upload Utility");
    console.log("======================================");
    console.log(`Datacenter path: ${this.datacenterPath}`);
    console.log(`Mapping file: ${this.mappingFile}`);
    console.log(`Dry run: ${this.options.dryRun}`);
    console.log("");
  }

  /**
   * Load the created objects mapping
   */
  loadObjectMapping() {
    if (!fs.existsSync(this.mappingFile)) {
      throw new Error(
        `Created objects mapping file not found: ${this.mappingFile}`,
      );
    }

    const mappingData = fs.readFileSync(this.mappingFile, "utf8");
    const parsedData = JSON.parse(mappingData);

    // Handle the file format with metadata wrapper
    if (parsedData.mappings && Array.isArray(parsedData.mappings)) {
      // Convert the mappings array back to a Map structure organized by schema and type
      const organizedMapping = {};

      for (const [datacenterKey, objectData] of parsedData.mappings) {
        if (!objectData || !objectData.schema || !objectData.objectType)
          continue;

        const schema = objectData.schema;
        const objectType = objectData.objectType;
        const dcKey = objectData.datacenterKey;

        if (!organizedMapping[schema]) {
          organizedMapping[schema] = {};
        }
        if (!organizedMapping[schema][objectType]) {
          organizedMapping[schema][objectType] = {};
        }

        organizedMapping[schema][objectType][dcKey] = objectData;
      }

      return organizedMapping;
    }

    // Fallback for old format
    return parsedData;
  }

  /**
   * Load attachment data from new separate attachment files
   */
  loadAttachmentData(schema, objectType) {
    // Handle hierarchical paths (e.g., "Asset/Mobile_Phone")
    const pathParts = objectType.split("/");
    const attachmentsFilePath = path.join(
      this.datacenterPath,
      "attachments",
      schema,
      ...pathParts,
      "attachments.json",
    );

    if (!fs.existsSync(attachmentsFilePath)) {
      return null;
    }

    try {
      const attachmentData = JSON.parse(
        fs.readFileSync(attachmentsFilePath, "utf8"),
      );
      return attachmentData;
    } catch (error) {
      console.log(
        `    ⚠️  Error reading attachment file ${attachmentsFilePath}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Load datacenter object data (without attachments - for backward compatibility check)
   */
  loadDatacenterObject(schema, objectType, objectId) {
    // Handle hierarchical paths (e.g., "Asset/Mobile_Phone")
    const pathParts = objectType.split("/");
    let objectsFilePath = path.join(
      this.datacenterPath,
      schema,
      ...pathParts,
      "objects.json",
    );

    if (!fs.existsSync(objectsFilePath)) {
      return null;
    }

    const objectsData = JSON.parse(fs.readFileSync(objectsFilePath, "utf8"));

    // Try multiple ID matching strategies
    let dcObject = null;

    // Strategy 1: Direct ID match (numeric or string)
    dcObject = objectsData.find((obj) => obj.id === objectId);
    if (dcObject) return dcObject;

    // Strategy 2: Extract numeric part from datacenter key (e.g., "AAP-48446" -> 48446)
    if (typeof objectId === "string" && objectId.includes("-")) {
      const numericId = objectId.split("-").pop();
      dcObject = objectsData.find((obj) => obj.id == numericId);
      if (dcObject) return dcObject;
    }

    // Strategy 3: Try objectKey match
    dcObject = objectsData.find((obj) => obj.objectKey === objectId);
    if (dcObject) return dcObject;

    // Strategy 4: Try Key field match
    dcObject = objectsData.find((obj) => obj.Key === objectId);
    if (dcObject) return dcObject;

    return null;
  }

  /**
   * Find attachments for a specific object from attachment data
   */
  findAttachmentsForObject(attachmentData, objectId) {
    if (!attachmentData || !attachmentData.objects) {
      return null;
    }

    // Try multiple matching strategies
    for (const obj of attachmentData.objects) {
      // Strategy 1: Match by objectKey
      if (obj.objectKey === objectId) {
        return obj.attachments || [];
      }

      // Strategy 2: Match by objectId
      if (obj.objectId === objectId || obj.objectId === objectId.toString()) {
        return obj.attachments || [];
      }

      // Strategy 3: Extract numeric part and match
      if (typeof objectId === "string" && objectId.includes("-")) {
        const numericId = objectId.split("-").pop();
        if (
          obj.objectId === numericId ||
          obj.objectId === parseInt(numericId)
        ) {
          return obj.attachments || [];
        }
      }

      // Strategy 4: Extract numeric part from objectKey and match
      if (obj.objectKey && obj.objectKey.includes("-")) {
        const keyNumericPart = obj.objectKey.split("-").pop();
        if (typeof objectId === "string" && objectId.includes("-")) {
          const idNumericPart = objectId.split("-").pop();
          if (keyNumericPart === idNumericPart) {
            return obj.attachments || [];
          }
        }
      }
    }

    return null;
  }

  /**
   * Filter objects based on command line options
   */
  filterObjects(mapping) {
    let filteredMapping = { ...mapping };

    // Filter by schema
    if (this.options.schema) {
      const filteredSchemas = {};
      Object.keys(filteredMapping).forEach((key) => {
        if (key === this.options.schema) {
          filteredSchemas[key] = filteredMapping[key];
        }
      });
      filteredMapping = filteredSchemas;
    }

    // Filter by object type
    if (this.options.type) {
      Object.keys(filteredMapping).forEach((schema) => {
        const filteredTypes = {};
        Object.keys(filteredMapping[schema]).forEach((type) => {
          if (
            type === this.options.type ||
            type.endsWith(`/${this.options.type}`)
          ) {
            filteredTypes[type] = filteredMapping[schema][type];
          }
        });
        filteredMapping[schema] = filteredTypes;
      });
    }

    return filteredMapping;
  }

  /**
   * Process a single object
   */
  async processObject(schema, objectType, dcObjectId, cloudObject) {
    this.stats.totalObjects++;

    console.log(
      `\n📦 Processing object ${cloudObject.label || cloudObject.cloudKey || cloudObject.cloudId}...`,
    );
    console.log(
      `   Schema: ${schema}, Type: ${objectType}, DC ID: ${dcObjectId}, Cloud ID: ${cloudObject.cloudId}`,
    );

    try {
      // Try to load attachments from new location first
      const attachmentData = this.loadAttachmentData(schema, objectType);
      let attachments = null;
      let dcObject = null;

      if (attachmentData) {
        // New structure: separate attachments.json file
        console.log("   📂 Using new attachment structure");
        attachments = this.findAttachmentsForObject(attachmentData, dcObjectId);

        // Create a minimal dcObject structure for compatibility
        if (attachments && attachments.length > 0) {
          dcObject = {
            id: dcObjectId,
            objectKey: dcObjectId,
            attachments: attachments,
          };
        }
      } else {
        // Fallback to old structure: attachments in objects.json
        console.log("   📂 Falling back to old attachment structure");
        dcObject = this.loadDatacenterObject(schema, objectType, dcObjectId);

        if (!dcObject) {
          console.log("   ⚠️  Datacenter object not found, skipping");
          this.stats.skippedObjects++;
          return;
        }

        attachments = dcObject.attachments;
      }

      // Check if object has attachments
      if (!attachments || attachments.length === 0) {
        console.log("   ⏭️  No attachments found, skipping");
        this.stats.skippedObjects++;
        return;
      }

      // Check if any attachments have local file paths
      const attachmentsWithFiles = attachments.filter((att) => {
        if (!att.localFilePath) return false;
        // Resolve path relative to datacenterPath
        const absolutePath = path.join(this.datacenterPath, att.localFilePath);
        return fs.existsSync(absolutePath);
      });

      if (attachmentsWithFiles.length === 0) {
        console.log("   ⚠️  No local attachment files found, skipping");
        this.stats.skippedObjects++;
        return;
      }

      console.log(
        `   📎 Found ${attachmentsWithFiles.length} attachment(s) with local files`,
      );
      this.stats.objectsWithAttachments++;

      if (this.options.dryRun) {
        console.log("   🔍 DRY RUN - Would upload:");
        attachmentsWithFiles.forEach((att) => {
          const absolutePath = path.join(
            this.datacenterPath,
            att.localFilePath,
          );
          const fileSize = fs.statSync(absolutePath).size;
          const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
          console.log(
            `     • ${att.filename} (${fileSizeMB} MB) from ${att.localFilePath}`,
          );
        });
      } else {
        // Update dcObject with filtered attachments for upload
        dcObject.attachments = attachmentsWithFiles;

        // Upload attachments - AttachmentUploader expects cloudObject.id, not cloudObject.cloudId
        const cloudObjectForUpload = {
          id: cloudObject.cloudId,
          key: cloudObject.cloudKey,
          label: cloudObject.name || cloudObject.cloudKey,
        };

        const result = await this.attachmentUploader.uploadAttachmentsForObject(
          dcObject,
          cloudObjectForUpload,
          null, // attachmentsDir not needed as we have localFilePath
        );

        if (result.skipped) {
          console.log(`   ⏭️  Upload skipped: ${result.reason}`);
          this.stats.skippedObjects++;
        } else {
          console.log(
            `   ✅ Upload completed: ${result.summary.successful} successful, ${result.summary.failed} failed`,
          );
          this.stats.processedObjects++;
        }
      }
    } catch (error) {
      console.log(`   ❌ Error processing object: ${error.message}`);
      this.stats.errors.push({
        schema,
        objectType,
        dcObjectId,
        cloudObjectId: cloudObject.cloudId,
        error: error.message,
      });
    }
  }

  /**
   * Scan datacenter assets to find objects with attachments
   */
  async scanForObjectsWithAttachments() {
    console.log(
      "🔍 Scanning datacenter assets for objects with attachments...",
    );
    const objectsWithAttachments = [];

    // First, scan the new attachments directory structure
    const attachmentsPath = path.join(this.datacenterPath, "attachments");
    if (fs.existsSync(attachmentsPath)) {
      console.log("  📂 Scanning new attachment structure...");
      await this.scanNewAttachmentStructure(objectsWithAttachments);
    }

    // Then, scan old structure for backward compatibility
    const schemaDirectories = fs
      .readdirSync(this.datacenterPath, { withFileTypes: true })
      .filter(
        (dirent) =>
          dirent.isDirectory() &&
          dirent.name !== "attachments" &&
          dirent.name !== "connectedTickets",
      )
      .map((dirent) => dirent.name);

    console.log("  📂 Scanning old structure (backward compatibility)...");
    for (const schema of schemaDirectories) {
      // Skip if schema filter is specified and doesn't match
      if (this.options.schema && schema !== this.options.schema) {
        continue;
      }

      console.log(`    📁 Scanning schema: ${schema}`);
      await this.scanSchemaForAttachments(schema, objectsWithAttachments);
    }

    console.log(
      `📎 Found ${objectsWithAttachments.length} objects with attachments in datacenter`,
    );
    return objectsWithAttachments;
  }

  /**
   * Scan the new attachment directory structure
   */
  async scanNewAttachmentStructure(objectsWithAttachments) {
    const attachmentsPath = path.join(this.datacenterPath, "attachments");

    // Get all schema directories in attachments
    const schemaDirectories = fs
      .readdirSync(attachmentsPath, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    for (const schema of schemaDirectories) {
      // Skip if schema filter is specified and doesn't match
      if (this.options.schema && schema !== this.options.schema) {
        continue;
      }

      console.log(`    📁 Scanning new attachment schema: ${schema}`);
      await this.scanAttachmentSchemaDirectory(
        schema,
        objectsWithAttachments,
        "",
      );
    }
  }

  /**
   * Recursively scan attachment schema directory for attachments.json files
   */
  async scanAttachmentSchemaDirectory(
    schema,
    objectsWithAttachments,
    currentPath,
  ) {
    const attachmentsPath = path.join(this.datacenterPath, "attachments");
    const schemaPath = path.join(attachmentsPath, schema);
    const fullPath = currentPath
      ? path.join(schemaPath, currentPath)
      : schemaPath;

    if (!fs.existsSync(fullPath)) {
      return;
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });

    // Check if there's an attachments.json file in this directory
    const attachmentsJsonPath = path.join(fullPath, "attachments.json");
    if (fs.existsSync(attachmentsJsonPath)) {
      const objectType = currentPath || schema;

      // Skip if type filter is specified and doesn't match
      if (this.options.type && !objectType.includes(this.options.type)) {
        return;
      }

      try {
        const attachmentData = JSON.parse(
          fs.readFileSync(attachmentsJsonPath, "utf8"),
        );

        if (attachmentData.objects && Array.isArray(attachmentData.objects)) {
          for (const obj of attachmentData.objects) {
            if (obj.attachments && obj.attachments.length > 0) {
              // Check if any attachments have local files that exist
              const validAttachments = obj.attachments.filter((att) => {
                if (!att.localFilePath) return false;
                const absolutePath = path.join(
                  this.datacenterPath,
                  att.localFilePath,
                );
                return fs.existsSync(absolutePath);
              });

              if (validAttachments.length > 0) {
                objectsWithAttachments.push({
                  schema,
                  objectType,
                  dcObjectId: obj.objectKey || obj.objectId.toString(),
                  numericId: parseInt(obj.objectId),
                  attachmentCount: validAttachments.length,
                  validAttachments,
                  source: "new", // Mark as coming from new structure
                });
              }
            }
          }
        }
      } catch (error) {
        console.log(
          `    ⚠️  Error reading ${attachmentsJsonPath}: ${error.message}`,
        );
      }
    }

    // Recursively scan subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "attachments") {
        const newPath = currentPath
          ? path.join(currentPath, entry.name)
          : entry.name;
        await this.scanAttachmentSchemaDirectory(
          schema,
          objectsWithAttachments,
          newPath,
        );
      }
    }
  }

  /**
   * Recursively scan a schema directory for objects with attachments
   */
  async scanSchemaForAttachments(
    schema,
    objectsWithAttachments,
    currentPath = "",
  ) {
    const schemaPath = path.join(this.datacenterPath, schema);
    const fullPath = currentPath
      ? path.join(schemaPath, currentPath)
      : schemaPath;

    if (!fs.existsSync(fullPath)) {
      return;
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });

    // Check if there's an objects.json file in this directory
    const objectsJsonPath = path.join(fullPath, "objects.json");
    if (fs.existsSync(objectsJsonPath)) {
      const objectType = currentPath || schema; // Use path or schema name as object type

      // Skip if type filter is specified and doesn't match
      if (this.options.type && !objectType.includes(this.options.type)) {
        return;
      }

      try {
        const objectsData = JSON.parse(
          fs.readFileSync(objectsJsonPath, "utf8"),
        );

        for (const obj of objectsData) {
          if (obj.attachments && obj.attachments.length > 0) {
            // Check if any attachments have local files that exist
            const validAttachments = obj.attachments.filter((att) => {
              if (!att.localFilePath) return false;
              // Resolve path relative to datacenterPath
              const absolutePath = path.join(
                this.datacenterPath,
                att.localFilePath,
              );
              return fs.existsSync(absolutePath);
            });

            if (validAttachments.length > 0) {
              objectsWithAttachments.push({
                schema,
                objectType,
                dcObjectId: obj.objectKey || obj.Key || obj.id.toString(),
                numericId: obj.id,
                attachmentCount: validAttachments.length,
                validAttachments,
              });
            }
          }
        }
      } catch (error) {
        console.log(
          `    ⚠️  Error reading ${objectsJsonPath}: ${error.message}`,
        );
      }
    }

    // Recursively scan subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "attachments") {
        const newPath = currentPath
          ? path.join(currentPath, entry.name)
          : entry.name;
        await this.scanSchemaForAttachments(
          schema,
          objectsWithAttachments,
          newPath,
        );
      }
    }
  }

  /**
   * Process all objects
   */
  async processObjects() {
    // First, scan for objects with attachments
    const objectsWithAttachments = await this.scanForObjectsWithAttachments();

    if (objectsWithAttachments.length === 0) {
      console.log("❌ No objects with attachments found in datacenter assets");
      return;
    }

    console.log("📂 Loading created objects mapping...");
    const mapping = this.loadObjectMapping();

    // Match objects with attachments against the mapping
    console.log(
      "🔗 Matching objects with attachments against cloud mappings...",
    );
    const matchedObjects = [];

    for (const dcObj of objectsWithAttachments) {
      const cloudObject = this.findCloudObject(
        mapping,
        dcObj.schema,
        dcObj.objectType,
        dcObj.dcObjectId,
        dcObj.numericId,
      );
      if (cloudObject) {
        matchedObjects.push({
          ...dcObj,
          cloudObject,
        });
      } else {
        console.log(
          `    ⚠️  No cloud mapping found for ${dcObj.schema}/${dcObj.objectType}/${dcObj.dcObjectId}`,
        );
      }
    }

    if (matchedObjects.length === 0) {
      console.log("❌ No objects with attachments found in cloud mappings");
      return;
    }

    console.log(
      `📊 Found ${matchedObjects.length} object(s) with attachments that exist in cloud`,
    );

    if (this.options.limit > 0 && matchedObjects.length > this.options.limit) {
      console.log(`⚠️  Limiting to first ${this.options.limit} objects`);
      matchedObjects.splice(this.options.limit);
    }

    // Process matched objects
    for (const obj of matchedObjects) {
      await this.processObject(
        obj.schema,
        obj.objectType,
        obj.dcObjectId,
        obj.cloudObject,
      );
    }

    this.generateReport();
  }

  /**
   * Find cloud object in mapping for a datacenter object
   */
  findCloudObject(mapping, schema, objectType, dcObjectId, numericId) {
    if (!mapping[schema] || !mapping[schema][objectType]) {
      return null;
    }

    const typeMapping = mapping[schema][objectType];

    // Try direct key lookup
    if (typeMapping[dcObjectId]) {
      return typeMapping[dcObjectId];
    }

    // Try numeric ID lookup
    if (numericId && typeMapping[numericId.toString()]) {
      return typeMapping[numericId.toString()];
    }

    // Try all keys in the type mapping to find a match
    for (const [key, cloudObj] of Object.entries(typeMapping)) {
      if (
        cloudObj.datacenterKey === dcObjectId ||
        cloudObj.datacenterKey === numericId?.toString() ||
        key === dcObjectId ||
        key === numericId?.toString()
      ) {
        return cloudObj;
      }
    }

    return null;
  }

  /**
   * Generate final report
   */
  generateReport() {
    console.log("\n" + "=".repeat(60));
    console.log("ATTACHMENT UPLOAD SUMMARY");
    console.log("=".repeat(60));
    console.log(`Total objects found: ${this.stats.totalObjects}`);
    console.log(
      `Objects with attachments: ${this.stats.objectsWithAttachments}`,
    );
    console.log(`Objects processed: ${this.stats.processedObjects}`);
    console.log(`Objects skipped: ${this.stats.skippedObjects}`);
    console.log(`Errors: ${this.stats.errors.length}`);

    if (!this.options.dryRun && this.stats.processedObjects > 0) {
      const uploaderStats = this.attachmentUploader.getStats();
      console.log("\nAttachment Upload Details:");
      console.log(
        `Total attachments processed: ${uploaderStats.totalAttachmentsProcessed}`,
      );
      console.log(`Successful uploads: ${uploaderStats.successfulUploads}`);
      console.log(`Failed uploads: ${uploaderStats.failedUploads}`);
      console.log(`Skipped files: ${uploaderStats.skippedFiles}`);
      console.log(`Success rate: ${uploaderStats.successRate}`);
    }

    if (this.stats.errors.length > 0) {
      console.log("\nErrors:");
      this.stats.errors.forEach((error, index) => {
        console.log(
          `${index + 1}. ${error.schema}/${error.objectType} (DC: ${error.dcObjectId}): ${error.error}`,
        );
      });
    }

    console.log("=".repeat(60));
  }
}

// Command line interface
function parseArguments() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--schema":
        options.schema = args[++i];
        break;
      case "--type":
        options.type = args[++i];
        break;
      case "--limit":
        options.limit = parseInt(args[++i]);
        break;
      case "--max-attachments":
        options.maxAttachmentsPerObject = parseInt(args[++i]);
        break;
      case "--max-size":
        options.maxFileSize = parseInt(args[++i]);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--parallel":
        options.parallel = true;
        break;
      case "--help":
        console.log(`
Standalone Attachment Upload Utility

Usage: node upload_attachments_to_existing_objects.js [options]

Options:
  --schema [name]          Process specific schema only
  --type [name]            Process specific object type only
  --limit [n]              Limit number of objects to process
  --dry-run                Show what would be processed without making changes
  --parallel               Enable parallel attachment uploads
  --max-attachments [n]    Maximum attachments per object (default: 10)
  --max-size [n]           Maximum file size in MB (default: 100)
  --help                   Show this help message

Environment Variables:
  CLOUD_BASE_URL          Jira Cloud base URL
  CLOUD_API_TOKEN         Base64 encoded API token
  WORKSPACE_ID            Assets workspace ID
  DATACENTER_PATH         Path to datacenter assets directory

Examples:
  # Dry run for all objects
  node upload_attachments_to_existing_objects.js --dry-run

  # Upload attachments for specific schema
  node upload_attachments_to_existing_objects.js --schema "Asset_Management"

  # Upload with limits
  node upload_attachments_to_existing_objects.js --schema "Asset_Management" --limit 5 --max-size 50
                `);
        process.exit(0);
        break;
    }
  }

  return options;
}

// Main execution
async function main() {
  try {
    const options = parseArguments();
    const uploader = new StandaloneAttachmentUploader(options);
    await uploader.processObjects();
  } catch (error) {
    console.error("❌ Fatal error:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = StandaloneAttachmentUploader;
