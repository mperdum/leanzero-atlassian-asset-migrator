/**
 * Microsoft Graph User Ingestion Script
 *
 * Ingests users from Microsoft Graph API into Jira Cloud Assets.
 * Supports matching existing users, updating modified users, and creating new users.
 *
 * Features:
 * - Fetches Manager field from Microsoft Graph API
 * - Looks up Jira User objects to get accountId for User type attributes
 * - Handles Object type attributes (Department, License)
 * - Handles Boolean attributes correctly
 * - Handles Date attributes correctly
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const MicrosoftGraphApiClient = require("../src/microsoftGraphApiClient");
const CloudApiClient = require("../src/cloudApiClient");
const AttributeMapper = require("../src/attributeMapper");

// Default values
const DEFAULT_SCHEMA_ID = 15;
const DEFAULT_OBJECT_TYPE_ID = 153;

// Company object type configuration
const DEFAULT_COMPANY_SCHEMA_ID = 5;
const DEFAULT_COMPANY_OBJECT_TYPE_ID = 154;

// License object type configuration
const DEFAULT_LICENSE_SCHEMA_ID = 5;
const DEFAULT_LICENSE_OBJECT_TYPE_ID = 204;

// Location object type configuration
const DEFAULT_LOCATION_SCHEMA_ID = 5;
const DEFAULT_LOCATION_OBJECT_TYPE_ID = 155;

// Attributes to skip during ingestion (will not be created or updated)
const SKIP_ATTRIBUTES = new Set(["License"]);

// Default user attributes to fetch from Microsoft Graph
// Include manager expansion to get manager information
const DEFAULT_USER_ATTRIBUTES = [
  "id",
  "displayName",
  "givenName",
  "surname",
  "mail",
  "userPrincipalName",
  "jobTitle",
  "department",
  "officeLocation",
  "city",
  "onPremisesSamAccountName",
  "companyName",
  "employeeId",
  "businessPhones",
  "mobilePhone",
  "accountEnabled",
  "manager", // Will be expanded
  "createdDateTime",
];

// Default mapping of Graph attributes to Assets attributes (using exact names)
const DEFAULT_MAPPING = {
  displayName: "Name",
  givenName: "Given name",
  surname: "Surname",

  jobTitle: "Title",
  mail: "E-Mail",
  city: "Location",
  companyName: "Company",
  department: "Department",
  businessPhones: "Phone",
  mobilePhone: "Mobile",
  accountEnabled: "Status",
  id: "objectGUID",
  employeeId: "employeeID",
  onPremisesSamAccountName: "sAMAccountName",
  // Manager field - fetched from Microsoft Graph with $expand=manager
  manager: "Manager",

  // Jira user - this is a User type attribute that references Jira Platform users
  // We'll populate this with the accountId looked up from the email address
  // The email address comes from the 'mail' attribute which maps to 'E-Mail'
  userPrincipalName: "Jira User",

  // Boolean fields
  Absence: "Absence",
  "Software Asset Administrator": "Software Asset Administrator",
  impNotInExternal: "impNotInExternal",
  impNotInInternal: "impNotInInternal",
  impNotInUsers: "impNotInUsers",

  // Date field
  lastLogon: "lastLogon",

  // Other fields
  Review: "Review",
  "Cost centre": "Cost centre",

  // Department and License are Object types - we need to search for them
  // These will be handled separately as they require object lookups
};

class MicrosoftGraphUserIngestion {
  constructor(options = {}) {
    this.options = {
      dryRun: options.dryRun || false,
      preview: options.preview || false,
      limit: options.limit || 0,
      debug: options.debug || false,
      mappingFile: options.mapping || null,
      schemaId:
        options.schemaId ||
        parseInt(process.env.OBJECT_SCHEMA_ID) ||
        DEFAULT_SCHEMA_ID,
      objectTypeId:
        options.objectTypeId ||
        parseInt(process.env.OBJECT_TYPE_ID) ||
        DEFAULT_OBJECT_TYPE_ID,
      filter: "userType eq 'Member'",
    };

    this.stats = {
      startTime: null,
      endTime: null,
      totalUsersFetched: 0,
      existingUsersMatched: 0,
      newUsersCreated: 0,
      existingUsersUpdated: 0,
      usersSkipped: 0,
      usersFailed: 0,
      errors: [],
    };

    // Initialize clients
    this.graphApiClient = new MicrosoftGraphApiClient(
      process.env.MS_CLIENT_ID,
      process.env.MS_TENANT_ID,
      process.env.MS_CLIENT_SECRET,
    );

    this.cloudApiClient = new CloudApiClient(
      process.env.WORKSPACE_ID,
      process.env.CLOUD_API_TOKEN,
      process.env.CLOUD_BASE_URL || "https://api.atlassian.com",
    );

    this.attributeMapper = new AttributeMapper(this.cloudApiClient);

    // Mapping cache
    this.attributeMapping = null;
    this.existingUsersMap = new Map(); // Map of normalized name/userPrincipalName to asset

    // Object type lookup caches
    this.userObjectCache = new Map(); // Cache for Jira User objects (email -> accountId)
    this.objectReferenceCache = new Map(); // Unified cache for object reference lookups
    this.departmentObjectCache = new Map(); // Legacy cache for Department objects (retry logic)
    this.licenseObjectCache = new Map(); // Legacy cache for License objects (retry logic)
    this.companyObjectCache = new Map(); // Legacy cache for Company objects (retry logic)
    this.locationObjectCache = new Map(); // Legacy cache for Location objects (retry logic)
  }

  async run() {
    this.stats.startTime = Date.now();

    console.log("=".repeat(60));
    console.log("Microsoft Graph User Ingestion to Jira Cloud Assets");
    console.log("=".repeat(60));
    console.log();

    // Validate environment variables
    this.validateEnvironment();

    // Test connections
    await this.testConnections();

    if (this.options.preview) {
      await this.previewUsers();
      return;
    }

    // Execute the ingestion
    await this.execute();

    this.stats.endTime = Date.now();
    this.printSummary();
    this.saveReport();
  }

  validateEnvironment() {
    const required = [
      "WORKSPACE_ID",
      "CLOUD_API_TOKEN",
      "MS_CLIENT_ID",
      "MS_TENANT_ID",
      "MS_CLIENT_SECRET",
    ];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      console.error("Missing required environment variables:");
      missing.forEach((key) => console.error(`  - ${key}`));
      console.error("\nPlease create a .env file with the required variables.");
      console.error("See README.md for more information.");
      process.exit(1);
    }
  }

  async testConnections() {
    console.log("Testing connections...");
    console.log("-".repeat(60));

    // Test Microsoft Graph connection
    const graphConnected = await this.graphApiClient.testConnection();
    if (!graphConnected) {
      console.error("Failed to connect to Microsoft Graph API");
      process.exit(1);
    }
    console.log();

    // Test Cloud API connection
    const cloudConnected = await this.cloudApiClient.testConnection();
    if (!cloudConnected) {
      console.error("Failed to connect to Jira Cloud Assets API");
      process.exit(1);
    }
    console.log();

    // Verify object type exists
    console.log("Verifying object type...");
    try {
      const objectTypes = await this.cloudApiClient.getObjectTypes(
        this.options.schemaId,
      );
      const objectType = objectTypes.find(
        (ot) => String(ot.id) === String(this.options.objectTypeId),
      );
      if (!objectType) {
        console.error(
          `Object type ID ${this.options.objectTypeId} not found in schema ID ${this.options.schemaId}`,
        );
        console.error("Available object types:");
        objectTypes.forEach((ot) => console.log(`  - ${ot.id}: ${ot.name}`));
        process.exit(1);
      }
      console.log(`  ✓ Found: ${objectType.name} (ID: ${objectType.id})`);
    } catch (error) {
      console.error("Failed to verify object type:", error.message);
      process.exit(1);
    }
    console.log();
  }

  async previewUsers() {
    console.log("Preview Mode - Fetching Users from Microsoft Graph");
    console.log("-".repeat(60));
    console.log();

    const users = await this.graphApiClient.fetchUsers({
      filter: this.options.filter,
      select: DEFAULT_USER_ATTRIBUTES.join(","),
      maxResults: this.options.limit || 10,
      expandManager: true, // Expand manager to get manager info
    });

    this.stats.totalUsersFetched = users.length;

    console.log(`Found ${users.length} user(s) matching the filter.`);
    console.log();

    if (users.length > 0) {
      console.log("Sample users:");
      console.log("-".repeat(60));
      const sampleSize = Math.min(5, users.length);
      for (let i = 0; i < sampleSize; i++) {
        const user = users[i];
        console.log(
          `  ${i + 1}. ${user.displayName} (${user.mail || user.userPrincipalName})`,
        );
        console.log(`     Job Title: ${user.jobTitle || "N/A"}`);
        console.log(`     Department: ${user.department || "N/A"}`);
        console.log(`     Manager: ${user.manager?.displayName || "N/A"}`);
        console.log();
      }
    }
  }

  async execute() {
    console.log("Starting User Ingestion");
    console.log("-".repeat(60));
    console.log(
      `Target: Schema ID ${this.options.schemaId}, Object Type ID ${this.options.objectTypeId}`,
    );
    console.log(`Filter: ${this.options.filter}`);
    if (this.options.limit > 0) {
      console.log(`Limit: ${this.options.limit} users`);
    }
    console.log();

    // Load attribute mapping
    await this.loadAttributeMapping();

    // Fetch users from Microsoft Graph with manager expansion
    const allFetchedUsers = await this.graphApiClient.fetchUsers({
      filter: this.options.filter,
      select: DEFAULT_USER_ATTRIBUTES.join(","),
      maxResults: this.options.limit,
      expandManager: true, // Expand manager to get manager info
    });

    // Filter out service/C-accounts (e.g. c-xxxx@company.com) and onmicrosoft.com accounts
    const cAccountPattern = /^c-/i;
    const onMicrosoftPattern = /@.*\.onmicrosoft\.com$/i;
    const users = allFetchedUsers.filter((u) => {
      const upn = u.userPrincipalName || "";
      return !cAccountPattern.test(upn) && !onMicrosoftPattern.test(upn);
    });
    const filteredCount = allFetchedUsers.length - users.length;
    if (filteredCount > 0) {
      console.log(
        `✓ Fetched ${allFetchedUsers.length} users from Microsoft Graph (filtered out ${filteredCount} C-accounts/onmicrosoft accounts)`,
      );
    } else {
      console.log(`✓ Fetched ${users.length} users from Microsoft Graph`);
    }

    this.stats.totalUsersFetched = users.length;
    console.log();

    if (users.length === 0) {
      console.log("No users to process. Exiting.");
      return;
    }

    // Query existing users from Cloud Assets
    await this.queryExistingUsers();

    // Process each user
    console.log("Processing Users...");
    console.log("-".repeat(60));
    console.log();

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const userNumber = i + 1;

      try {
        await this.processUser(user, userNumber, users.length);
      } catch (error) {
        this.stats.usersFailed++;
        this.stats.errors.push({
          user: user.displayName || user.id,
          error: error.message,
          data: user,
        });
        console.error(
          `  [${userNumber}/${users.length}] FAILED: ${error.message}`,
        );

        if (this.options.debug) {
          console.error(error);
        }
      }
    }

    console.log();
  }

  async loadAttributeMapping() {
    console.log("Loading attribute mapping...");

    // Load object type attributes
    const attributes = await this.attributeMapper.loadAttributes(
      this.options.objectTypeId,
    );
    console.log(`  ✓ Loaded ${attributes.length} object type attributes`);

    // Create a mapping from attribute ID to attribute name
    // This is needed because AQL responses only include objectTypeAttributeId, not the full object with name
    this.attributeIdToNameMap = {};
    // Create a mapping from attribute ID to attribute type info
    // This is needed to identify object reference attributes (Type 1) in getAttributeValue
    this.attributeIdToTypeInfoMap = {};
    for (const attr of attributes) {
      this.attributeIdToNameMap[attr.id] = attr.name;
      this.attributeIdToTypeInfoMap[attr.id] = {
        name: attr.name,
        type: attr.type,
      };
    }

    // Load manual mapping if provided
    let mapping = { ...DEFAULT_MAPPING };
    if (this.options.mappingFile && fs.existsSync(this.options.mappingFile)) {
      const manualMapping = JSON.parse(
        fs.readFileSync(this.options.mappingFile, "utf8"),
      );
      mapping = { ...mapping, ...manualMapping };
      console.log(`  ✓ Loaded mapping from: ${this.options.mappingFile}`);
    }

    // Build mapping with attribute IDs and types
    this.attributeMapping = {};
    const unmappedAttributes = [];

    for (const [graphAttribute, assetsAttributeName] of Object.entries(
      mapping,
    )) {
      // Skip comment entries
      if (graphAttribute.startsWith("_comment")) {
        continue;
      }

      const attribute = attributes.find((a) => a.name === assetsAttributeName);
      if (attribute) {
        this.attributeMapping[graphAttribute] = {
          attributeId: attribute.id,
          attributeName: attribute.name,
          attributeType: attribute.type,
          referenceObjectTypeId: attribute.referenceObjectTypeId || null,
        };
      } else {
        unmappedAttributes.push(`${graphAttribute} -> ${assetsAttributeName}`);
      }
    }

    console.log(
      `  ✓ Mapped ${Object.keys(this.attributeMapping).length} Graph attributes to Assets attributes`,
    );

    if (unmappedAttributes.length > 0) {
      console.log(`  ⚠ Unmapped attributes: ${unmappedAttributes.join(", ")}`);
    }

    if (this.options.debug) {
      console.log("\nAttribute Mapping:");
      for (const [graphAttr, assetsAttr] of Object.entries(
        this.attributeMapping,
      )) {
        console.log(
          `  ${graphAttr} -> ${assetsAttr.attributeName} (ID: ${assetsAttr.attributeId}, Type: ${assetsAttr.attributeType})`,
        );
      }
    }

    // Ensure Jira User attribute is mapped manually (in case it wasn't found during attribute loading)
    if (!this.attributeMapping["userPrincipalName"]) {
      const jiraUserAttr = attributes.find((a) => a.name === "Jira User");
      if (jiraUserAttr) {
        this.attributeMapping["userPrincipalName"] = {
          attributeId: jiraUserAttr.id,
          attributeName: jiraUserAttr.name,
          attributeType: jiraUserAttr.type,
          referenceObjectTypeId: jiraUserAttr.referenceObjectTypeId || null,
        };
        console.log(
          `  ✓ Manually added: userPrincipalName -> Jira User (ID: ${jiraUserAttr.id}, Type: ${jiraUserAttr.type})`,
        );
      }
    }

    console.log();
  }

  async queryExistingUsers() {
    console.log("Querying existing users from Cloud Assets...");

    // Build AQL query to fetch all existing users in this object type
    const aqlQuery = `objectTypeId = ${this.options.objectTypeId}`;

    if (this.options.debug) {
      console.log(`  DEBUG: AQL Query: ${aqlQuery}`);
    }

    let allUsers = [];
    let startAt = 0;
    const maxResults = 50;
    let pageCount = 0;
    let totalFromFirstPage = 0;

    while (pageCount < 1000) {
      pageCount++;
      if (this.options.debug) {
        console.log(
          `  DEBUG: Fetching page ${pageCount} (startAt=${startAt}, maxResults=${maxResults})`,
        );
      }

      const response = await this.cloudApiClient.executeAQL(
        aqlQuery,
        startAt,
        maxResults,
        true,
      );

      if (!response) {
        if (this.options.debug) {
          console.log(`  DEBUG: No valid response, breaking pagination`);
        }
        break;
      }

      if (response.error) {
        console.warn(`  Warning: AQL query returned error: ${response.error}`);
        break;
      }

      const entries = response.values || response.objectEntries || [];

      if (this.options.debug) {
        console.log(
          `  DEBUG: Got ${entries.length} entries from page ${pageCount}`,
        );
        if (entries.length > 0 && pageCount === 1) {
          const sampleEntry = entries[0];
          console.log(
            `  DEBUG: Sample entry: label="${sampleEntry.label}", id="${sampleEntry.id}", objectKey="${sampleEntry.objectKey}"`,
          );
        }
      }

      allUsers = allUsers.concat(entries);
      startAt += maxResults;

      // Use isLast flag as primary pagination signal (matches cloud_asset_ingestion pattern)
      if (response.isLast || entries.length === 0) {
        if (this.options.debug) {
          console.log(
            `  DEBUG: Pagination complete (isLast=${response.isLast}, entries=${entries.length})`,
          );
        }
        break;
      }

      // Small delay between requests
      await this.sleep(100);

      if (pageCount % 5 === 0) {
        console.log(`  Fetched ${allUsers.length} users so far...`);
      }
    }

    console.log(`  ✓ Found ${allUsers.length} existing users`);

    // Build a map for quick lookup by various identifiers
    for (const asset of allUsers) {
      const key = this.normalizeString(asset.label || "");

      // Use debug version of getAttributeValue to see what's happening
      const mail = this.options.debug
        ? this.getAttributeValueDebug(asset, "E-Mail")
        : this.getAttributeValue(asset, "E-Mail");

      // Debug logging
      if (this.options.debug) {
        console.log(
          `  DEBUG: Processing existing user: ${asset.label || "(no label)"}`,
        );
        console.log(`      Label key: ${key ? `"${key}"` : "(empty)"}`);
        console.log(`      Has label/name: ${!!key}`);
        console.log(`      E-Mail: ${mail ? `"${mail}"` : "(empty)"}`);
        console.log(`      Has E-Mail: ${!!mail}`);
        console.log(`      Object Type ID: ${asset.objectType?.id || "N/A"}`);
        console.log(`      Adding to map: ${!!key || !!mail}`);
      }

      // Store by label/name
      if (key) {
        this.existingUsersMap.set(key, asset);
      }

      // Store by email
      if (mail) {
        this.existingUsersMap.set(mail.toLowerCase(), asset);
      }
    }

    console.log(
      `  ✓ Built lookup index for ${this.existingUsersMap.size} identifiers`,
    );

    // Additional debug: show all normalized labels in the map
    if (this.options.debug) {
      console.log(`  DEBUG: All normalized labels in lookup map:`);
      const allKeys = Array.from(this.existingUsersMap.keys());
      const labelKeys = allKeys.filter((k) => !k.includes("@")); // Filter out email keys
      console.log(
        `  Total keys: ${allKeys.length} (${labelKeys.length} label keys, ${allKeys.length - labelKeys.length} email keys)`,
      );

      if (labelKeys.length > 0) {
        console.log(
          `  First 20 label keys: ${JSON.stringify(labelKeys.slice(0, 20))}`,
        );
      }

      // Check for specific user if we're in debug mode
      const testUsers = ["oliverliebig", "oliver", "liebig"];
      const matchingKeys = labelKeys.filter((k) =>
        testUsers.some((t) => k.includes(t)),
      );
      if (matchingKeys.length > 0) {
        console.log(
          `  DEBUG: Found keys matching "Oliver": ${JSON.stringify(matchingKeys)}`,
        );
      } else {
        console.log(
          `  DEBUG: No keys matching "Oliver" or "Liebig" found in map`,
        );
      }
    }
    console.log();
  }

  /**
   * Preview User type attribute values in dry-run mode
   * This performs the lookup to show what accountId would be used
   */
  async previewUserTypeAttributeValues(changes) {
    const userTypeChanges = changes.filter((change) => {
      const attrInfo = this.attributeMapping[change.graphAttribute];
      return attrInfo && attrInfo.attributeType === 2;
    });

    if (userTypeChanges.length === 0) {
      return;
    }

    console.log(`     [DRY RUN] Looking up User type attributes:`);

    for (const change of userTypeChanges) {
      const attrInfo = this.attributeMapping[change.graphAttribute];
      console.log(`       ${attrInfo.attributeName}:`);

      const accountId = await this.lookupUserAccountId(change.newValue);

      if (accountId) {
        console.log(
          `         ✓ Would set accountId: ${accountId} (from ${change.newValue})`,
        );
      } else {
        console.log(`         ⚠️  User not found in Jira: ${change.newValue}`);
      }
    }
  }

  /**
   * Preview User type attribute values for a new user in dry-run mode
   */
  async previewUserTypeAttributeValuesForUser(user) {
    const userTypeAttrs = [];

    // Find all User type attributes in mapping
    for (const [graphAttr, attrInfo] of Object.entries(this.attributeMapping)) {
      if (attrInfo.attributeType === 2 && user[graphAttr]) {
        userTypeAttrs.push({
          attributeName: attrInfo.attributeName,
          value: user[graphAttr],
          graphAttr: graphAttr,
        });
      }
    }

    if (userTypeAttrs.length === 0) {
      return;
    }

    console.log(`     [DRY RUN] Looking up User type attributes:`);

    for (const userAttr of userTypeAttrs) {
      console.log(`       ${userAttr.attributeName}:`);

      const accountId = await this.lookupUserAccountId(userAttr.value);

      if (accountId) {
        console.log(
          `         ✓ Would set accountId: ${accountId} (from ${userAttr.value})`,
        );
      } else {
        console.log(`         ⚠️  User not found in Jira: ${userAttr.value}`);
      }
    }
  }

  async processUser(user, userNumber, totalUsers) {
    const displayName = user.displayName || user.id || "Unknown";
    const mail = user.mail || "";
    const userPrincipalName = user.userPrincipalName || "";
    const managerInfo = user.manager
      ? `${user.manager.displayName} (${user.manager.mail || ""})`
      : "None";

    console.log(`[${userNumber}/${totalUsers}] Processing: ${displayName}`);
    console.log(`  Email: ${mail || "N/A"}`);
    console.log(`  UPN: ${userPrincipalName}`);
    console.log(`  Manager: ${managerInfo}`);

    // Try to find matching existing user
    const existingAsset = await this.findMatchingUser(user);

    if (existingAsset) {
      this.stats.existingUsersMatched++;

      // Compare attributes to detect changes
      const changes = this.detectChanges(user, existingAsset);

      if (changes.length === 0) {
        console.log(`  → MATCHED: No changes detected`);
        this.stats.usersSkipped++;
      } else {
        console.log(`  → MATCHED: ${changes.length} change(s) detected`);
        changes.forEach((change) => {
          // Show the converted display value for Status (type 7) booleans
          let displayNewValue = change.newValue;
          if (
            change.attributeType === 7 &&
            typeof change.newValue === "boolean"
          ) {
            displayNewValue = change.newValue ? "Active" : "Inactive";
          }
          let changeMessage = `     - ${change.attribute}: "${change.oldValue}" → "${displayNewValue}"`;
          // Add note for object reference attributes (Type 1)
          if (change.attributeType === 1) {
            changeMessage += ` (will look up object by name and use its ID)`;
          }
          console.log(changeMessage);
        });

        if (!this.options.dryRun) {
          await this.updateUser(existingAsset, user, changes);
          this.stats.existingUsersUpdated++;
        } else {
          console.log(
            `     [DRY RUN] Would update asset ${existingAsset.objectKey || existingAsset.id}`,
          );
          await this.previewUserTypeAttributeValues(changes);
          this.stats.usersSkipped++;
        }
      }
    } else {
      console.log(`  → NEW: Creating as new asset`);
      if (!this.options.dryRun) {
        await this.createUser(user);
        this.stats.newUsersCreated++;
      } else {
        console.log(`     [DRY RUN] Would create new asset`);
        await this.previewUserTypeAttributeValuesForUser(user);
        this.stats.usersSkipped++;
      }
    }

    console.log();
  }

  async findMatchingUser(user) {
    // Debug logging for matching
    if (this.options.debug) {
      console.log("    DEBUG: findMatchingUser");
      console.log(`      displayName: "${user.displayName}"`);
      console.log(`      mail: "${user.mail}"`);
      console.log(`      userPrincipalName: "${user.userPrincipalName}"`);
      console.log(`      Map size: ${this.existingUsersMap.size}`);

      // Show first few keys in the map for debugging
      const sampleKeys = Array.from(this.existingUsersMap.keys()).slice(0, 5);
      console.log(`      Sample keys in map: ${JSON.stringify(sampleKeys)}`);
    }

    // Step 1: Try exact match by display name (local map)
    if (user.displayName) {
      const key = this.normalizeString(user.displayName);
      if (this.options.debug) {
        console.log(
          `      Trying match by displayName: "${user.displayName}" -> normalized: "${key}"`,
        );
        console.log(
          `      Map has key "${key}": ${this.existingUsersMap.has(key)}`,
        );
      }
      if (this.existingUsersMap.has(key)) {
        const matched = this.existingUsersMap.get(key);
        if (this.options.debug) {
          console.log(
            `      ✓ MATCHED by displayName: ${matched.label || matched.objectKey} (ID: ${matched.id})`,
          );
        }
        return matched;
      }
    }

    // Step 2: Try exact match by email (local map)
    if (user.mail) {
      const emailKey = user.mail.toLowerCase();
      if (this.options.debug) {
        console.log(
          `      Trying match by mail: "${user.mail}" -> normalized: "${emailKey}"`,
        );
        console.log(
          `      Map has key "${emailKey}": ${this.existingUsersMap.has(emailKey)}`,
        );
      }
      if (this.existingUsersMap.has(emailKey)) {
        const matched = this.existingUsersMap.get(emailKey);
        if (this.options.debug) {
          console.log(
            `      ✓ MATCHED by mail: ${matched.label || matched.objectKey} (ID: ${matched.id})`,
          );
        }
        return matched;
      }
    }

    // Step 3: Try exact match by user principal name (local map)
    if (user.userPrincipalName) {
      const upnKey = user.userPrincipalName.toLowerCase();
      if (this.options.debug) {
        console.log(
          `      Trying match by userPrincipalName: "${user.userPrincipalName}" -> normalized: "${upnKey}"`,
        );
        console.log(
          `      Map has key "${upnKey}": ${this.existingUsersMap.has(upnKey)}`,
        );
      }
      if (this.existingUsersMap.has(upnKey)) {
        const matched = this.existingUsersMap.get(upnKey);
        if (this.options.debug) {
          console.log(
            `      ✓ MATCHED by userPrincipalName: ${matched.label || matched.objectKey} (ID: ${matched.id})`,
          );
        }
        return matched;
      }
    }

    // Step 4: No local match found - search cloud using AQL (following reference pattern)
    console.log(`      🔍 No local match found - searching cloud...`);
    const cloudMatches = await this.searchForUserInCloud(user);

    // Step 5: Validate each cloud match
    if (cloudMatches && cloudMatches.length > 0) {
      console.log(
        `      🎯 Found ${cloudMatches.length} potential match(es) in cloud`,
      );

      for (let i = 0; i < cloudMatches.length; i++) {
        const match = cloudMatches[i];
        if (this.options.debug) {
          console.log(
            `      🔄 Validating match ${i + 1}/${cloudMatches.length}: ${match.label || match.objectKey} (ID: ${match.id})`,
          );
        }

        if (this.validateUserMatch(user, match)) {
          console.log(
            `      ✅ Match validated: ${match.label || match.objectKey} (ID: ${match.id})`,
          );
          return match;
        } else {
          if (this.options.debug) {
            console.log(`      ❌ Match failed validation - trying next...`);
          }
        }
      }

      console.log(
        `      ⚠️  All ${cloudMatches.length} matches failed validation`,
      );
    }

    if (this.options.debug) {
      console.log(`      ✗ NO MATCH found for user`);
    }

    return null;
  }

  /**
   * Search for user matches in cloud using AQL (following reference pattern)
   *
   * @param {Object} user - Microsoft Graph user object
   * @returns {Array} - Array of potential matches
   */
  async searchForUserInCloud(user) {
    const queries = [];

    // Build AQL queries for different fields, scoped to the target object type
    const otFilter = ` AND objectTypeId = ${this.options.objectTypeId}`;
    if (user.displayName) {
      const escaped = this.escapeAQLValue(user.displayName);
      queries.push(`Name = "${escaped}"${otFilter}`);
    }
    if (user.mail) {
      const escaped = this.escapeAQLValue(user.mail);
      queries.push(`Key = "${escaped}"${otFilter}`);
    }
    if (user.userPrincipalName) {
      const escaped = this.escapeAQLValue(user.userPrincipalName);
      queries.push(`Key = "${escaped}"${otFilter}`);
    }

    // Execute queries and collect all matches
    const allMatches = new Map(); // Use Map to deduplicate by ID

    for (const query of queries) {
      try {
        console.log(`      🔎 AQL Query: ${query}`);
        const response = await this.cloudApiClient.executeAQL(query, 0, 10);

        const entries = response?.values || response?.objectEntries || [];
        if (entries.length > 0) {
          for (const match of entries) {
            if (!allMatches.has(match.id)) {
              allMatches.set(match.id, match);
            }
          }
        }
      } catch (error) {
        console.log(`      ⚠️  Error executing AQL query: ${error.message}`);
      }
    }

    return Array.from(allMatches.values());
  }

  /**
   * Validate if a cloud match matches the graph user (following reference pattern)
   *
   * @param {Object} graphUser - Microsoft Graph user object
   * @param {Object} cloudMatch - Cloud user object from AQL
   * @returns {boolean} - True if match is valid
   */
  validateUserMatch(graphUser, cloudMatch) {
    // Check if names match (case-insensitive, normalized)
    if (graphUser.displayName && cloudMatch.name) {
      const graphName = this.normalizeString(graphUser.displayName);
      const cloudName = this.normalizeString(cloudMatch.name);
      if (graphName === cloudName) {
        return true;
      }
    }

    // Check if emails match
    if (graphUser.mail && cloudMatch.label) {
      if (graphUser.mail.toLowerCase() === cloudMatch.label.toLowerCase()) {
        return true;
      }
    }

    // Check if userPrincipalName matches
    if (graphUser.userPrincipalName && (cloudMatch.label || cloudMatch.key)) {
      const graphUPN = graphUser.userPrincipalName.toLowerCase();
      const cloudUPN = (cloudMatch.label || cloudMatch.key || "").toLowerCase();
      if (graphUPN === cloudUPN) {
        return true;
      }
    }

    return false;
  }

  detectChanges(graphUser, asset) {
    const changes = [];

    for (const [graphAttr, attrInfo] of Object.entries(this.attributeMapping)) {
      // Skip attributes in the skip list
      if (SKIP_ATTRIBUTES.has(attrInfo.attributeName)) {
        continue;
      }

      let graphValue = graphUser[graphAttr];

      // Handle special fields
      if (graphAttr === "manager") {
        graphValue = graphUser.manager?.displayName || "";
      }

      const assetValue = this.getAttributeValue(asset, attrInfo.attributeName);

      // IMPORTANT: Don't clear existing data
      // If graphValue is empty/null/undefined but assetValue exists, skip this change
      // Microsoft Graph is the authority, but we preserve existing data if Graph doesn't have it
      // NOTE: `false` is a valid value (e.g. accountEnabled=false → Status "Inactive"),
      // so we must NOT treat boolean false as empty.
      const isGraphValueEmpty =
        graphValue === null ||
        graphValue === undefined ||
        graphValue === "" ||
        (Array.isArray(graphValue) && graphValue.length === 0);

      if (
        isGraphValueEmpty &&
        assetValue !== null &&
        assetValue !== undefined &&
        assetValue !== ""
      ) {
        continue; // Preserve existing data - don't clear it
      }

      // Skip User type attributes (Type 2) in change detection.
      // Graph has the email/UPN but cloud stores the Jira accountId — these are
      // fundamentally different values and can't be compared. The accountId is
      // set during create and will be re-resolved during update if other changes exist.
      if (attrInfo.attributeType === 2) {
        continue;
      }

      // For Object Reference attributes (Type 1), compare using fuzzy matching
      // because Graph value (e.g. "acme") may differ from cloud displayValue
      // (e.g. "Acme Corp GmbH") but still refer to the same object.
      if (attrInfo.attributeType === 1) {
        if (graphValue && assetValue) {
          const graphNorm = this.normalizeString(String(graphValue));
          const assetNorm = this.normalizeString(String(assetValue));
          // Same match logic as validateObjectMatch: exact or substring
          if (
            graphNorm === assetNorm ||
            assetNorm.includes(graphNorm) ||
            graphNorm.includes(assetNorm)
          ) {
            continue; // Same object reference, no change needed
          }
        }
        // Values differ (or one is empty) — record as change
        if (graphValue) {
          changes.push({
            attribute: attrInfo.attributeName,
            oldValue: assetValue || "",
            newValue: graphValue || "",
            graphAttribute: graphAttr,
            attributeType: attrInfo.attributeType,
          });
        }
        continue;
      }

      // Compare values for non-reference attributes
      const normalizedGraphValue = this.normalizeValue(
        graphValue,
        attrInfo.attributeType,
      );
      const normalizedAssetValue = this.normalizeValue(
        assetValue,
        attrInfo.attributeType,
      );

      if (normalizedGraphValue !== normalizedAssetValue) {
        changes.push({
          attribute: attrInfo.attributeName,
          oldValue:
            assetValue !== null && assetValue !== undefined ? assetValue : "",
          newValue:
            graphValue !== null && graphValue !== undefined ? graphValue : "",
          graphAttribute: graphAttr,
          attributeType: attrInfo.attributeType, // Include attribute type for reference handling
        });
      }
    }

    return changes;
  }

  async updateUser(asset, graphUser, changes) {
    console.log(`  → Updating asset ${asset.objectKey || asset.id}`);

    // Fetch the existing object's current attributes to preserve them
    let existingAttributes = {};
    try {
      const existingObj = await this.cloudApiClient.getObject(asset.id);
      if (existingObj && existingObj.attributes) {
        for (const attr of existingObj.attributes) {
          existingAttributes[attr.objectTypeAttributeId] = attr;
        }
      }
    } catch (error) {
      console.warn(
        `    Warning: Could not fetch existing attributes: ${error.message}`,
      );
    }

    // Build attributes to update - merge new values with existing ones
    const updatedAttributes = [];

    // First, copy all existing attributes to preserve them.
    // IMPORTANT: The API GET response returns special types (Status, User,
    // Object Reference) without a "value" key — they use "status", "user", or
    // "referencedObject" instead.  But the PUT API requires a "value" key to
    // persist the attribute.  We must normalise the values here so they survive
    // the round-trip.
    for (const [attrId, attrValue] of Object.entries(existingAttributes)) {
      const normalizedValues = attrValue.objectAttributeValues.map((av) => {
        // If there is already a proper value, keep it
        if (av.value !== undefined && av.value !== null) {
          return { value: av.value };
        }
        // Status type: use the status name (e.g. "Active")
        if (av.status && av.status.name) {
          return { value: av.status.name };
        }
        // User type: use the user key (accountId)
        if (av.user && av.user.key) {
          return { value: av.user.key };
        }
        // Object Reference type: use the object key (e.g. "UD-14341")
        if (av.referencedObject && av.referencedObject.objectKey) {
          return { value: av.referencedObject.objectKey };
        }
        // Fallback: use displayValue if available
        if (av.displayValue) {
          return { value: av.displayValue };
        }
        return av;
      });
      updatedAttributes.push({
        objectTypeAttributeId: parseInt(attrId),
        objectAttributeValues: normalizedValues,
      });
    }

    // Then, update with new values for changed attributes
    for (const change of changes) {
      const attrInfo = this.attributeMapping[change.graphAttribute];
      if (attrInfo) {
        let convertedValue = this.convertValue(
          change.newValue,
          attrInfo.attributeType,
        );

        // Handle User type attributes (like "Jira user")
        // Type code 2 = User type
        if (attrInfo.attributeType === 2) {
          convertedValue = await this.lookupUserAccountId(change.newValue);
          // Skip User type attributes if lookup failed (user not found in Jira)
          if (!convertedValue || convertedValue === "") {
            console.log(
              `      ⚠️  Skipping ${attrInfo.attributeName} - user not found in Jira`,
            );
            continue;
          }
        }

        // Handle Object type attributes (like Department, License, Location, Company)
        // Type code 1 = Object type
        if (attrInfo.attributeType === 1) {
          const cacheKey = `${attrInfo.attributeName}:${change.newValue}`;

          // Get all potential matches for retry logic
          const normalizedAttrName = attrInfo.attributeName.toLowerCase();
          let allPotentialMatches = null;

          if (normalizedAttrName === "license") {
            allPotentialMatches = this.licenseObjectCache.get(cacheKey);
          } else if (normalizedAttrName === "company") {
            allPotentialMatches = this.companyObjectCache.get(cacheKey);
          } else if (normalizedAttrName === "location") {
            allPotentialMatches = this.locationObjectCache.get(cacheKey);
          } else {
            allPotentialMatches = this.departmentObjectCache.get(cacheKey);
          }

          // If no cached matches, do lookup
          if (!allPotentialMatches) {
            convertedValue = await this.lookupObjectId(
              attrInfo.attributeName,
              change.newValue,
              attrInfo.referenceObjectTypeId,
            );
            if (!convertedValue || convertedValue === "") {
              console.log(
                `      ⚠️  Skipping ${attrInfo.attributeName} - referenced object not found in Assets`,
              );
              continue;
            }
          } else {
            // Use first match as initial value
            convertedValue = Array.isArray(allPotentialMatches)
              ? allPotentialMatches[0]
              : allPotentialMatches;

            // Store potential matches for retry logic
            change._potentialMatches = Array.isArray(allPotentialMatches)
              ? allPotentialMatches
              : [allPotentialMatches];
            change._currentMatchIndex = 0;
            change._cacheKey = cacheKey;
            change._normalizedAttrName = normalizedAttrName;
          }
        }

        // Never overwrite an existing value with empty — preserve what's already there
        if (
          convertedValue === "" ||
          convertedValue === null ||
          convertedValue === undefined
        ) {
          continue;
        }

        // Update or add the attribute
        const attrIndex = updatedAttributes.findIndex(
          (a) => a.objectTypeAttributeId === attrInfo.attributeId,
        );

        if (attrIndex >= 0) {
          // Update existing attribute
          updatedAttributes[attrIndex].objectAttributeValues = [
            { value: convertedValue },
          ];
        } else {
          // Add new attribute
          updatedAttributes.push({
            objectTypeAttributeId: attrInfo.attributeId,
            objectAttributeValues: [{ value: convertedValue }],
          });
        }
      }
    }

    if (updatedAttributes.length === 0) {
      console.log(`    No attributes to update`);
      return null;
    }

    const objectData = {
      objectTypeId: this.options.objectTypeId,
      attributes: updatedAttributes,
    };

    if (this.options.debug) {
      console.log("    DEBUG: Sending to updateObject:");
      console.log(`      objectId: ${asset.id}`);
      console.log(`      objectTypeId: ${objectData.objectTypeId}`);
      console.log("      attributes:");
      updatedAttributes.forEach((attr) => {
        console.log(
          `        ${attr.objectTypeAttributeId}: ${JSON.stringify(
            attr.objectAttributeValues[0].value,
          )}`,
        );
      });
    }

    // Use updateObject with fallback mechanism to remove failing fields one by one
    let lastError = null;
    const failedAttributes = [];

    // Keep trying until success or no more attributes to update
    while (updatedAttributes.length > 0) {
      try {
        const result = await this.cloudApiClient.updateObject(
          asset.id,
          objectData,
        );

        if (result) {
          console.log(
            `  ✓ Updated successfully (${result.objectKey || result.id})`,
          );

          // Log failed attributes if any
          if (failedAttributes.length > 0) {
            console.log(
              `  ⚠️  ${failedAttributes.length} attribute(s) skipped due to errors:`,
            );
            failedAttributes.forEach((failed) => {
              console.log(`     - ${failed.attributeName}: ${failed.reason}`);
            });

            // Add to global error list for reporting
            const skippedNames = failedAttributes
              .map((f) => f.attributeName)
              .join(", ");
            this.stats.errors.push({
              type: "attribute_update_failed",
              user: asset.label || asset.objectKey,
              userId: asset.id,
              error: `Skipped ${failedAttributes.length} attribute(s): ${skippedNames}`,
              failedAttributes: failedAttributes,
            });
          }

          return result;
        } else {
          throw new Error("Update failed (null response)");
        }
      } catch (error) {
        lastError = error;

        // Try to identify which attribute caused the error
        let failedAttrId = null;
        let failedAttrName = "unknown";
        let failureReason = error.message || "Unknown error";

        // Parse error response to find the problematic attribute
        if (error.response) {
          let errorObj = error.response;

          // Try to parse JSON response
          if (typeof error.response === "string") {
            try {
              errorObj = JSON.parse(error.response);
            } catch (e) {
              errorObj = error.response;
            }
          }

          // Look for errors object in parsed JSON or string format
          const errorsObj = errorObj.errors || errorObj;

          // Iterate through error keys to find attribute restriction errors
          if (typeof errorsObj === "object" && errorsObj !== null) {
            for (const [key, value] of Object.entries(errorsObj)) {
              // Check if this is an attribute restriction error
              const attrMatch = key.match(/^rlabs-insight-attribute-(\d+)$/);
              if (attrMatch && attrMatch[1]) {
                failedAttrId = parseInt(attrMatch[1]);
                failureReason = value || "Invalid due to restrictions";
                break; // Found the failing attribute, stop searching
              }
            }
          } else if (typeof errorsObj === "string") {
            // Fallback for string format errors
            const restrictionMatch = errorsObj.match(
              /rlabs-insight-attribute-(\d+)\s*:\s*"([^"]+)"/,
            );
            if (restrictionMatch && restrictionMatch[1]) {
              failedAttrId = parseInt(restrictionMatch[1]);
              failureReason =
                restrictionMatch[2] || "Invalid due to restrictions";
            }
          }
        }

        // Find the corresponding change/attribute name
        const failedChange = changes.find((c) => {
          const attrInfo = this.attributeMapping[c.graphAttribute];
          return attrInfo && attrInfo.attributeId === failedAttrId;
        });

        if (failedChange) {
          const attrInfo = this.attributeMapping[failedChange.graphAttribute];
          failedAttrName = attrInfo
            ? attrInfo.attributeName
            : `Attribute ${failedAttrId}`;

          console.log(
            `    ⚠️  Failed to update ${failedAttrName}: ${failureReason}`,
          );
          console.log(`    ⚠️  Removing this attribute and retrying...`);

          // Track the failed attribute
          failedAttributes.push({
            attributeId: failedAttrId,
            attributeName: failedAttrName,
            reason: failureReason,
            oldValue: failedChange.oldValue,
            newValue: failedChange.newValue,
          });

          // Remove ALL occurrences of this attribute (compare both as numbers to avoid type mismatch)
          const beforeLen = updatedAttributes.length;
          const filtered = updatedAttributes.filter(
            (a) => Number(a.objectTypeAttributeId) !== Number(failedAttrId),
          );

          if (filtered.length < beforeLen) {
            updatedAttributes.length = 0;
            updatedAttributes.push(...filtered);
          }

          // Remove this change
          const changeIndex = changes.indexOf(failedChange);
          if (changeIndex >= 0) {
            changes.splice(changeIndex, 1);
          }

          // Rebuild objectData with remaining attributes
          objectData.attributes = updatedAttributes;

          // Try again with remaining attributes
          continue;
        } else if (failedAttrId) {
          // Attribute ID was found in error but not in the changes array —
          // it's likely an existing attribute that was copied over and Jira rejects it.
          // Look up the attribute name from the ID-to-name map.
          failedAttrName =
            (this.attributeIdToNameMap &&
              this.attributeIdToNameMap[failedAttrId]) ||
            `Attribute ${failedAttrId}`;

          console.log(
            `    ⚠️  Existing attribute ${failedAttrName} (ID: ${failedAttrId}) rejected: ${failureReason}`,
          );
          console.log(`    ⚠️  Removing this attribute and retrying...`);

          failedAttributes.push({
            attributeId: failedAttrId,
            attributeName: failedAttrName,
            reason: failureReason,
          });

          // Remove ALL occurrences of this attribute (compare both as numbers to avoid type mismatch)
          const beforeLen = updatedAttributes.length;
          const filtered = updatedAttributes.filter(
            (a) => Number(a.objectTypeAttributeId) !== Number(failedAttrId),
          );

          if (filtered.length === beforeLen) {
            // Nothing was removed — we can't fix this, break to avoid infinite loop
            console.error(
              `    ❌ Could not find attribute ${failedAttrId} in updatedAttributes to remove. Breaking retry loop.`,
            );
            throw error;
          }

          // Replace updatedAttributes contents in-place
          updatedAttributes.length = 0;
          updatedAttributes.push(...filtered);

          // Rebuild objectData with remaining attributes
          objectData.attributes = updatedAttributes;

          // Try again with remaining attributes
          continue;
        } else {
          // If we can't identify the failing attribute, log the error and throw
          console.error(
            `    ❌ Could not identify which attribute caused the error. Full error: ${error.message}`,
          );
          console.error(
            `    ❌ Error response: ${error.response || "No response"}`,
          );
          throw error;
        }
      }
    }

    // If we get here, all attributes failed
    console.error(
      `    ❌ All attributes failed to update for ${asset.objectKey || asset.id}`,
    );
    console.error(`    Failed attributes:`);
    failedAttributes.forEach((failed) => {
      console.error(`       - ${failed.attributeName}: ${failed.reason}`);
    });

    throw new Error(
      `Failed to update all attributes for ${asset.objectKey || asset.id}. See logs for details.`,
    );
  }

  async createUser(graphUser) {
    const attributes = [];

    for (const [graphAttr, attrInfo] of Object.entries(this.attributeMapping)) {
      // Skip attributes in the skip list
      if (SKIP_ATTRIBUTES.has(attrInfo.attributeName)) {
        continue;
      }

      let graphValue = graphUser[graphAttr];

      // Handle special fields
      if (graphAttr === "manager") {
        graphValue = graphUser.manager?.displayName || "";
      }

      // Debug logging
      if (this.options.debug) {
        console.log(`    DEBUG: Processing attribute: ${graphAttr}`);
        console.log(`      Attribute Name: ${attrInfo.attributeName}`);
        console.log(`      Attribute Type: ${attrInfo.attributeType}`);
        console.log(`      Graph Value: ${graphValue}`);
      }

      // Skip empty values
      if (
        graphValue === undefined ||
        graphValue === null ||
        graphValue === ""
      ) {
        if (this.options.debug) {
          console.log(`      SKIPPED (empty value)`);
        }
        continue;
      }

      let convertedValue = this.convertValue(
        graphValue,
        attrInfo.attributeType,
      );

      // Handle User type attributes (like "Jira user")
      // Type code 2 = User type
      if (attrInfo.attributeType === 2) {
        console.log(`      Looking up User type...`);
        convertedValue = await this.lookupUserAccountId(graphValue);

        // Skip User type attributes if lookup failed (user not found in Jira)
        if (!convertedValue || convertedValue === "") {
          console.log(
            `      ⚠️  Skipping ${attrInfo.attributeName} - user not found in Jira`,
          );
          continue; // Skip this attribute - continue to next loop iteration
        }
      }

      // Handle Object type attributes (like Department, Company, License)
      // Type code 1 = Object type
      if (attrInfo.attributeType === 1) {
        console.log(
          `      Looking up Object type for: ${attrInfo.attributeName}`,
        );
        convertedValue = await this.lookupObjectId(
          attrInfo.attributeName,
          graphValue,
          attrInfo.referenceObjectTypeId,
        );
        if (this.options.debug) {
          console.log(
            `      After lookup, convertedValue = "${convertedValue}"`,
          );
        }

        // Skip Object type attributes if lookup failed (object doesn't exist)
        if (!convertedValue || convertedValue === "") {
          console.log(
            `      ⚠️  Skipping ${attrInfo.attributeName} - referenced object not found in Assets`,
          );
          continue; // Skip this attribute - continue to next loop iteration
        }
      }

      if (this.options.debug) {
        console.log(`      Final Value: ${convertedValue}`);
      }

      // Only add attribute if we have a valid value
      if (convertedValue !== "") {
        attributes.push({
          objectTypeAttributeId: attrInfo.attributeId,
          objectAttributeValues: [{ value: convertedValue }],
        });
      }
    }

    if (attributes.length === 0) {
      throw new Error("No valid attributes to create asset");
    }

    const objectData = {
      objectTypeId: this.options.objectTypeId,
      attributes: attributes,
    };

    if (this.options.debug) {
      console.log("    DEBUG: Sending to createObject:");
      console.log(`      objectTypeId: ${objectData.objectTypeId}`);
      console.log("      attributes:");
      attributes.forEach((attr) => {
        console.log(
          `        ${attr.objectTypeAttributeId}: ${JSON.stringify(
            attr.objectAttributeValues[0].value,
          )}`,
        );
      });
    }

    const result = await this.cloudApiClient.createObject(objectData);

    if (result) {
      console.log(
        `  ✓ Created successfully (${result.objectKey || result.id})`,
      );

      // Add to existing users map to prevent within-run duplicates
      const displayName = graphUser.displayName || "";
      const normalizedName = this.normalizeString(displayName);
      if (normalizedName && !this.existingUsersMap.has(normalizedName)) {
        this.existingUsersMap.set(normalizedName, result);
      }
      const email = graphUser.mail || "";
      if (email && !this.existingUsersMap.has(email.toLowerCase())) {
        this.existingUsersMap.set(email.toLowerCase(), result);
      }

      return result;
    } else {
      throw new Error("Create failed (null response)");
    }
  }

  /**
   * Look up Jira Platform user by email and return accountId
   * This is used for User type attributes (like "Jira user")
   * Uses Jira Platform API (not Assets) to search for users
   */
  async lookupUserAccountId(email) {
    if (!email) {
      return "";
    }

    // Check cache first
    if (this.userObjectCache.has(email)) {
      return this.userObjectCache.get(email);
    }

    console.log(`    Looking up Jira User for email: ${email}`);

    try {
      // Search for Jira Platform user by email
      const jiraUser = await this.cloudApiClient.searchJiraUser(email);

      if (jiraUser && jiraUser.accountId) {
        // Cache the result
        this.userObjectCache.set(email, jiraUser.accountId);

        console.log(
          `      Found Jira User: ${jiraUser.accountId} (${jiraUser.displayName})`,
        );
        return jiraUser.accountId;
      } else {
        console.warn(`      Jira User not found for email: ${email}`);
        return "";
      }
    } catch (error) {
      console.warn(`      Error looking up Jira User: ${error.message}`);
      return "";
    }
  }

  /**
   * Look up Object by name (for Object type attributes like Company, Department, License)
   * Uses referenceObjectTypeId from the attribute schema when available for precise lookups.
   */
  async lookupObjectId(attributeName, value, referenceObjectTypeId) {
    if (!value) {
      return "";
    }

    // Check cache first (unified cache keyed by attributeName:value)
    const cacheKey = `${attributeName}:${value}`;

    if (this.objectReferenceCache.has(cacheKey)) {
      const cached = this.objectReferenceCache.get(cacheKey);
      if (Array.isArray(cached) && cached.length > 0) {
        return cached[0];
      }
      if (typeof cached === "string") {
        return cached;
      }
    }

    console.log(`    Looking up ${attributeName} object for: ${value}`);

    try {
      // Determine the target object type ID
      // Priority: explicit referenceObjectTypeId > env var > null
      let objectTypeId = referenceObjectTypeId || null;

      if (!objectTypeId) {
        const normalizedAttrName = attributeName.toLowerCase();
        if (
          normalizedAttrName === "company" &&
          process.env.COMPANY_OBJECT_TYPE_ID
        ) {
          objectTypeId = process.env.COMPANY_OBJECT_TYPE_ID;
        } else if (
          normalizedAttrName === "license" &&
          (process.env.LICENSE_OBJECT_TYPE_ID || DEFAULT_LICENSE_OBJECT_TYPE_ID)
        ) {
          objectTypeId =
            process.env.LICENSE_OBJECT_TYPE_ID ||
            DEFAULT_LICENSE_OBJECT_TYPE_ID;
        } else if (
          normalizedAttrName === "location" &&
          process.env.LOCATION_OBJECT_TYPE_ID
        ) {
          objectTypeId = process.env.LOCATION_OBJECT_TYPE_ID;
        }
      }

      // Build AQL query — use objectType filter when we have a referenceObjectTypeId
      const escapedValue = this.escapeAQLValue(value);
      let aqlQuery;
      if (objectTypeId) {
        aqlQuery = `objectTypeId = ${objectTypeId} AND Name = "${escapedValue}"`;
      } else {
        // Fallback: search by name without object type filter
        aqlQuery = `Name = "${escapedValue}"`;
        if (this.options.debug) {
          console.log(
            `      ⚠️  No referenceObjectTypeId for ${attributeName}, searching without object type filter`,
          );
        }
      }

      if (this.options.debug) {
        console.log(`      AQL Query: ${aqlQuery}`);
      }

      const response = await this.cloudApiClient.executeAQL(
        aqlQuery,
        0,
        10,
        true,
      );

      const objectEntries = response?.values || response?.objectEntries || [];
      if (this.options.debug) {
        console.log(`      Object entries found: ${objectEntries.length}`);
      }

      if (objectEntries.length > 0) {
        // Cache all potential matches for retry logic
        const allPotentialMatches = objectEntries.map(
          (obj) => obj.key || obj.objectKey,
        );
        this.objectReferenceCache.set(cacheKey, allPotentialMatches);

        // Also store in legacy caches for updateUser retry logic compatibility
        const normalizedAttrName = attributeName.toLowerCase();
        if (normalizedAttrName === "license") {
          this.licenseObjectCache.set(cacheKey, allPotentialMatches);
        } else if (normalizedAttrName === "company") {
          this.companyObjectCache.set(cacheKey, allPotentialMatches);
        } else if (normalizedAttrName === "location") {
          this.locationObjectCache.set(cacheKey, allPotentialMatches);
        } else {
          this.departmentObjectCache.set(cacheKey, allPotentialMatches);
        }

        // Validate each match
        for (let i = 0; i < objectEntries.length; i++) {
          const object = objectEntries[i];

          if (this.options.debug) {
            console.log(
              `      Validating match ${i + 1}/${objectEntries.length}: ${object.label || object.name} (Key: ${object.key || object.objectKey})`,
            );
          }

          if (this.validateObjectMatch(attributeName, value, object)) {
            const objectKey = object.key || object.objectKey;
            console.log(
              `      ✅ Found ${attributeName}: ${object.label || object.name} (Key: ${objectKey})`,
            );
            return objectKey;
          }
        }

        console.warn(
          `      ⚠️  All ${objectEntries.length} matches failed validation for "${value}"`,
        );
        return "";
      }

      console.warn(`      ${attributeName} not found: ${value}`);
      return "";
    } catch (error) {
      console.warn(`      Error looking up ${attributeName}: ${error.message}`);
      return "";
    }
  }

  /**
   * Validate if a cloud object matches the lookup value (following reference pattern)
   *
   * @param {string} attributeName - Name of the attribute being looked up
   * @param {string} value - The value to match against
   * @param {Object} cloudObject - Cloud object from AQL
   * @returns {boolean} - True if match is valid
   */
  validateObjectMatch(attributeName, value, cloudObject) {
    const normalizedAttrName = attributeName.toLowerCase();

    // Check if names match (case-insensitive, normalized)
    if (value && cloudObject.name) {
      const normalizedValue = this.normalizeString(value);
      const normalizedCloudName = this.normalizeString(cloudObject.name);
      if (normalizedValue === normalizedCloudName) {
        return true;
      }
    }

    // Check if keys match (case-insensitive, normalized)
    if (value && cloudObject.key) {
      const normalizedValue = this.normalizeString(value);
      const normalizedCloudKey = this.normalizeString(cloudObject.key);
      if (normalizedValue === normalizedCloudKey) {
        return true;
      }
    }

    // Check if labels match (for objects where label is the display name)
    if (value && cloudObject.label) {
      const normalizedValue = this.normalizeString(value);
      const normalizedLabel = this.normalizeString(cloudObject.label);
      if (normalizedValue === normalizedLabel) {
        return true;
      }
    }

    // Additional validation for specific object types
    if (normalizedAttrName === "company") {
      // Company-specific validation: match by name with additional checks
      if (value && cloudObject.name) {
        // Exact match preferred
        if (value.toLowerCase() === cloudObject.name.toLowerCase()) {
          return true;
        }
        // Fuzzy match for slight variations
        const valueNorm = this.normalizeString(value);
        const cloudNorm = this.normalizeString(cloudObject.name);
        if (valueNorm.includes(cloudNorm) || cloudNorm.includes(valueNorm)) {
          return true;
        }
      }
    } else if (normalizedAttrName === "department") {
      // Department-specific validation: broader matching
      if (value && cloudObject.name) {
        const valueNorm = this.normalizeString(value);
        const cloudNorm = this.normalizeString(cloudObject.name);
        // More permissive matching for departments
        if (
          valueNorm === cloudNorm ||
          valueNorm.includes(cloudNorm) ||
          cloudNorm.includes(valueNorm)
        ) {
          return true;
        }
      }
    } else if (normalizedAttrName === "location") {
      // Location-specific validation: match by name or key
      if (value && cloudObject.name) {
        const valueNorm = this.normalizeString(value);
        const cloudNorm = this.normalizeString(cloudObject.name);
        if (valueNorm === cloudNorm) {
          return true;
        }
      }
    } else if (normalizedAttrName === "license") {
      // License-specific validation: exact match preferred
      if (value && cloudObject.name) {
        if (value.toLowerCase() === cloudObject.name.toLowerCase()) {
          return true;
        }
      }
    }

    return false;
  }

  getAttributeValue(asset, attributeName) {
    if (!asset.attributes || !Array.isArray(asset.attributes)) {
      return "";
    }

    // Find attribute by ID using ID-to-name mapping
    // AQL responses only include objectTypeAttributeId, not the full object with name
    const attr = asset.attributes.find((a) => {
      // Look up the attribute name using the ID
      const attrName = this.attributeIdToNameMap[a.objectTypeAttributeId];
      return attrName && attrName.toLowerCase() === attributeName.toLowerCase();
    });
    if (
      !attr ||
      !attr.objectAttributeValues ||
      !Array.isArray(attr.objectAttributeValues) ||
      attr.objectAttributeValues.length === 0
    ) {
      return "";
    }

    const attrVal = attr.objectAttributeValues[0];
    const value = attrVal.value;
    const attrId = attr.objectTypeAttributeId;
    const attrTypeInfo = this.attributeIdToTypeInfoMap[attrId];

    // For Object Reference (Type 1) and Status (Type 7) attributes,
    // the API returns value as undefined/null and puts the text in displayValue.
    // Fall back to displayValue when value is missing.
    if (
      attrTypeInfo &&
      (attrTypeInfo.type === 1 || attrTypeInfo.type === 7) &&
      (value === undefined || value === null) &&
      attrVal.displayValue
    ) {
      return attrVal.displayValue;
    }

    return value;
  }

  getAttributeValueDebug(asset, attributeName) {
    // Debug version to show what's happening
    if (!asset) {
      console.log(`    DEBUG getAttributeValue: Asset is null/undefined`);
      return "";
    }

    if (!asset.attributes) {
      console.log(
        `    DEBUG getAttributeValue: Asset has no 'attributes' property. Keys: ${Object.keys(asset).join(", ")}`,
      );
      return "";
    }

    if (!Array.isArray(asset.attributes)) {
      console.log(
        `    DEBUG getAttributeValue: Asset.attributes is not an array. Type: ${typeof asset.attributes}, Value: ${JSON.stringify(asset.attributes)}`,
      );
      return "";
    }

    console.log(
      `    DEBUG getAttributeValue: Looking for "${attributeName}" in asset with ${asset.attributes.length} attributes`,
    );

    // Show all attribute names for debugging
    console.log(`    DEBUG getAttributeValue: ALL available attribute names:`);
    const allNames = [];
    for (const a of asset.attributes) {
      // Look up attribute name using ID-to-name map
      const attrName = this.attributeIdToNameMap[a.objectTypeAttributeId];
      if (attrName) {
        allNames.push(attrName);
      }
    }
    console.log(`      [${allNames.join(", ")}]`);

    // Show first few attributes for debugging
    if (asset.attributes.length > 0) {
      console.log(`    DEBUG getAttributeValue: First 3 attributes (full):`);
      for (let i = 0; i < Math.min(3, asset.attributes.length); i++) {
        const a = asset.attributes[i];
        console.log(`      Attr ${i}: ${JSON.stringify(a)}`);
      }
    }

    // Find attribute by ID using ID-to-name mapping
    // AQL responses only include objectTypeAttributeId, not the full object with name
    const attr = asset.attributes.find((a) => {
      // Look up the attribute name using the ID
      const attrName = this.attributeIdToNameMap[a.objectTypeAttributeId];
      return attrName && attrName.toLowerCase() === attributeName.toLowerCase();
    });

    if (!attr) {
      console.log(
        `    DEBUG getAttributeValue: No attribute found for "${attributeName}" (case-insensitive match attempted)`,
      );
      // Show closest matches
      const searchLower = attributeName.toLowerCase();
      const closeMatches = allNames.filter(
        (name) =>
          name.toLowerCase().includes(searchLower) ||
          searchLower.includes(name.toLowerCase()),
      );
      if (closeMatches.length > 0) {
        console.log(
          `    DEBUG getAttributeValue: Close matches: ${closeMatches.join(", ")}`,
        );
      }
      return "";
    }

    console.log(
      `    DEBUG getAttributeValue: Found attribute. objectTypeAttributeValues: ${JSON.stringify(attr.objectAttributeValues)}`,
    );

    if (
      !attr.objectAttributeValues ||
      !Array.isArray(attr.objectAttributeValues) ||
      attr.objectAttributeValues.length === 0
    ) {
      console.log(`    DEBUG getAttributeValue: Attribute has no valid values`);
      return "";
    }

    const attrVal = attr.objectAttributeValues[0];
    const value = attrVal.value;
    const attrId = attr.objectTypeAttributeId;
    const attrTypeInfo = this.attributeIdToTypeInfoMap[attrId];

    // For Object Reference (Type 1) and Status (Type 7) attributes,
    // the API returns value as undefined/null and puts the text in displayValue
    // or in a nested object (status.name for Status, referencedObject for Ref).
    if (
      attrTypeInfo &&
      (attrTypeInfo.type === 1 || attrTypeInfo.type === 7) &&
      (value === undefined || value === null)
    ) {
      // Status type: prefer status.name, then displayValue
      if (attrTypeInfo.type === 7 && attrVal.status && attrVal.status.name) {
        console.log(
          `    DEBUG getAttributeValue: Status type - returning status.name: "${attrVal.status.name}"`,
        );
        return attrVal.status.name;
      }
      if (attrVal.displayValue) {
        console.log(
          `    DEBUG getAttributeValue: Type ${attrTypeInfo.type} - returning displayValue: "${attrVal.displayValue}" (value: "${value}")`,
        );
        return attrVal.displayValue;
      }
    }

    console.log(`    DEBUG getAttributeValue: Returning value: "${value}"`);
    return value;
  }

  normalizeValue(value, attributeType) {
    if (value === undefined || value === null) {
      return "";
    }

    // Handle array types (e.g., businessPhones)
    if (Array.isArray(value)) {
      return value.join(", ");
    }

    // Handle Boolean/Checkbox types (type 12 = Checkbox)
    if (attributeType === 12) {
      if (typeof value === "boolean") {
        return value ? "true" : "false";
      }
      if (typeof value === "string") {
        const lowerValue = value.toLowerCase();
        if (
          lowerValue === "true" ||
          lowerValue === "yes" ||
          lowerValue === "1"
        ) {
          return "true";
        }
        if (
          lowerValue === "false" ||
          lowerValue === "no" ||
          lowerValue === "0"
        ) {
          return "false";
        }
      }
    }

    // Handle Status type (type 7) — normalize to Active/Inactive (case-insensitive)
    if (attributeType === 7) {
      if (typeof value === "boolean") {
        return value ? "Active" : "Inactive";
      }
      if (typeof value === "string") {
        const lowerValue = value.trim().toLowerCase();
        if (lowerValue === "active") return "Active";
        if (lowerValue === "inactive") return "Inactive";
      }
    }

    // Handle Date types (type 16 = Date, type 10 = DateTime)
    if (attributeType === 16 || attributeType === 10) {
      return String(value);
    }

    // Convert to string and trim
    return String(value).trim();
  }

  convertValue(value, attributeType) {
    if (value === undefined || value === null) {
      return "";
    }

    // Handle array types
    if (Array.isArray(value)) {
      return value.join(", ");
    }

    // Handle Select/Status type attributes (type 7) — normalize case
    if (attributeType === 7) {
      if (typeof value === "boolean") {
        return value ? "Active" : "Inactive";
      }
      if (typeof value === "string") {
        const lowerValue = value.trim().toLowerCase();
        if (lowerValue === "active") return "Active";
        if (lowerValue === "inactive") return "Inactive";
      }
    }

    // Handle Boolean for other types
    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }

    return String(value);
  }

  normalizeString(str) {
    if (!str) {
      return "";
    }
    return str.toLowerCase().trim().replace(/\s+/g, "");
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Escape special characters in AQL values
   */
  escapeAQLValue(str) {
    if (!str) return str;
    // Escape quotes and backslashes for AQL
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  printSummary() {
    const duration = this.stats.endTime - this.stats.startTime;
    const durationStr = this.formatDuration(duration);

    const graphStats = this.graphApiClient.getStats();
    const cloudStats = this.cloudApiClient.getStats();

    console.log();
    console.log("=".repeat(60));
    console.log("Ingestion Summary");
    console.log("=".repeat(60));
    console.log(`Duration: ${durationStr}`);
    console.log();
    console.log("Users:");
    console.log(`  Total users fetched: ${this.stats.totalUsersFetched}`);
    console.log(`  Existing users matched: ${this.stats.existingUsersMatched}`);
    console.log(`  New users created: ${this.stats.newUsersCreated}`);
    console.log(`  Existing users updated: ${this.stats.existingUsersUpdated}`);
    console.log(
      `  Users skipped (dry-run/no changes): ${this.stats.usersSkipped}`,
    );
    console.log(`  Users failed: ${this.stats.usersFailed}`);
    console.log();
    console.log("API Statistics:");
    console.log(
      `  Microsoft Graph API: ${graphStats.totalRequests} requests, ${graphStats.totalErrors} errors (${graphStats.errorRate})`,
    );
    console.log(
      `  Jira Cloud Assets API: ${cloudStats.totalRequests} requests, ${cloudStats.totalErrors} errors (${cloudStats.errorRate})`,
    );
    console.log();

    if (this.stats.errors.length > 0) {
      console.log("Errors:");
      this.stats.errors.slice(0, 5).forEach((error) => {
        console.log(`  - ${error.user}: ${error.error}`);
      });
      if (this.stats.errors.length > 5) {
        console.log(`  ... and ${this.stats.errors.length - 5} more errors`);
      }
      console.log();
    }
  }

  saveReport() {
    const logsDir = path.join(__dirname, "..", "logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(logsDir, `ingestion-report-${timestamp}.json`);

    const duration = this.stats.endTime - this.stats.startTime;

    const report = {
      timestamp: new Date().toISOString(),
      options: this.options,
      duration: duration,
      durationString: this.formatDuration(duration),
      stats: this.stats,
      graphApiStats: this.graphApiClient.getStats(),
      cloudApiStats: this.cloudApiClient.getStats(),
      errors: this.stats.errors,
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Report saved to: ${reportPath}`);
  }

  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    preview: false,
    limit: 0,
    debug: false,
    mapping: null,
    schemaId: null,
    objectTypeId: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--preview":
        options.preview = true;
        break;
      case "--debug":
        options.debug = true;
        process.env.DEBUG = "true";
        break;
      case "--limit":
        options.limit = parseInt(args[++i]) || 0;
        break;
      case "--mapping":
        options.mapping = args[++i];
        break;
      case "--schema-id":
        options.schemaId = parseInt(args[++i]) || null;
        break;
      case "--object-type-id":
        options.objectTypeId = parseInt(args[++i]) || null;
        break;
      case "--help":
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Microsoft Graph User Ingestion to Jira Cloud Assets
=====================================================

Usage: node main/ingest_ms_graph_users.js [options]

Options:
  --dry-run           Process without creating/updating assets
  --preview             Preview users from Microsoft Graph without processing
  --limit <number>     Limit number of users to process (for testing)
  --debug               Enable debug logging
  --mapping <file>      Use custom attribute mapping file
  --schema-id <id>     Target object schema ID (default: from env or 15)
  --object-type-id <id> Target object type ID (default: from env or 153)
  --help                Show this help message

Examples:
  npm start                           # Run ingestion
  npm run dry-run                     # Dry run
  npm start -- --limit 10             # Process only 10 users
  npm start -- --mapping custom.json    # Use custom mapping
  npm run preview                     # Preview users

Environment Variables:
  See .env.example for the complete list
`);
}

// Main entry point
const options = parseArgs();
const ingestion = new MicrosoftGraphUserIngestion(options);

ingestion.run().catch((error) => {
  console.error("\nFatal error:", error.message);
  console.error(error);
  process.exit(1);
});
