/**
 * Cloud Asset Ingestion Script
 *
 * Ingests cloud asset data from CSV files into Jira Cloud Assets.
 * Supports multiple asset types with configurable attribute mapping.
 */

// Load environment from the main asset-migration-script
require("dotenv").config({
  path: require("path").resolve(
    __dirname,
    "../../../asset-migration-script/.env",
  ),
});

const fs = require("fs");
const path = require("path");
const CloudApiClient = require("../src/cloudApiClient");
const CsvParser = require("../src/csvParser");
const AttributeMapper = require("../src/attributeMapper");

/**
 * Transform URL to sandbox URL
 * Example: your-company.atlassian.net -> your-company-sandbox.atlassian.net
 */
function getSandboxUrl(baseUrl) {
  if (!baseUrl) return baseUrl;

  // Already a sandbox URL
  if (baseUrl.includes("-sandbox")) return baseUrl;

  // Insert -sandbox before .atlassian.net
  return baseUrl.replace(/\.atlassian\.net$/, "-sandbox.atlassian.net");
}

// Default cloud assets path
const DEFAULT_CLOUD_ASSETS_PATH =
  path.resolve(__dirname, "../../../cloud_assets");

class CloudAssetIngestion {
  constructor(options = {}) {
    this.options = {
      dryRun: options.dryRun || false,
      sandbox: options.sandbox || false,
      forceProduction: options.forceProduction || false,
      schemaName: options.schema || null,
      objectTypeName: options.objectType || null,
      assetType: options.assetType || null,
      mappingFile: options.mapping || null,
      cloudAssetsPath: options.cloudAssetsPath || DEFAULT_CLOUD_ASSETS_PATH,
      limit: options.limit || 0,
      debug: options.debug || false,
      listSchemas: options.listSchemas || false,
      listObjectTypes: options.listObjectTypes || false,
    };

    this.stats = {
      startTime: null,
      endTime: null,
      recordsProcessed: 0,
      recordsCreated: 0,
      recordsFailed: 0,
      recordsSkipped: 0,
      recordsUpdated: 0,
      errors: [],
    };

    // Maps for duplicate detection
    this.existingObjectsMap = new Map();
    this.existingObjectsById = new Map();
    this.existingObjectsByKey = new Map();
    this.existingObjectsByDNS = new Map();
    this.existingObjectsByIP = new Map();
    this.existingObjectsByEmail = new Map();
    this.existingObjectsByVMId = new Map();

    // Caches for object and user reference lookups
    this.userObjectCache = new Map();
    this.objectReferenceCache = new Map();

    // Determine which environment to use
    let targetUrl = process.env.CLOUD_BASE_URL;
    let targetWorkspaceId = process.env.WORKSPACE_ID;
    let targetApiToken = process.env.CLOUD_API_TOKEN;

    // If --sandbox flag is set, automatically switch to sandbox URL
    if (this.options.sandbox) {
      const originalUrl = targetUrl;
      targetUrl = getSandboxUrl(targetUrl);

      // Check if sandbox-specific credentials exist
      if (process.env.SANDBOX_CLOUD_BASE_URL) {
        targetUrl = process.env.SANDBOX_CLOUD_BASE_URL;
      }

      // If SANDBOX_WORKSPACE_ID is provided, use it
      // Otherwise, we'll dynamically fetch it from the sandbox instance
      if (process.env.SANDBOX_WORKSPACE_ID) {
        targetWorkspaceId = process.env.SANDBOX_WORKSPACE_ID;
      } else {
        // Mark that we need to fetch workspace ID dynamically
        // This is safe because we'll fetch it from the SANDBOX instance
        targetWorkspaceId = null;
        this.needsToFetchWorkspaceId = true;

        if (process.env.DEBUG === "true") {
          console.log(
            "  ℹ️  SANDBOX_WORKSPACE_ID not set, will fetch dynamically from sandbox instance",
          );
        }
      }
      if (process.env.SANDBOX_CLOUD_API_TOKEN) {
        targetApiToken = process.env.SANDBOX_CLOUD_API_TOKEN;
      }

      // Store the transformation for logging
      this.urlTransformation = {
        original: originalUrl,
        transformed: targetUrl,
        switched: originalUrl !== targetUrl,
      };
    } else {
      this.urlTransformation = null;
    }

    // Initialize clients with potentially modified credentials
    this.cloudApiClient = new CloudApiClient(
      targetWorkspaceId,
      targetApiToken,
      targetUrl,
    );

    this.csvParser = new CsvParser();
    this.attributeMapper = new AttributeMapper(this.cloudApiClient);
  }

  /**
   * Fetch and set workspace ID dynamically from the Jira instance
   * This is called when --sandbox flag is used without SANDBOX_WORKSPACE_ID
   */
  async ensureWorkspaceId() {
    if (!this.needsToFetchWorkspaceId) {
      return; // Workspace ID already set
    }

    console.log("\n🔍 Fetching workspace ID from sandbox instance...");

    try {
      const workspaceId = await this.cloudApiClient.fetchWorkspaceId();

      // Update the client with the fetched workspace ID
      this.cloudApiClient.workspaceId = workspaceId;

      console.log(`✓ Successfully fetched workspace ID: ${workspaceId}\n`);

      // Mark as fetched so we don't fetch again
      this.needsToFetchWorkspaceId = false;
      this.fetchedWorkspaceId = workspaceId;
    } catch (error) {
      throw new Error(
        `Failed to fetch workspace ID from sandbox instance:\n${error.message}\n\n` +
          "This usually means:\n" +
          "  1. Your sandbox URL is incorrect\n" +
          "  2. Your API token doesn't have access to the sandbox\n" +
          "  3. Assets is not enabled on your sandbox instance\n\n" +
          "You can manually set SANDBOX_WORKSPACE_ID in your .env file to bypass this check.",
      );
    }
  }

  /**
   * Detect if we're running in sandbox or production environment
   */
  detectEnvironment() {
    // If --sandbox flag was used, check the transformed URL
    const baseUrl = this.urlTransformation
      ? this.urlTransformation.transformed
      : process.env.CLOUD_BASE_URL || "";
    const workspaceId =
      this.fetchedWorkspaceId ||
      process.env.SANDBOX_WORKSPACE_ID ||
      process.env.WORKSPACE_ID ||
      "";
    const sandboxMode = process.env.SANDBOX_MODE;

    // Check if --sandbox flag was used
    if (this.options.sandbox) {
      return { isSandbox: true, source: "--sandbox flag" };
    }

    // Check if SANDBOX_MODE is explicitly set
    if (sandboxMode === "true") {
      return { isSandbox: true, source: "SANDBOX_MODE env var" };
    }

    // Check URL patterns
    if (
      baseUrl.includes("-sandbox") ||
      baseUrl.includes("sandbox.") ||
      baseUrl.includes("test.") ||
      baseUrl.includes("staging.")
    ) {
      return { isSandbox: true, source: "URL pattern" };
    }

    // Check if using sandbox-specific credentials
    if (
      process.env.SANDBOX_CLOUD_BASE_URL ||
      process.env.SANDBOX_WORKSPACE_ID
    ) {
      return { isSandbox: true, source: "Sandbox credentials detected" };
    }

    // Check workspace ID patterns (if known)
    // Add your sandbox workspace IDs here
    const knownSandboxWorkspaces = [
      // Add sandbox workspace IDs here
    ];

    if (knownSandboxWorkspaces.includes(workspaceId)) {
      return { isSandbox: true, source: "Known sandbox workspace" };
    }

    // Default to production for safety
    return { isSandbox: false, source: "Unknown - assuming production" };
  }

  /**
   * Display environment warning banner
   */
  displayEnvironmentWarning() {
    const envInfo = this.detectEnvironment();
    const isProduction = !envInfo.isSandbox;

    console.log("\n" + "=".repeat(80));
    if (isProduction) {
      console.log(
        "  ⚠️  WARNING: YOU ARE RUNNING IN PRODUCTION ENVIRONMENT ⚠️",
      );
      console.log(
        "  This will modify LIVE data in your production Jira instance!",
      );
    } else {
      console.log(
        "  ✅ SANDBOX MODE: You are running in a sandbox/test environment",
      );
      console.log("  This will only modify test data in your sandbox instance");
    }
    console.log("  Environment detection source: " + envInfo.source);
    console.log("=".repeat(80) + "\n");
  }

  /**
   * Confirm production access with user
   */
  async confirmProductionAccess() {
    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(
        'Type "CONFIRM" to proceed with production access: ',
        (answer) => {
          rl.close();
          resolve(answer === "CONFIRM");
        },
      );
    });
  }

  /**
   * Run the ingestion
   */
  async run() {
    this.stats.startTime = new Date();

    // Fetch workspace ID dynamically if needed (when using --sandbox without SANDBOX_WORKSPACE_ID)
    await this.ensureWorkspaceId();

    console.log("\n🚀 Starting Cloud Asset Ingestion...\n");
    console.log(`Schema: ${this.options.schemaName}`);
    console.log(`Object Type: ${this.options.objectTypeName}`);
    console.log(`Asset Type: ${this.options.assetType}`);
    console.log(`Dry Run: ${this.options.dryRun ? "Yes" : "No"}`);
    console.log(`Sandbox Mode: ${this.options.sandbox ? "Yes" : "No"}`);

    const connected = await this.cloudApiClient.testConnection();
    if (!connected) {
      throw new Error("Failed to connect to Jira Cloud Assets");
    }

    await this.ingestAssets();

    this.stats.endTime = new Date();
    this.printSummary();
    await this.saveReport();
  }

  /**
   * Validate environment and required variables
   */
  async validateEnvironment() {
    const required = ["CLOUD_BASE_URL", "WORKSPACE_ID", "CLOUD_API_TOKEN"];
    const missing = required.filter((v) => !process.env[v]);

    if (missing.length > 0) {
      console.error("\n❌ Missing required environment variables:");
      missing.forEach((v) => console.error(`   - ${v}`));
      console.error("\nPlease set these in your .env file or environment.");
      console.error("See .env.example for reference.\n");
      process.exit(1);
    }

    // Check environment safety
    const envInfo = this.detectEnvironment();
    this.displayEnvironmentWarning();

    // If production and not forced, ask for confirmation
    if (!envInfo.isSandbox && !this.options.forceProduction) {
      const confirmed = await this.confirmProductionAccess();
      if (!confirmed) {
        console.log("\n❌ Operation cancelled by user.\n");
        process.exit(0);
      }
    }
  }

  /**
   * Execute the command
   */
  async execute() {
    const args = parseArgs();

    if (args.help) {
      printHelp();
      return;
    }

    // Always validate environment first
    await this.validateEnvironment();

    // Ensure workspace ID is available (fetches dynamically for sandbox)
    await this.ensureWorkspaceId();

    if (args.listSchemas) {
      await this.listSchemas();
      return;
    }

    if (args.listObjectTypes) {
      if (!this.options.schemaName) {
        console.error(
          "Error: --schema is required when using --list-object-types",
        );
        process.exit(1);
      }
      await this.listObjectTypes();
      return;
    }

    await this.run();
  }

  /**
   * List all available schemas
   */
  async listSchemas() {
    const schemas = await this.cloudApiClient.getSchemas();
    console.log("\n📋 Available Schemas:");
    schemas.forEach((s) => {
      console.log(`   - ${s.name} (ID: ${s.id})`);
    });
  }

  /**
   * List all object types in a schema
   */
  async listObjectTypes() {
    if (!this.options.schemaName) {
      throw new Error("Schema name is required. Use --schema flag.");
    }

    const schemas = await this.cloudApiClient.getSchemas();
    const schema = schemas.find(
      (s) => s.name.toLowerCase() === this.options.schemaName.toLowerCase(),
    );

    if (!schema) {
      throw new Error(`Schema not found: ${this.options.schemaName}`);
    }

    const objectTypes = await this.cloudApiClient.getObjectTypes(schema.id);
    console.log(`\n📦 Object Types in "${schema.name}":`);
    objectTypes.forEach((ot) => {
      console.log(`   - ${ot.name} (ID: ${ot.id})`);
    });
  }

  /**
   * Analyze CSV assets
   */
  async analyzeAssets() {
    const parsedData = await this.csvParser.parseAssetFiles(
      this.options.cloudAssetsPath,
    );

    console.log("\n📊 Asset Analysis:");
    for (const [assetType, data] of Object.entries(parsedData)) {
      console.log(`\n   ${assetType}:`);
      console.log(`      Records: ${data.length}`);
      if (data.length > 0) {
        console.log(`      Columns: ${Object.keys(data[0]).length}`);
        console.log(
          `      Sample columns: ${Object.keys(data[0]).slice(0, 5).join(", ")}...`,
        );
      }
    }
  }

  /**
   * Show mapping preview
   */
  async showMappingPreview() {
    if (!this.options.schemaName || !this.options.objectTypeName) {
      throw new Error(
        "Schema and object type are required. Use --schema and --object-type flags.",
      );
    }

    const schemas = await this.cloudApiClient.getSchemas();
    const schema = schemas.find(
      (s) => s.name.toLowerCase() === this.options.schemaName.toLowerCase(),
    );

    if (!schema) {
      throw new Error(`Schema not found: ${this.options.schemaName}`);
    }

    const objectTypes = await this.cloudApiClient.getObjectTypes(schema.id);
    const objectType = objectTypes.find(
      (ot) =>
        ot.name.toLowerCase() === this.options.objectTypeName.toLowerCase(),
    );

    if (!objectType) {
      throw new Error(`Object type not found: ${this.options.objectTypeName}`);
    }

    const attributes = await this.cloudApiClient.getObjectTypeAttributes(
      objectType.id,
    );

    console.log(`\n🔗 Mapping Preview for "${objectType.name}":\n`);

    // Try to load mapping file
    const assetType = this.options.assetType || "default";
    const data = await this.loadAssetData(assetType);
    const csvColumns = data.length > 0 ? Object.keys(data[0]) : [];

    let manualMapping = null;
    if (this.options.mappingFile) {
      try {
        const mappingContent = fs.readFileSync(
          this.options.mappingFile,
          "utf8",
        );
        manualMapping = JSON.parse(mappingContent);
        console.log(`✓ Loaded mapping from: ${this.options.mappingFile}\n`);
      } catch (error) {
        console.warn(
          `⚠️  Warning: Could not load mapping file: ${error.message}`,
        );
      }
    }

    const mapping = await this.attributeMapper.generateMapping(
      csvColumns,
      attributes,
      assetType,
      manualMapping,
    );
    const unmapped = [];

    // Show mapped attributes
    console.log("Mapped Attributes:");
    for (const attr of attributes) {
      const typeName =
        attr.attachmentSchemaTypes?.length > 0
          ? ` [${attr.attachmentSchemaTypes[0]}]`
          : "";
      const mapped = mapping.find((m) => m.attributeId === attr.id);
      if (mapped) {
        console.log(`  ✓ ${attr.name}${typeName} <- ${mapped.csvColumn}`);
      } else {
        unmapped.push(attr);
      }
    }

    // Show unmapped attributes
    if (unmapped.length > 0) {
      console.log("\nUnmapped Attributes:");
      unmapped.forEach((attr) => {
        console.log(`  ✗ ${attr.name}`);
      });
    }

    const marker = this.options.debug ? "Debug" : "";
  }

  /**
   * Ingest assets from CSV files
   */
  async ingestAssets() {
    if (!this.options.schemaName || !this.options.objectTypeName) {
      throw new Error(
        "Schema and object type are required. Use --schema and --object-type flags.",
      );
    }

    console.log("\n📥 Loading CSV data...");

    const parsedData = this.csvParser.parseDirectory(
      this.options.cloudAssetsPath,
    );

    const schemas = await this.cloudApiClient.getSchemas();
    const schema = schemas.find(
      (s) => s.name.toLowerCase() === this.options.schemaName.toLowerCase(),
    );

    if (!schema) {
      throw new Error(`Schema not found: ${this.options.schemaName}`);
    }

    const objectTypes = await this.cloudApiClient.getObjectTypes(schema.id);
    const objectType = objectTypes.find(
      (ot) =>
        ot.name.toLowerCase() === this.options.objectTypeName.toLowerCase(),
    );

    if (!objectType) {
      throw new Error(`Object type not found: ${this.options.objectTypeName}`);
    }

    console.log(
      `✓ Found object type: ${objectType.name} (ID: ${objectType.id})`,
    );

    const attributes = await this.cloudApiClient.getObjectTypeAttributes(
      objectType.id,
    );

    const assetType = this.options.assetType || "default";
    const parsedEntry = parsedData[assetType];

    if (
      !parsedEntry ||
      !parsedEntry.records ||
      parsedEntry.records.length === 0
    ) {
      console.warn(`⚠️  No data found for asset type: ${assetType}`);
      console.warn(
        `    Available asset types: ${Object.keys(parsedData).join(", ")}`,
      );
      return;
    }

    const data = parsedEntry.records;
    console.log(`✓ Loaded ${data.length} records from CSV\n`);

    // Query existing objects for duplicate detection
    console.log("🔍 Querying existing objects for duplicate detection...");
    await this.queryExistingObjects(objectType.id);
    console.log(`✓ Found ${this.existingObjectsMap.size} existing objects\n`);

    // Load mapping
    let manualMapping = null;
    let fullMappingConfig = null;

    // First, try to auto-load mapping.json from the script directory
    const defaultMappingPath = path.join(__dirname, "..", "mapping.json");
    if (fs.existsSync(defaultMappingPath)) {
      try {
        const mappingContent = fs.readFileSync(defaultMappingPath, "utf8");
        fullMappingConfig = JSON.parse(mappingContent);

        // Check if mapping has per-asset-type sections
        if (fullMappingConfig[assetType]) {
          manualMapping = fullMappingConfig[assetType];
          console.log(
            `✓ Auto-loaded mapping for asset type "${assetType}" from: mapping.json`,
          );
        } else if (fullMappingConfig["default"]) {
          manualMapping = fullMappingConfig["default"];
          console.log(`✓ Auto-loaded default mapping from: mapping.json`);
        } else if (!fullMappingConfig._comment && !fullMappingConfig._usage) {
          // Legacy flat format (no asset type sections)
          manualMapping = fullMappingConfig;
          console.log(`✓ Auto-loaded mapping from: mapping.json (flat format)`);
        } else {
          console.warn(
            `⚠️  No mapping section found for asset type "${assetType}" in mapping.json`,
          );
          console.warn(
            `    Available sections: ${Object.keys(fullMappingConfig)
              .filter((k) => !k.startsWith("_"))
              .join(", ")}`,
          );
        }
      } catch (error) {
        console.warn(
          `⚠️  Warning: Could not auto-load mapping.json: ${error.message}`,
        );
      }
    }

    // Then, check for explicit mapping file override
    if (this.options.mappingFile) {
      try {
        const mappingContent = fs.readFileSync(
          this.options.mappingFile,
          "utf8",
        );
        const parsedMapping = JSON.parse(mappingContent);
        // Check for per-asset-type section in explicit mapping too
        manualMapping =
          parsedMapping[assetType] || parsedMapping["default"] || parsedMapping;
        console.log(`✓ Loaded mapping from: ${this.options.mappingFile}`);
      } catch (error) {
        console.warn(
          `⚠️  Warning: Could not load mapping file: ${error.message}`,
        );
      }
    }

    // Extract special mapping config (status mapping, owner lookup)
    if (manualMapping) {
      this.statusMapping = manualMapping._statusMapping || null;
      this.ownerLookupConfig = manualMapping._ownerLookup || null;
      this.excludeFilter = manualMapping._excludeFilter || null;

      if (this.statusMapping) {
        const firstVal = Object.values(this.statusMapping)[0];
        if (typeof firstVal === "object") {
          for (const [attrName, attrMap] of Object.entries(
            this.statusMapping,
          )) {
            console.log(
              `✓ Status mapping [${attrName}]: ${Object.entries(attrMap)
                .map(([k, v]) => k + " -> " + v)
                .join(", ")}`,
            );
          }
        } else {
          console.log(
            `✓ Status value mapping loaded: ${Object.keys(this.statusMapping).join(", ")} -> ${[...new Set(Object.values(this.statusMapping))].join(", ")}`,
          );
        }
      }
      if (this.ownerLookupConfig) {
        console.log(
          `✓ Owner lookup configured: ${this.ownerLookupConfig.csvColumn} -> ${this.ownerLookupConfig.targetAttribute} (via OT:${this.ownerLookupConfig.lookupObjectTypeId})`,
        );
      }
    }

    console.log("");
    console.log("🔗 Generating attribute mapping...");
    const mapping = await this.attributeMapper.generateMapping(
      Object.keys(data[0]),
      attributes,
      assetType,
      manualMapping,
    );
    const unmapped = [];

    // Validate mapping
    for (const attr of attributes) {
      const mapped = mapping.find((m) => m.attributeId === attr.id);
      if (!mapped && !attr.optional) {
        unmapped.push(attr);
      }
    }

    if (unmapped.length > 0) {
      console.warn("\n⚠️  Warning: Some required attributes are not mapped:");
      unmapped.forEach((attr) => {
        console.warn(`     - ${attr.name}`);
      });
      console.warn("");
    }

    // Process records
    console.log("📝 Processing records...\n");

    let records = data;

    // Apply exclude filter if configured
    if (this.excludeFilter) {
      const col = this.excludeFilter.column;
      const prefix = this.excludeFilter.startsWith;
      const before = records.length;
      records = records.filter((r) => {
        const val = r[col] || "";
        return !val.startsWith(prefix);
      });
      console.log(
        `✓ Exclude filter: removed ${before - records.length} records where "${col}" starts with "${prefix}" (${records.length} remaining)`,
      );
    }

    if (this.options.limit > 0) {
      records = records.slice(0, this.options.limit);
    }

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      this.stats.recordsProcessed++;

      if (this.options.dryRun) {
        console.log(
          `   [DRY RUN] Would process record ${i + 1}/${records.length}`,
        );
        continue;
      }

      try {
        // Check for existing object
        const existingObject = this.findMatchingObject(record, mapping);

        if (existingObject) {
          // Update existing object
          await this.updateObject(
            existingObject,
            record,
            mapping,
            objectType.id,
          );
        } else {
          // Create new object
          await this.createObject(record, mapping, objectType.id);
        }

        if ((i + 1) % 10 === 0) {
          console.log(`   Processed ${i + 1}/${records.length} records...`);
        }
      } catch (error) {
        this.stats.recordsFailed++;
        this.stats.errors.push({
          record: i + 1,
          error: error.message,
          data: record,
        });
        console.error(
          `   ❌ Error processing record ${i + 1}: ${error.message}`,
        );
      }
    }
  }

  /**
   * Create a new object
   */
  async createObject(record, mapping, objectTypeId) {
    const attributes = [];

    for (const map of mapping) {
      const value = record[map.csvColumn];
      if (value === undefined || value === null || value === "") {
        continue;
      }

      const convertedValue = await this.convertValue(
        value,
        map.attributeType,
        map.attributeId,
        map.attributeName,
        map.referenceObjectTypeId,
      );

      attributes.push({
        objectTypeAttributeId: map.attributeId,
        objectAttributeValues: [
          {
            value: convertedValue,
          },
        ],
      });
    }

    // Handle owner lookup if configured (looks up User Directory object by email)
    if (this.ownerLookupConfig) {
      const emailColumn = this.ownerLookupConfig.csvColumn;
      const targetAttrName = this.ownerLookupConfig.targetAttribute;
      const email = record[emailColumn];

      if (email) {
        // Find the target attribute in the cloud attributes
        const targetAttr = mapping.find(
          (m) => m.attributeName === targetAttrName,
        );
        if (!targetAttr) {
          // Attribute not in mapping yet, need to find it from cloud attributes
          const allAttrs =
            await this.cloudApiClient.getObjectTypeAttributes(objectTypeId);
          const ownerAttr = allAttrs.find((a) => a.name === targetAttrName);
          if (ownerAttr) {
            const ownerKey = await this.lookupOwnerByEmail(email, record);
            if (ownerKey) {
              attributes.push({
                objectTypeAttributeId: ownerAttr.id,
                objectAttributeValues: [{ value: ownerKey }],
              });
            }
          }
        } else {
          // Owner attribute is already in mapping, but we need to set it from the email column
          const ownerKey = await this.lookupOwnerByEmail(email, record);
          if (ownerKey) {
            // Check if already set from normal mapping, replace it
            const existingIdx = attributes.findIndex(
              (a) => a.objectTypeAttributeId === targetAttr.attributeId,
            );
            if (existingIdx >= 0) {
              attributes[existingIdx].objectAttributeValues = [
                { value: ownerKey },
              ];
            } else {
              attributes.push({
                objectTypeAttributeId: targetAttr.attributeId,
                objectAttributeValues: [{ value: ownerKey }],
              });
            }
          }
        }
      }
    }

    const objectData = {
      objectTypeId: objectTypeId,
      attributes: attributes,
    };

    // Extract display name using mapping to find the Name attribute
    const nameMap = mapping.find((m) => m.attributeName === "Name");
    const displayName = nameMap
      ? record[nameMap.csvColumn] || "Unnamed Object"
      : record["Name"] || record["VM"] || "Unnamed Object";

    if (this.options.dryRun) {
      console.log(`   [DRY RUN] Would create: ${displayName}`);
      return null;
    }

    const result = await this.cloudApiClient.createObject(objectData);

    if (result && !result.error) {
      this.stats.recordsCreated++;
      if (this.options.debug) {
        console.log(`   ✓ Created: ${displayName}`);
      }
      // Add to existing objects map to prevent duplicates within the same run
      const normalizedName = displayName.toLowerCase().trim();
      if (!this.existingObjectsMap.has(normalizedName)) {
        this.existingObjectsMap.set(normalizedName, result);
      }
      if (result.objectKey) {
        this.existingObjectsByKey.set(result.objectKey, result);
      }
    } else {
      throw new Error(result?.error?.message || "Unknown error");
    }

    return result;
  }

  /**
   * Convert value based on attribute type
   */
  async convertValue(
    value,
    attributeType,
    attributeId,
    attributeName,
    referenceObjectTypeId,
  ) {
    if (value === null || value === undefined) {
      return null;
    }

    const strValue = String(value);

    switch (attributeType) {
      case 0: // Text
        return strValue;

      case 1: // Object reference
        // Look up object by name in the referenced object type
        const objectKey = await this.lookupObjectId(
          strValue,
          attributeId,
          referenceObjectTypeId,
        );
        return objectKey;

      case 2: // User reference
        // Look up Jira user by email
        const accountId = await this.lookupUserAccountId(strValue);
        return accountId;

      case 3: // Date
        return strValue;

      case 4: // Integer
        return parseInt(strValue, 10) || 0;

      case 5: // Float
        // Handle European comma decimal separator
        return parseFloat(strValue.replace(",", ".")) || 0;

      case 6: // Select
        return strValue;

      case 7: // Status
        // Apply status value mapping if configured
        if (this.statusMapping) {
          // Check for per-attribute mapping first (e.g. { "PowerState": { "poweredOn": "POWEREDON" } })
          const attrMapping = attributeName
            ? this.statusMapping[attributeName]
            : null;
          if (attrMapping && typeof attrMapping === "object") {
            const mapped =
              attrMapping[strValue] ||
              attrMapping[strValue.toUpperCase()] ||
              attrMapping[strValue.toLowerCase()];
            if (mapped) {
              if (this.options.debug) {
                console.log(
                  `      Status mapping [${attributeName}]: "${strValue}" -> "${mapped}"`,
                );
              }
              return mapped;
            }
          }

          // Fall back to flat/global mapping (e.g. { "CONNECTED": "Running" })
          const globalMapped =
            this.statusMapping[strValue] ||
            this.statusMapping[strValue.toUpperCase()];
          if (globalMapped && typeof globalMapped === "string") {
            if (this.options.debug) {
              console.log(
                `      Status mapping: "${strValue}" -> "${globalMapped}"`,
              );
            }
            return globalMapped;
          }

          if (this.options.debug) {
            console.log(
              `      Status mapping: no mapping for "${strValue}" on ${attributeName || "unknown"}, using as-is`,
            );
          }
        }
        return strValue;

      default:
        return strValue;
    }
  }

  /**
   * Look up a User Directory object by email via AQL.
   * Falls back to partial email match, then name match.
   * Returns the object key (e.g. "UD-12345") for use as an object reference value.
   */
  async lookupOwnerByEmail(email, record) {
    if (!email) return null;

    const cacheKey = `owner:${email.toLowerCase()}`;
    if (this.objectReferenceCache.has(cacheKey)) {
      return this.objectReferenceCache.get(cacheKey);
    }

    const config = this.ownerLookupConfig;
    if (!config) return null;

    try {
      // Strategy 1: Exact email match
      const escapedEmail = email.replace(/"/g, '\\"');
      const aqlQuery = `objectTypeId = ${config.lookupObjectTypeId} AND "${config.lookupByAttribute}" = "${escapedEmail}"`;

      if (this.options.debug) {
        console.log(`      Owner lookup AQL: ${aqlQuery}`);
      }

      const response = await this.cloudApiClient.executeAQL(
        aqlQuery,
        0,
        1,
        true,
      );
      const entries = response?.values || [];

      if (entries.length > 0) {
        const objectKey = entries[0].objectKey || entries[0].key;
        if (this.options.debug) {
          console.log(
            `      Owner found by email: ${entries[0].label} (${objectKey})`,
          );
        }
        this.objectReferenceCache.set(cacheKey, objectKey);
        return objectKey;
      }

      // Strategy 2: Partial email match (email prefix before @)
      const emailPrefix = email.split("@")[0].replace(/"/g, '\\"');
      const partialAql = `objectTypeId = ${config.lookupObjectTypeId} AND "${config.lookupByAttribute}" like "${emailPrefix}"`;

      if (this.options.debug) {
        console.log(`      Owner fallback (partial email): ${partialAql}`);
      }

      const partialResponse = await this.cloudApiClient.executeAQL(
        partialAql,
        0,
        5,
        true,
      );
      const partialEntries = partialResponse?.values || [];

      if (partialEntries.length === 1) {
        const objectKey = partialEntries[0].objectKey || partialEntries[0].key;
        if (this.options.debug) {
          console.log(
            `      Owner found by partial email: ${partialEntries[0].label} (${objectKey})`,
          );
        }
        this.objectReferenceCache.set(cacheKey, objectKey);
        return objectKey;
      }

      // Strategy 3: Match by name (using Owner or UserFullName from CSV)
      const ownerName = record?.Owner || record?.UserFullName || null;
      if (ownerName) {
        const escapedName = ownerName.replace(/"/g, '\\"');
        const nameAql = `objectTypeId = ${config.lookupObjectTypeId} AND Name = "${escapedName}"`;

        if (this.options.debug) {
          console.log(`      Owner fallback (name): ${nameAql}`);
        }

        const nameResponse = await this.cloudApiClient.executeAQL(
          nameAql,
          0,
          5,
          true,
        );
        const nameEntries = nameResponse?.values || [];

        if (nameEntries.length >= 1) {
          // If multiple matches, try to disambiguate by email prefix
          let best = nameEntries[0];
          if (nameEntries.length > 1) {
            const emailParts = emailPrefix.split(/[._-]/);
            const emailMatch = nameEntries.find((entry) => {
              const entryEmail =
                entry.attributes?.find(
                  (a) => a.objectTypeAttributeId === "1484",
                )?.objectAttributeValues?.[0]?.value || "";
              return emailParts.every((part) =>
                entryEmail.toLowerCase().includes(part.toLowerCase()),
              );
            });
            if (emailMatch) best = emailMatch;
          }

          const objectKey = best.objectKey || best.key;
          if (this.options.debug) {
            console.log(
              `      Owner found by name: ${best.label} (${objectKey})`,
            );
          }
          this.objectReferenceCache.set(cacheKey, objectKey);
          return objectKey;
        }
      }

      if (this.options.debug) {
        console.log(
          `      Owner not found for: ${email} / ${ownerName || "no name"}`,
        );
      }
    } catch (error) {
      if (this.options.debug) {
        console.warn(
          `      Warning: Owner lookup failed for "${email}": ${error.message}`,
        );
      }
    }

    return null;
  }

  /**
   * Query existing objects for duplicate detection
   */
  async queryExistingObjects(objectTypeId) {
    const aqlQuery = `objectTypeId = ${objectTypeId}`;
    let allObjects = [];
    let startAt = 0;
    const maxResults = 100;
    let pageCount = 0;

    try {
      while (pageCount < 1000) {
        const response = await this.cloudApiClient.executeAQL(
          aqlQuery,
          startAt,
          maxResults,
          true,
        );

        if (!response) {
          console.warn("   Warning: No response from AQL query");
          break;
        }

        if (response.error) {
          console.warn(
            `   Warning: AQL query returned error: ${response.error}`,
          );
          break;
        }

        const entries = response.values || [];
        allObjects = allObjects.concat(entries);

        if (response.isLast || entries.length === 0) {
          break;
        }

        startAt += maxResults;
        pageCount++;

        if (pageCount % 5 === 0) {
          console.log(`   Fetched ${allObjects.length} objects so far...`);
        }
      }
    } catch (error) {
      console.error(`   Error querying existing objects: ${error.message}`);
      return;
    }

    // Build lookup maps
    for (const obj of allObjects) {
      // Map by object key
      if (obj.objectKey) {
        this.existingObjectsByKey.set(obj.objectKey, obj);
      }

      // Map by label/name (primary)
      if (obj.label) {
        const label = obj.label;
        const normalizedLabel = label.toLowerCase().trim();
        if (!this.existingObjectsMap.has(normalizedLabel)) {
          this.existingObjectsMap.set(normalizedLabel, obj);
        }
      }

      // Map by object ID
      if (obj.id) {
        this.existingObjectsById.set(String(obj.id), obj);
      }

      // Extract attributes for additional lookups
      if (obj.attributes && Array.isArray(obj.attributes)) {
        for (const attr of obj.attributes) {
          const key = attr.objectTypeAttributeId;

          // DNS Name
          if (
            attr.attributeName &&
            attr.attributeName.toLowerCase().includes("dns")
          ) {
            const value = attr.objectAttributeValues?.[0]?.value;
            if (value) {
              const normalizedDNS = value.toLowerCase().trim();
              this.existingObjectsByDNS.set(normalizedDNS, obj);
            }
          }

          // IP Address
          if (
            attr.attributeName &&
            attr.attributeName.toLowerCase().includes("ip")
          ) {
            const value = attr.objectAttributeValues?.[0]?.value;
            if (value) {
              const normalizedIP = value.toLowerCase().trim();
              this.existingObjectsByIP.set(normalizedIP, obj);
            }
          }

          // Email
          if (
            attr.attributeName &&
            attr.attributeName.toLowerCase().includes("email")
          ) {
            const value = attr.objectAttributeValues?.[0]?.value;
            if (value) {
              const normalizedEmail = value.toLowerCase().trim();
              this.existingObjectsByEmail.set(normalizedEmail, obj);
            }
          }

          // VM ID (try to find by common attribute names)
          const attrId = attr.objectTypeAttributeId;
          const attrName = attr.attributeName?.toLowerCase() || "";
          if (
            attrName.includes("vm id") ||
            attrName.includes("vmid") ||
            attrName.includes("id") ||
            attrName.includes("mo ref")
          ) {
            const value = attr.objectAttributeValues?.[0]?.value;
            if (value) {
              const normalizedVMId = value.toLowerCase().trim();
              this.existingObjectsByVMId.set(normalizedVMId, obj);
            }
          }
        }
      }
    }
  }

  /**
   * Find matching object using multiple strategies
   */
  findMatchingObject(record, mapping) {
    // Strategy 1: Match by Name field (use mapping to find the CSV column for "Name" attribute)
    const nameMapping = mapping.find(
      (m) => m.attributeName === "Name" || m.attributeName === "name",
    );
    const nameCsvColumn = nameMapping?.csvColumn;
    const nameValue = nameCsvColumn
      ? record[nameCsvColumn]
      : record["Name"] || record["name"] || record["VM"];
    if (nameValue) {
      const normalizedKey = nameValue.toLowerCase().trim();
      const matched = this.existingObjectsMap.get(normalizedKey);
      if (matched) {
        if (this.options.debug) {
          console.log(`      → Matched by Name: ${nameValue}`);
        }
        return matched;
      }
    }

    // Strategy 2: Match by VM ID
    const vmIdValue =
      record["VM ID"] ||
      record["VMID"] ||
      record["Id"] ||
      record["ID"] ||
      record["MoRef"] ||
      record["Moref"];
    if (vmIdValue) {
      const normalizedKey = vmIdValue.toLowerCase().trim();
      const matched = this.existingObjectsByVMId.get(normalizedKey);
      if (matched) {
        if (this.options.debug) {
          console.log(`      → Matched by VM ID: ${vmIdValue}`);
        }
        return matched;
      }
    }

    // Strategy 3: Match by Object Key (if provided in CSV)
    const matched = record["Object Key"] || record["ObjectKey"];
    if (matched) {
      const obj = this.existingObjectsByKey.get(matched);
      if (obj) {
        if (this.options.debug) {
          console.log(`      → Matched by Object Key: ${matched}`);
        }
        return obj;
      }
    }

    // Strategy 4: Match by DNS Name
    const dnsValue = record["DNS Name"] || record["DNS"] || record["Dns Name"];
    if (dnsValue) {
      const normalizedKey = dnsValue.toLowerCase().trim();
      const matched = this.existingObjectsByDNS.get(normalizedKey);
      if (matched) {
        if (this.options.debug) {
          console.log(`      → Matched by DNS: ${dnsValue}`);
        }
        return matched;
      }
    }

    // Strategy 5: Match by IP Address
    const ipValue =
      record["IP Address"] ||
      record["IP"] ||
      record["IpAddress"] ||
      record["IP address"];
    if (ipValue) {
      const normalizedKey = ipValue.toLowerCase().trim();
      const matched = this.existingObjectsByIP.get(normalizedKey);
      if (matched) {
        if (this.options.debug) {
          console.log(`      → Matched by IP: ${ipValue}`);
        }
        return matched;
      }
    }

    // Strategy 6: Match by Email
    const emailValue =
      record["Email"] ||
      record["E-mail"] ||
      record["EmailAddress"] ||
      record["Email Address"];
    if (emailValue) {
      const normalizedKey = emailValue.toLowerCase().trim();
      const matched = this.existingObjectsByEmail.get(normalizedKey);
      if (matched) {
        if (this.options.debug) {
          console.log(`      → Matched by Email: ${emailValue}`);
        }
        return matched;
      }
    }

    return null;
  }

  /**
   * Detect changes between existing object and new record
   */
  async detectChanges(existingObject, record, mapping, attributes) {
    const changes = [];
    const existingAttributes = new Map();

    // Build map of existing attribute values
    if (existingObject.attributes) {
      for (const attr of existingObject.attributes) {
        existingAttributes.set(attr.objectTypeAttributeId, attr);
      }
    }

    // Check each mapped attribute for changes
    for (const map of mapping) {
      const rawValue = record[map.csvColumn];

      if (rawValue === undefined || rawValue === null || rawValue === "") {
        continue;
      }

      const existingValue = existingAttributes.get(map.attributeId);

      // Apply the same conversion that would be used on create/update
      // so we compare apples to apples (e.g. "PROVISIONED" -> "INACTIVE")
      const convertedValue = await this.convertValue(
        rawValue,
        map.attributeType,
        map.attributeId,
        map.attributeName,
        map.referenceObjectTypeId,
      );

      // Skip if conversion returned null (e.g. unresolved object reference)
      if (convertedValue === null || convertedValue === undefined) {
        continue;
      }

      // For status/object-ref attrs, value can be undefined while displayValue has the text
      const existingStored =
        existingValue?.objectAttributeValues?.[0]?.value ??
        existingValue?.objectAttributeValues?.[0]?.displayValue;
      const normalizedNew = this.normalizeValueForComparison(convertedValue);
      const normalizedExisting =
        this.normalizeValueForComparison(existingStored);

      if (normalizedNew !== normalizedExisting) {
        const change = {
          csvColumn: map.csvColumn,
          attributeName: map.attributeName,
          attributeId: map.attributeId,
          oldValue: existingStored,
          newValue: convertedValue, // already converted
          attributeType: map.attributeType,
          alreadyConverted: true,
        };
        if (map.referenceObjectTypeId) {
          change.referenceObjectTypeId = map.referenceObjectTypeId;
        }
        changes.push(change);
      }
    }

    return changes;
  }

  normalizeValueForComparison(value) {
    if (value === null || value === undefined) return "";
    return String(value).toLowerCase().trim();
  }

  normalizeString(str) {
    if (!str) return "";
    return str.toLowerCase().trim();
  }

  /**
   * Look up object ID by name or key
   */
  async lookupObjectId(value, attributeId, referenceObjectTypeId) {
    const cacheKey = `${attributeId}:${value}`;

    if (this.objectReferenceCache.has(cacheKey)) {
      return this.objectReferenceCache.get(cacheKey);
    }

    // If no referenced object type, we can't look up
    if (!referenceObjectTypeId) {
      if (this.options.debug) {
        console.warn(
          `      Warning: No referenceObjectTypeId for attribute ${attributeId}, cannot look up "${value}"`,
        );
      }
      return null;
    }

    // Search via AQL using the referenced object type
    try {
      const escapedValue = value.replace(/"/g, '\\"');
      const aqlQuery = `objectType = ${referenceObjectTypeId} AND Name = "${escapedValue}"`;

      if (this.options.debug) {
        console.log(`      Object ref lookup: ${aqlQuery}`);
      }

      const response = await this.cloudApiClient.executeAQL(
        aqlQuery,
        0,
        1,
        true,
      );

      if (response && response.values && response.values.length > 0) {
        const object = response.values[0];
        const objectKey = object.objectKey || object.key || object.id;
        if (this.options.debug) {
          console.log(
            `      Object ref found: ${object.label || value} (${objectKey})`,
          );
        }
        this.objectReferenceCache.set(cacheKey, objectKey);
        return objectKey;
      }

      if (this.options.debug) {
        console.warn(
          `      Warning: No object found for "${value}" in object type ${referenceObjectTypeId}`,
        );
      }
    } catch (error) {
      if (this.options.debug) {
        console.warn(
          `      Warning: Could not look up object reference "${value}": ${error.message}`,
        );
      }
    }

    return null;
  }

  /**
   * Look up Jira user account ID by email
   */
  async lookupUserAccountId(email) {
    if (!email) return null;

    const cacheKey = email.toLowerCase();

    if (this.userObjectCache.has(cacheKey)) {
      return this.userObjectCache.get(cacheKey);
    }

    try {
      const jiraUser = await this.cloudApiClient.searchJiraUser(email);

      if (jiraUser && jiraUser.accountId) {
        this.userObjectCache.set(cacheKey, jiraUser.accountId);
        return jiraUser.accountId;
      }
    } catch (error) {
      if (this.options.debug) {
        console.warn(
          `      Warning: Could not look up user "${email}": ${error.message}`,
        );
      }
    }

    return null;
  }

  /**
   * Update an existing object
   */
  async updateObject(existingObject, record, mapping, objectTypeId) {
    // Detect changes
    const attributes =
      await this.cloudApiClient.getObjectTypeAttributes(objectTypeId);
    const changes = await this.detectChanges(
      existingObject,
      record,
      mapping,
      attributes,
    );

    if (changes.length === 0) {
      this.stats.recordsSkipped++;
      if (this.options.debug) {
        const displayName = existingObject.label || existingObject.objectKey;
        console.log(`   ⊘ No changes: ${displayName}`);
      }
      return null;
    }

    // Build update payload
    const displayName = existingObject.label || existingObject.objectKey;
    const updateAttributes = [];

    for (const change of changes) {
      // Values are already converted in detectChanges
      const convertedValue = change.alreadyConverted
        ? change.newValue
        : await this.convertValue(
            change.newValue,
            change.attributeType,
            change.attributeId,
            change.attributeName,
            change.referenceObjectTypeId,
          );

      updateAttributes.push({
        objectTypeAttributeId: change.attributeId,
        objectAttributeValues: [
          {
            value: convertedValue,
          },
        ],
      });
    }

    // Handle owner lookup if configured (looks up User Directory object by email)
    if (this.ownerLookupConfig) {
      const emailColumn = this.ownerLookupConfig.csvColumn;
      const targetAttrName = this.ownerLookupConfig.targetAttribute;
      const email = record[emailColumn];

      if (email) {
        const ownerAttr = attributes.find((a) => a.name === targetAttrName);
        if (ownerAttr) {
          const ownerKey = await this.lookupOwnerByEmail(email, record);
          if (ownerKey) {
            // Check if this attribute is already in updates
            const existingIdx = updateAttributes.findIndex(
              (a) => String(a.objectTypeAttributeId) === String(ownerAttr.id),
            );
            if (existingIdx >= 0) {
              updateAttributes[existingIdx].objectAttributeValues = [
                { value: ownerKey },
              ];
            } else {
              updateAttributes.push({
                objectTypeAttributeId: ownerAttr.id,
                objectAttributeValues: [{ value: ownerKey }],
              });
            }
          }
        }
      }
    }

    const objectData = {
      objectTypeId: objectTypeId,
      attributes: updateAttributes,
    };

    if (this.options.dryRun) {
      console.log(
        `   [DRY RUN] Would update: ${displayName} (${changes.length} changes)`,
      );
      return null;
    }

    const result = await this.cloudApiClient.updateObject(
      existingObject.id,
      objectData,
    );

    if (result && !result.error) {
      this.stats.recordsUpdated++;
      if (this.options.debug) {
        console.log(`   ✓ Updated: ${displayName} (${changes.length} changes)`);
      }
    } else {
      this.stats.errors.push({
        record: displayName,
        error: result?.error?.message || "Unknown error",
        data: record,
      });
      throw new Error(result?.error?.message || "Unknown error");
    }

    return result;
  }

  /**
   * Print summary statistics
   */
  printSummary() {
    const duration = this.stats.endTime - this.stats.startTime;
    const durationStr = Math.round(duration / 1000) + "s";

    console.log("\n" + "=".repeat(80));
    console.log("📊 INGESTION SUMMARY");
    console.log("=".repeat(80));
    console.log(`Duration: ${durationStr}`);
    console.log(`Records Processed: ${this.stats.recordsProcessed}`);
    console.log(`Records Created: ${this.stats.recordsCreated}`);
    console.log(`Records Updated: ${this.stats.recordsUpdated}`);
    console.log(`Records Failed: ${this.stats.recordsFailed}`);
    console.log(`Records Skipped: ${this.stats.recordsSkipped}`);

    const apiStats = this.cloudApiClient.getStats();
    console.log(`\nAPI Requests: ${apiStats.totalRequests}`);
    console.log(`API Errors: ${apiStats.totalErrors}`);
    console.log(`Error Rate: ${apiStats.errorRate}`);

    if (this.stats.errors.length > 0) {
      console.log("\n❌ Errors:");
      this.stats.errors.slice(0, 5).forEach((err, i) => {
        console.log(`   ${i + 1}. Record ${err.record}: ${err.error}`);
      });
      if (this.stats.errors.length > 5) {
        console.log(`   ... and ${this.stats.errors.length - 5} more errors`);
      }
    }

    console.log("=".repeat(80) + "\n");
  }

  /**
   * Save detailed report to file
   */
  async saveReport() {
    const logsDir = path.join(__dirname, "..", "logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(logsDir, `ingestion-report-${timestamp}.json`);

    const report = {
      timestamp: new Date().toISOString(),
      options: this.options,
      stats: this.stats,
      apiStats: this.cloudApiClient.getStats(),
      parserStats: this.csvParser.getStats(),
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`📄 Report saved to: ${reportPath}\n`);
  }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--sandbox") {
      options.sandbox = true;
    } else if (arg === "--force-production") {
      options.forceProduction = true;
    } else if (arg === "--debug") {
      options.debug = true;
    } else if (arg === "--list-schemas") {
      options.listSchemas = true;
    } else if (arg === "--list-object-types") {
      options.listObjectTypes = true;
    } else if (arg === "--schema" || arg === "-s") {
      options.schema = args[++i];
    } else if (arg === "--object-type" || arg === "-o") {
      options.objectType = args[++i];
    } else if (arg === "--asset-type" || arg === "-a") {
      options.assetType = args[++i];
    } else if (arg === "--mapping" || arg === "-m") {
      options.mapping = args[++i];
    } else if (arg === "--limit" || arg === "-l") {
      options.limit = parseInt(args[++i], 10);
    } else if (arg === "--cloud-assets-path") {
      options.cloudAssetsPath = args[++i];
    }
  }

  return options;
}

/**
 * Print help message
 */
function printHelp() {
  console.log(`
Cloud Asset Ingestion Script

USAGE:
  node ingest_cloud_assets.js [OPTIONS]

OPTIONS:
  -h, --help              Show this help message
  --dry-run               Run without making any changes
  --sandbox               Use sandbox environment (requires SANDBOX_WORKSPACE_ID)
  --force-production      Skip production confirmation prompt
  --debug                 Enable debug logging

  -s, --schema NAME       Target schema name
  -o, --object-type NAME  Target object type name
  -a, --asset-type TYPE   Asset type to process (default, vInfo, vCluster, horizon)
  -m, --mapping FILE      Path to mapping JSON file
  -l, --limit N           Limit number of records to process
  --cloud-assets-path DIR Path to cloud assets directory

EXAMPLES:
  # List available schemas
  node ingest_cloud_assets.js --list-schemas

  # List object types in a schema
  node ingest_cloud_assets.js --list-object-types --schema "Asset Management"

  # Dry run with 5 records
  node ingest_cloud_assets.js --dry-run --limit 5 --schema "Asset Management" --object-type "Virtual Machine" --asset-type vInfo

  # Ingest to sandbox
  node ingest_cloud_assets.js --sandbox --schema "Asset Management" --object-type "Virtual Machine" --asset-type vInfo

ENVIRONMENT VARIABLES:
  Required:
    CLOUD_BASE_URL        Jira Cloud base URL (e.g., https://yourcompany.atlassian.net)
    WORKSPACE_ID          Assets workspace ID
    CLOUD_API_TOKEN       API token for authentication

  Sandbox (required when using --sandbox):
    SANDBOX_WORKSPACE_ID  Sandbox workspace ID (REQUIRED!)
    SANDBOX_CLOUD_API_TOKEN  Sandbox API token (optional, uses CLOUD_API_TOKEN if not set)
    SANDBOX_CLOUD_BASE_URL   Sandbox base URL (optional)

  `);
}

// Main execution
const options = parseArgs();
const ingestion = new CloudAssetIngestion(options);

if (options.help) {
  printHelp();
  process.exit(0);
}

ingestion.execute().catch((error) => {
  console.error("\n❌ Error:", error.message);
  if (options.debug) {
    console.error(error.stack);
  }
  process.exit(1);
});
