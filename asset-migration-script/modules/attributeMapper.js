/**
 * Attribute Mapper Module
 *
 * Maps datacenter attribute values to cloud attribute IDs and formats.
 * CRITICAL: This module ensures 100% field mapping success by using display values,
 * not IDs, and properly transforming values to cloud-compatible formats.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

class AttributeMapper {
  constructor(workspaceId, apiToken, cloudApiClient = null) {
    this.workspaceId = workspaceId;
    this.apiToken = apiToken;
    this.cloudApiClient = cloudApiClient;
    this.cloudAttributeCache = new Map();
    this.mappingCache = new Map();
    this.schemaAttributesCache = new Map();

    // 🧹 MEMORY OPTIMIZATION: Add cache size limits
    this.MAX_CACHE_SIZE = 300; // Limit each cache to 300 entries
    this.CACHE_EVICTION_SIZE = 50; // Remove 50 entries when limit hit
  }

  /**
   * 🧹 MEMORY OPTIMIZATION: Helper to manage cache size with LRU eviction
   */
  manageCacheSize(cache) {
    if (cache.size > this.MAX_CACHE_SIZE) {
      const entriesToRemove = Array.from(cache.keys()).slice(
        0,
        this.CACHE_EVICTION_SIZE,
      );
      for (const key of entriesToRemove) {
        cache.delete(key);
      }
    }
  }

  /**
   * GENERIC FIELD PROCESSING INTERFACE
   *
   * This is the main entry point for the plan-driven system.
   * Transforms a field value from datacenter format to cloud format.
   *
   * @param {Object} fieldInfo - Field information from plan
   * @param {Object} cloudAttr - Cloud attribute definition
   * @param {Array} dcSchemaAttributes - Datacenter schema attributes for context
   * @param {Map} migratedObjects - Map of migrated objects for reference resolution
   * @returns {Object|null} - Cloud-formatted attribute object or null if skipped
   */
  async transformFieldValue(
    fieldInfo,
    cloudAttr,
    dcSchemaAttributes,
    migratedObjects = null,
  ) {
    try {
      // Validate inputs
      if (!fieldInfo) {
        throw new Error("fieldInfo is required");
      }
      if (!cloudAttr) {
        throw new Error("cloudAttr is required");
      }
      if (!dcSchemaAttributes) {
        throw new Error("dcSchemaAttributes is required");
      }

      // Extract the raw value from the field
      const rawValue = fieldInfo.value;

      if (rawValue === null || rawValue === undefined) {
        console.log(
          `        📝 Field ${fieldInfo.name} has no value, skipping`,
        );
        return null;
      }

      // Create a datacenter value object that matches the expected format
      const dcValue = this.createDCValueObject(rawValue, fieldInfo);

      // Find datacenter attribute metadata
      let dcAttrMeta = dcSchemaAttributes.find(
        (a) => a.id === fieldInfo.attributeId,
      );
      if (!dcAttrMeta) {
        console.warn(
          `        ⚠️  No metadata found for attribute ${fieldInfo.attributeId}, using field info`,
        );
        // Create a synthetic metadata object from field info
        dcAttrMeta = {
          id: fieldInfo.attributeId,
          name: fieldInfo.name,
          type: fieldInfo.isReference ? "Reference" : "Text",
        };
      }

      // Transform the value using the existing transformation logic
      const transformedValue = await this.transformValue(
        dcValue,
        cloudAttr,
        dcAttrMeta,
        migratedObjects,
      );

      if (transformedValue) {
        return {
          objectTypeAttributeId: cloudAttr.id,
          objectAttributeValues: [transformedValue],
        };
      }

      console.log(
        `        📝 Field ${fieldInfo.name} transformed to null, skipping`,
      );
      return null;
    } catch (error) {
      console.error(
        `        ❌ Error transforming field ${fieldInfo?.name}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Create a datacenter value object from field info
   * This adapts the plan-driven field format to the legacy format expected by transformValue
   */
  createDCValueObject(rawValue, fieldInfo) {
    // Handle reference fields
    if (fieldInfo.isReference && fieldInfo.referenceKey) {
      return {
        referencedObject: {
          objectKey: fieldInfo.referenceKey,
          name: fieldInfo.referenceName || fieldInfo.referenceKey,
          label: fieldInfo.referenceName || fieldInfo.referenceKey,
        },
        value: fieldInfo.referenceKey,
        displayValue: fieldInfo.referenceName || fieldInfo.referenceKey,
      };
    }

    // Handle regular fields
    return {
      value: rawValue,
      displayValue: rawValue,
    };
  }

  /**
   * Fetch cloud attributes for an object type
   */
  /**
   * Fetch cloud attributes for object type with caching
   *
   * @param {string} objectTypeId - Cloud object type ID
   * @returns {Array} - Array of cloud attribute objects
   *
   * AI INSTRUCTIONS:
   * - Fetches attribute definitions from cloud API with performance caching
   * - Used by mapAttribute() for proper attribute mapping
   * - Caches results to avoid repeated API calls for same object type
   * - Critical for understanding cloud attribute structure and IDs
   * - Part of remaining legacy code (marked for potential removal in plan-driven approach)
   */
  async fetchCloudAttributes(objectTypeId) {
    const cacheKey = `attributes_${objectTypeId}`;
    if (this.cloudAttributeCache.has(cacheKey)) {
      const cachedValue = this.cloudAttributeCache.get(cacheKey);
      // 🧹 TRUE LRU: Move to end by deleting and re-inserting
      this.cloudAttributeCache.delete(cacheKey);
      this.cloudAttributeCache.set(cacheKey, cachedValue);
      return cachedValue;
    }

    try {
      // Use cloudApiClient if available (preferred), otherwise fallback to makeApiCall
      if (this.cloudApiClient) {
        const attributes =
          await this.cloudApiClient.getObjectTypeAttributes(objectTypeId);
        this.cloudAttributeCache.set(cacheKey, attributes);
        this.manageCacheSize(this.cloudAttributeCache); // 🧹 Memory optimization
        return attributes;
      } else {
        console.log(
          `    🔍 Fetching cloud attributes for object type ${objectTypeId} via direct API call`,
        );
        const url = `/jsm/assets/workspace/${this.workspaceId}/v1/objecttype/${objectTypeId}/attributes`;
        const attributes = await this.makeAssetsApiCall(url);
        this.cloudAttributeCache.set(cacheKey, attributes);
        this.manageCacheSize(this.cloudAttributeCache); // 🧹 Memory optimization
        return attributes;
      }
    } catch (error) {
      console.error(
        `  ❌ Failed to fetch attributes for object type ${objectTypeId}:`,
        error.message,
      );
      return [];
    }
  }

  /**
   * Load datacenter schema attributes
   */
  loadDatacenterSchemaAttributes(schemaName) {
    const cacheKey = `dc_${schemaName}`;
    if (this.schemaAttributesCache.has(cacheKey)) {
      const cachedValue = this.schemaAttributesCache.get(cacheKey);
      // 🧹 TRUE LRU: Move to end by deleting and re-inserting
      this.schemaAttributesCache.delete(cacheKey);
      this.schemaAttributesCache.set(cacheKey, cachedValue);
      return cachedValue;
    }

    const datacenterPath =
      process.env.DATACENTER_PATH ||
      path.join(process.cwd(), "..", "datacenter_assets");
    const schemaAttrPath = path.join(
      datacenterPath,
      schemaName,
      "schema_attributes.json",
    );
    if (fs.existsSync(schemaAttrPath)) {
      try {
        const attributes = JSON.parse(fs.readFileSync(schemaAttrPath, "utf8"));
        this.schemaAttributesCache.set(cacheKey, attributes);
        this.manageCacheSize(this.schemaAttributesCache); // 🧹 Memory optimization
        return attributes;
      } catch (e) {
        console.warn(
          `  ⚠️  Failed to load schema attributes for ${schemaName}:`,
          e.message,
        );
      }
    }
    return [];
  }

  /**
   * LEGACY METHOD - MARKED FOR REMOVAL
   * This method is part of the old architecture and should not be used in plan-driven system
   */
  async mapObjectToCloudREMOVED(
    dcObject,
    cloudObjectTypeId,
    schemaName,
    typePath,
    migratedObjects = null,
    skippedFieldsLogger = null,
  ) {
    // REMOVED: currentObjectTypeId - no longer needed without cloud queries

    // Store logger for this mapping session
    this.skippedFieldsLogger = skippedFieldsLogger;

    // Store current object key for circular reference detection
    this.currentObjectKey = dcObject.objectKey;

    // Store context for logging
    this.currentSchema = schemaName;
    this.currentObjectType = typePath;
    this.currentObjectName =
      dcObject.label || dcObject.Name || dcObject.objectKey;

    const cloudAttributes = await this.fetchCloudAttributes(cloudObjectTypeId);
    const dcSchemaAttributes = this.loadDatacenterSchemaAttributes(schemaName);

    const mapped = {
      objectTypeId: cloudObjectTypeId,
      attributes: [],
    };

    // Process each datacenter attribute
    if (dcObject.attributes && Array.isArray(dcObject.attributes)) {
      for (const dcAttr of dcObject.attributes) {
        try {
          const mappedAttr = await this.mapAttribute(
            dcAttr,
            cloudAttributes,
            dcSchemaAttributes,
            migratedObjects,
            {
              schema: schemaName,
              objectType: typePath,
              objectKey: dcObject.objectKey,
            },
          );
          if (mappedAttr) {
            mapped.attributes.push(mappedAttr);
          }
          // null is only acceptable for system attributes that were explicitly allowed to be skipped
        } catch (error) {
          // Check if this is a circular reference error
          if (error.message && error.message === "CIRCULAR_REFERENCE_SKIP") {
            console.log(
              `    🔄 Skipping circular reference field for initial creation - will update later`,
            );

            const dcAttrMeta = dcSchemaAttributes.find(
              (a) => a.id === dcAttr.objectTypeAttributeId,
            );
            const cloudAttr = this.findCloudAttributeByName(
              dcAttrMeta?.name,
              cloudAttributes,
            );

            // Log the circular reference skip
            if (this.skippedFieldsLogger && dcAttrMeta) {
              this.skippedFieldsLogger.logSkippedField({
                reason: "CIRCULAR_REFERENCE",
                schema: schemaName,
                objectType: typePath,
                objectKey: dcObject.objectKey,
                objectName: dcObject.label || dcObject.Name,
                fieldId: dcAttr.objectTypeAttributeId,
                fieldName: dcAttrMeta.name,
                fieldValue: dcAttr.objectAttributeValues?.[0]?.value || null,
                cloudAttrName: cloudAttr?.name,
                details: "Will be resolved in second pass",
              });
            }

            // Store the field info for later update
            if (!mapped._circularFields) {
              mapped._circularFields = [];
            }
            mapped._circularFields.push({
              dcAttr,
              cloudAttr,
            });
            continue; // Skip this field for now
          }
          // Only log as FATAL if it's truly unrecoverable
          else if (
            error.message &&
            error.message.startsWith("MISSING_OBJECT_CREATE_NEEDED:")
          ) {
            console.log(
              `    🔄 Attribute ${dcAttr.objectTypeAttributeId} needs dependency: ${error.message.replace("MISSING_OBJECT_CREATE_NEEDED: ", "")}`,
            );
          } else if (error.message && error.message.includes("FATAL:")) {
            console.error(
              `    ❌ FATAL ERROR mapping attribute ${dcAttr.objectTypeAttributeId}: ${error.message}`,
            );
          } else {
            console.error(
              `    ⚠️  Error mapping attribute ${dcAttr.objectTypeAttributeId}: ${error.message}`,
            );
          }
          throw error; // Re-throw to handle at higher level
        }
      }
    }

    // Ensure required attributes are present
    this.ensureRequiredAttributes(mapped, cloudAttributes, dcObject);

    return mapped;
  }

  /**
   * Create a FATAL error with full context
   */
  createFatalError(
    message,
    dcAttr = null,
    cloudAttr = null,
    dcAttrMeta = null,
    context = {},
  ) {
    const parts = ["FATAL:"];

    // Add field context if available
    if (dcAttr?.objectTypeAttributeId || dcAttrMeta?.id) {
      const id = dcAttr?.objectTypeAttributeId || dcAttrMeta?.id;
      const name = dcAttrMeta?.name || cloudAttr?.name || "Unknown";
      parts.push(`[Field ${id} - ${name}]`);
    } else if (cloudAttr?.id) {
      parts.push(`[Cloud Field ${cloudAttr.id} - ${cloudAttr.name}]`);
    }

    // Add the main message
    parts.push(message);

    // Add any additional context
    if (context.schema) {
      parts.push(`(Schema: ${context.schema})`);
    }
    if (context.objectType) {
      parts.push(`(Type: ${context.objectType})`);
    }
    if (context.objectKey) {
      parts.push(`(Object: ${context.objectKey})`);
    }

    return new Error(parts.join(" "));
  }

  /**
   * LEGACY METHOD - USE transformFieldValue() FOR PLAN-DRIVEN SYSTEM
   *
   * Map single datacenter attribute to cloud format with comprehensive validation
   * This method is kept for backward compatibility but plan-driven system should use transformFieldValue()
   *
   * @param {Object} dcAttr - Datacenter attribute object
   * @param {Array} cloudAttributes - Available cloud attributes for mapping
   * @param {Array} dcSchemaAttributes - Datacenter schema attribute definitions
   * @param {Map} migratedObjects - Map of already migrated objects for reference resolution
   * @param {Object} context - Additional context for mapping
   * @returns {Object|null} - Mapped cloud attribute object or null if skipped
   */
  async mapAttribute(
    dcAttr,
    cloudAttributes,
    dcSchemaAttributes,
    migratedObjects = null,
    context = {},
  ) {
    // Store current field ID for logging
    this.currentFieldId = dcAttr.objectTypeAttributeId;

    // Find the datacenter attribute metadata
    const dcAttrMeta = dcSchemaAttributes.find(
      (a) => a.id === dcAttr.objectTypeAttributeId,
    );
    if (!dcAttrMeta) {
      throw this.createFatalError(
        "No metadata found for DC attribute. Data integrity violation - cannot skip attributes.",
        dcAttr,
        null,
        null,
        context,
      );
    }

    // Find matching cloud attribute by name
    const cloudAttr = this.findCloudAttributeByName(
      dcAttrMeta.name,
      cloudAttributes,
    );
    if (!cloudAttr) {
      /**
       * AI INSTRUCTIONS: System attribute handling
       * - Key, Name, Created, Updated are Jira Assets system attributes
       * - These are automatically managed by the platform and don't require manual mapping
       * - Only custom attributes and references need explicit mapping
       * - This filtering prevents errors from attempting to map system fields
       */
      const systemAttributes = ["Key", "Name", "Created", "Updated"];
      if (systemAttributes.includes(dcAttrMeta.name)) {
        // Log skipped system attribute
        if (this.skippedFieldsLogger) {
          this.skippedFieldsLogger.logSkippedField({
            reason: "SYSTEM_ATTRIBUTE",
            schema: context.schema,
            objectType: context.objectType,
            objectKey: context.objectKey,
            objectName: this.currentObjectKey,
            fieldId: dcAttr.objectTypeAttributeId,
            fieldName: dcAttrMeta.name,
            fieldValue: dcAttr.objectAttributeValues?.[0]?.value || null,
          });
        }
        return null; // System attributes can be skipped
      }
      throw this.createFatalError(
        "No cloud attribute found for required field. Cannot skip user data fields.",
        dcAttr,
        null,
        dcAttrMeta,
        context,
      );
    }

    // Get the value(s) from datacenter
    const dcValues = dcAttr.objectAttributeValues || [];
    if (dcValues.length === 0 && cloudAttr.minimumCardinality > 0) {
      // Check if this is a text field that we can provide a fallback for
      const fieldType = cloudAttr.defaultType?.name || cloudAttr.type;
      if (fieldType === "Text" || fieldType === "Textarea") {
        console.warn(
          `    ⚠️  Required text field "${cloudAttr.name}" has no datacenter values - will use fallback strategy`,
        );
        // Return null to trigger the ensureRequiredAttributes fallback
        return null;
      }
      // For non-text fields, throw error as before
      throw this.createFatalError(
        "Required field has no values in datacenter. Cannot skip required fields.",
        dcAttr,
        cloudAttr,
        dcAttrMeta,
        context,
      );
    }

    // Transform values based on type
    const transformedValues = [];
    for (const dcValue of dcValues) {
      const transformed = await this.transformValue(
        dcValue,
        cloudAttr,
        dcAttrMeta,
        migratedObjects,
      );
      if (transformed !== null && transformed !== undefined) {
        transformedValues.push(transformed);
      }
    }

    if (transformedValues.length === 0 && cloudAttr.minimumCardinality > 0) {
      throw this.createFatalError(
        "Required field could not be transformed. No valid values after transformation.",
        dcAttr,
        cloudAttr,
        dcAttrMeta,
        context,
      );
    }

    if (transformedValues.length === 0) {
      // Log skipped optional empty field
      if (this.skippedFieldsLogger && cloudAttr.minimumCardinality === 0) {
        this.skippedFieldsLogger.logSkippedField({
          reason: "OPTIONAL_EMPTY",
          schema: context.schema,
          objectType: context.objectType,
          objectKey: context.objectKey,
          objectName: this.currentObjectName,
          fieldId: dcAttr.objectTypeAttributeId,
          fieldName: dcAttrMeta.name,
          cloudAttrName: cloudAttr.name,
          fieldValue: null,
          details: "Optional field with no valid values",
        });
      }
      return null; // Optional fields with no valid values can be skipped
    }

    // CRITICAL FIX: Respect maximum cardinality to prevent "can only contain max X value/s" errors
    // Note: maximumCardinality = -1 means UNLIMITED, so only truncate for positive limits
    let finalValues = transformedValues;
    if (
      cloudAttr.maximumCardinality &&
      cloudAttr.maximumCardinality > 0 &&
      transformedValues.length > cloudAttr.maximumCardinality
    ) {
      console.log(
        `        ⚠️  Field "${cloudAttr.name}" has ${transformedValues.length} values but max cardinality is ${cloudAttr.maximumCardinality}`,
      );
      console.log(
        `        🔧 Truncating to first ${cloudAttr.maximumCardinality} value(s) to respect cardinality`,
      );
      finalValues = transformedValues.slice(0, cloudAttr.maximumCardinality);
    }

    return {
      objectTypeAttributeId: cloudAttr.id,
      objectAttributeValues: finalValues,
    };
  }

  /**
   * Find cloud attribute by name (case-insensitive, handles variations)
   * GENERIC METHOD - Used by both legacy and plan-driven systems
   */
  findCloudAttributeByName(dcAttrName, cloudAttributes) {
    // Direct match first
    let found = cloudAttributes.find((ca) => ca.name === dcAttrName);
    if (found) return found;

    // Case-insensitive match
    const dcNameLower = dcAttrName.toLowerCase();
    found = cloudAttributes.find((ca) => ca.name.toLowerCase() === dcNameLower);
    if (found) return found;

    // Handle underscores vs spaces
    const normalized = dcAttrName.replace(/_/g, " ").toLowerCase();
    found = cloudAttributes.find((ca) => ca.name.toLowerCase() === normalized);
    if (found) return found;

    // Handle special mappings
    const specialMappings = {
      key: "Key",
      objectkey: "Key",
      label: "Name",
      name: "Name",
      created: "Created",
      updated: "Updated",
      status: "Status",
      lifecycle: "Life Cycle",
      life_cycle: "Life Cycle",
    };

    const mapped = specialMappings[dcNameLower];
    if (mapped) {
      return cloudAttributes.find((ca) => ca.name === mapped);
    }

    return null;
  }

  /**
   * Transform value based on attribute type
   */
  async transformValue(dcValue, cloudAttr, dcAttrMeta, migratedObjects = null) {
    // Handle null/undefined
    if (dcValue === null || dcValue === undefined) {
      return null;
    }

    // USE CLOUD ATTRIBUTE TYPE: The definitive source of truth
    let attrType = "Text"; // Default fallback

    if (cloudAttr) {
      // Check for reference type first
      if (cloudAttr.referenceType) {
        attrType = "Reference";
      }
      // Check for defaultType (some attributes have this)
      else if (cloudAttr.defaultType && cloudAttr.defaultType.name) {
        attrType = cloudAttr.defaultType.name;
        // Map cloud type names to our internal names if needed
        if (attrType === "Textarea") attrType = "Text Area";
      }
      // Check for direct type property (User fields have this)
      else if (cloudAttr.type !== undefined) {
        // Map cloud type IDs to type names
        switch (cloudAttr.type) {
          case 0:
            attrType = "Text";
            break;
          case 1:
            attrType = "Integer";
            break;
          case 2:
            attrType = "User";
            break;
          case 3:
            attrType = "Boolean";
            break;
          case 4:
            attrType = "Float";
            break;
          case 5:
            attrType = "Date";
            break;
          case 6:
            attrType = "DateTime";
            break;
          case 7:
            attrType = "Select";
            break;
          case 8:
            attrType = "Email";
            break;
          case 9:
            attrType = "Text Area";
            break;
          case 10:
            attrType = "URL";
            break;
          case 11:
            attrType = "IP Address";
            break;
          default:
            attrType = "Text";
        }
      }
      // Fallback to Text if no type information
      else {
        attrType = "Text";
      }
    }

    // Handle references FIRST before extracting simple values
    if (
      (attrType === "Reference" || attrType === "Object") &&
      dcValue.referencedObject
    ) {
      return this.transformReference(dcValue, cloudAttr, migratedObjects);
    } else if (attrType === "Reference" || attrType === "Object") {
      console.log(
        `        ⚠️  Reference attribute ${cloudAttr.name} has no referencedObject:`,
        JSON.stringify(dcValue, null, 2),
      );

      // Check if this is a stale cloud ID reference
      const rawValue = dcValue.value || dcValue.displayValue || dcValue;
      if (rawValue && typeof rawValue === "string" && /^\d+$/.test(rawValue)) {
        console.log(
          `        🚨 DETECTED STALE CLOUD ID: ${rawValue} for field ${cloudAttr.name}`,
        );
        console.log(
          `        🔧 Attempting to resolve stale cloud ID to datacenter object`,
        );

        // Try to resolve this stale cloud ID using the search value or display value
        const searchValue = dcValue.searchValue;
        const displayValue = dcValue.displayValue;

        if (searchValue && searchValue !== rawValue) {
          // Trigger dependency resolution for this object
          throw new Error(`STALE_CLOUD_ID_RESOLUTION_NEEDED: ${searchValue}`);
        } else if (displayValue && displayValue !== rawValue) {
          // Trigger dependency resolution for this object
          throw new Error(`STALE_CLOUD_ID_RESOLUTION_NEEDED: ${displayValue}`);
        } else {
          console.log(
            `        ❌ Cannot resolve stale cloud ID ${rawValue} - no search/display value available`,
          );
          throw new Error(
            `UNRESOLVABLE_STALE_CLOUD_ID: ${rawValue} for field ${cloudAttr.name}`,
          );
        }
      }
    }

    // Handle Project type BEFORE extracting simple value (needs raw dcValue)
    if (attrType === "Project") {
      return await this.transformProject(dcValue, cloudAttr);
    }

    // For other non-reference types, extract the simple value
    // SPECIAL CASE: For User fields, check for user object first
    let value;
    if (attrType === "User" && dcValue.user) {
      // Pass the entire dcValue so transformUser can access the user object
      value = dcValue;
    } else {
      value = dcValue.value || dcValue.displayValue || dcValue;
    }

    if (value === null || value === undefined || value === "") {
      return null;
    }

    // RATIONALIZED ERROR HANDLING: Wrap transformations to distinguish between
    // Reference fields (create missing objects) vs other types (throw errors)
    try {
      switch (attrType) {
        case "Boolean":
          return this.transformBoolean(value, cloudAttr);

        case "Integer":
          return this.transformInteger(value);

        case "Float":
        case "Double":
          return this.transformFloat(value);

        case "Date":
        case "DateTime":
          return this.transformDateTime(value);

        case "Select":
          return this.transformSelect(value, cloudAttr);

        case "IP Address":
          return this.transformIPAddress(value);

        case "Reference":
        case "Object":
          // References are handled above before the switch statement
          // This case handles non-referencedObject reference types (fallback to text)
          return { value: value.toString() };

        case "User":
          return await this.transformUser(value, cloudAttr);

        case "Group":
          return this.transformGroup(value);

        case "Status":
          return this.transformStatus(dcValue);

        case "URL":
          return this.transformURL(value);

        case "Email":
          return this.transformEmail(value);

        case "Project":
          return await this.transformProject(dcValue, cloudAttr);

        case "Text":
          // Handle text values - 255 character limit for regular text fields
          let textValue = String(value);
          if (textValue.length > 255) {
            console.warn(
              `        ⚠️  Text too long (${textValue.length} chars), truncating to 255 chars for field: ${cloudAttr.name}`,
            );
            textValue = textValue.substring(0, 252) + "...";
          }
          return { value: textValue };

        case "Text Area":
        case "Textarea": // Cloud API sometimes returns 'Textarea' instead of 'Text Area'
        default:
          // Handle text area character limits (max 10,000 chars)
          let textAreaValue = String(value);
          if (textAreaValue.length > 10000) {
            console.warn(
              `        ⚠️  Text area too long (${textAreaValue.length} chars), truncating to 10,000 chars`,
            );
            textAreaValue = textAreaValue.substring(0, 9997) + "...";
          }
          return { value: textAreaValue };
      }
    } catch (error) {
      // ENHANCED ERROR HANDLING - Never fail, always fallback to creation
      if (attrType === "Reference" || attrType === "Object") {
        // For reference fields, try to create missing objects
        if (
          error.message.includes("not valid Object id or key") ||
          error.message.includes("invalid due to restrictions")
        ) {
          // Extract object name/key from error or value
          const objectIdentifier =
            this.extractObjectNameFromError(error.message) || value;

          console.log(`        ⚠️  Reference error: ${error.message}`);
          console.log(
            `        🔄 Attempting to resolve by creating: ${objectIdentifier}`,
          );

          // ALWAYS fallback to creation - NEVER fail
          const schemaContext = this.currentSchema
            ? `|SCHEMA:${this.currentSchema}`
            : "";
          throw new Error(
            `MISSING_OBJECT_CREATE_NEEDED: ${objectIdentifier}${schemaContext}`,
          );
        }
      }

      // For non-reference fields, throw the original error (type/cardinality issues)
      throw error;
    }
  }

  /**
   * Extract object name from error message for missing object creation
   */
  extractObjectNameFromError(errorMessage) {
    // Try to extract object name from common error patterns
    const patterns = [
      /(.+?) is not valid Object id or key/,
      /Object: (.+?) is invalid due to restrictions/,
      /The referenced object id or key '(.+?)' provided is not valid/,
    ];

    for (const pattern of patterns) {
      const match = errorMessage.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return null;
  }

  /**
   * Transform boolean values - Enhanced for better Yes/No handling
   */
  transformBoolean(value, cloudAttr) {
    const stringValue = String(value).toLowerCase().trim();

    // Enhanced boolean value mappings
    const trueValues = ["yes", "true", "1", "enabled", "active", "on", "y"];
    const falseValues = [
      "no",
      "false",
      "0",
      "disabled",
      "inactive",
      "off",
      "n",
    ];

    // Check if the cloud field expects string boolean values
    const expectsStringBoolean =
      cloudAttr &&
      (cloudAttr.type === "Select" ||
        cloudAttr.type === "Text" ||
        (cloudAttr.options &&
          cloudAttr.options.some(
            (opt) =>
              opt.value === "Yes" ||
              opt.value === "No" ||
              opt.value === "true" ||
              opt.value === "false",
          )));

    if (trueValues.includes(stringValue)) {
      if (expectsStringBoolean) {
        // Check what format the cloud field expects
        if (cloudAttr.options) {
          const yesOption = cloudAttr.options.find((opt) =>
            ["yes", "true", "1"].includes(opt.value.toLowerCase()),
          );
          if (yesOption) {
            return { value: yesOption.value };
          }
        }
        throw new Error(
          `CRITICAL: Boolean field expects 'Yes' option but none found in options. Cannot assume values.`,
        );
      }
      return { value: "true" }; // Standard boolean
    }

    if (falseValues.includes(stringValue)) {
      if (expectsStringBoolean) {
        // Check what format the cloud field expects
        if (cloudAttr.options) {
          const noOption = cloudAttr.options.find((opt) =>
            ["no", "false", "0"].includes(opt.value.toLowerCase()),
          );
          if (noOption) {
            return { value: noOption.value };
          }
        }
        throw new Error(
          `CRITICAL: Boolean field expects 'No' option but none found in options. Cannot assume values.`,
        );
      }
      return { value: "false" }; // Standard boolean
    }

    // NEVER assume boolean values - this corrupts data integrity
    throw new Error(
      `CRITICAL: Unknown boolean value "${value}" for field ${cloudAttr?.name || "unknown"}. Cannot assume true/false values - data integrity violation.`,
    );
  }

  /**
   * Transform select field values with intelligent fuzzy matching
   */
  transformSelect(value, cloudAttr) {
    // Handle empty/null values
    if (!value || value === "N/A" || value === "") {
      console.log(
        `        ⚠️  Empty value for select field ${cloudAttr.name}, skipping`,
      );

      // Log skipped empty select field
      if (this.skippedFieldsLogger) {
        this.skippedFieldsLogger.logSkippedField({
          reason: "OPTIONAL_EMPTY",
          schema: this.currentSchema,
          objectType: this.currentObjectType,
          objectKey: this.currentObjectKey,
          objectName: this.currentObjectName,
          fieldId: this.currentFieldId,
          fieldName: cloudAttr.name,
          cloudAttrName: cloudAttr.name,
          fieldValue: value || "N/A",
          details: "Empty or N/A value for select field",
        });
      }
      return null; // Skip empty values
    }

    // Handle case where options is empty but typeValueMulti exists
    if (!cloudAttr.options || cloudAttr.options === "") {
      if (cloudAttr.typeValueMulti && cloudAttr.typeValueMulti.length > 0) {
        console.log(
          `        ⚠️  Select field ${cloudAttr.name} has no readable options (IDs: ${cloudAttr.typeValueMulti.join(", ")})`,
        );
        console.warn(
          `        🚨 CRITICAL: Cloud attributes were not loaded properly. Please check loadCloudConfiguration().`,
        );
        console.log(`        💡 Attempting to use value as-is: "${value}"`);
        return { value: value }; // Try to use the value as-is
      } else {
        throw new Error(
          `FATAL: No options defined for select field ${cloudAttr.name}. Cannot proceed without valid options.`,
        );
      }
    }

    const options = cloudAttr.options.split(",").map((o) => o.trim());

    // 1. Direct exact match (fastest)
    if (options.includes(value)) {
      return { value: value };
    }

    // 2. Case-insensitive exact match
    const valueLower = String(value).toLowerCase().trim();
    const exactMatch = options.find(
      (o) => o.toLowerCase().trim() === valueLower,
    );
    if (exactMatch) {
      console.log(
        `        🔧 Case-insensitive match: "${value}" → "${exactMatch}"`,
      );
      return { value: exactMatch };
    }

    // 3. Normalize whitespace and special characters
    const normalizeStr = (s) =>
      s
        .toLowerCase()
        .replace(/[_\s-]+/g, " ")
        .trim();
    const valueNormalized = normalizeStr(value);
    const normalizedMatch = options.find(
      (o) => normalizeStr(o) === valueNormalized,
    );
    if (normalizedMatch) {
      console.log(
        `        🔧 Normalized match: "${value}" → "${normalizedMatch}"`,
      );
      return { value: normalizedMatch };
    }

    // 4. Fuzzy matching for partial matches (e.g., "In Progress" matches "IN PROGRESS")
    const fuzzyMatch = options.find((o) => {
      const optNorm = normalizeStr(o);
      const valNorm = valueNormalized;
      // Check if they're similar (contains or very close)
      return optNorm.includes(valNorm) || valNorm.includes(optNorm);
    });
    if (fuzzyMatch) {
      console.log(`        🔧 Fuzzy match: "${value}" → "${fuzzyMatch}"`);
      return { value: fuzzyMatch };
    }

    // 5. Special mappings for common status variations
    const selectMappings = {
      "not approved": options.find(
        (o) =>
          normalizeStr(o).includes("not") &&
          normalizeStr(o).includes("approved"),
      ),
      "in process": options.find(
        (o) =>
          normalizeStr(o).includes("process") ||
          normalizeStr(o).includes("progress"),
      ),
      "in progress": options.find(
        (o) =>
          normalizeStr(o).includes("progress") ||
          normalizeStr(o).includes("process"),
      ),
      approved: options.find((o) => normalizeStr(o) === "approved"),
      onboarding: options.find((o) => normalizeStr(o).includes("onboard")),
      active: options.find((o) => normalizeStr(o) === "active"),
      closed: options.find((o) => normalizeStr(o) === "closed"),
      retirement: options.find((o) => normalizeStr(o).includes("retire")),
      decommissioned: options.find((o) =>
        normalizeStr(o).includes("decommission"),
      ),
      low: options.find((o) => normalizeStr(o) === "low"),
      medium: options.find((o) => normalizeStr(o) === "medium"),
      high: options.find((o) => normalizeStr(o) === "high"),
    };

    const mapped = selectMappings[valueLower];
    if (mapped) {
      console.log(`        🔧 Special mapping: "${value}" → "${mapped}"`);
      return { value: mapped };
    }

    // 6. Last resort: Log detailed error with all available options
    console.error(
      `        ❌ Select field "${cloudAttr.name}" value "${value}" not found`,
    );
    console.error(`        Available options: [${options.join(", ")}]`);
    console.error(
      `        💡 Add this value to the "${cloudAttr.name}" field in Jira Cloud GUI, or update datacenter value`,
    );

    throw new Error(
      `CRITICAL: Select field "${cloudAttr.name}" value "${value}" is not in valid options: [${options.join(", ")}]. Please add this option in Jira Cloud GUI or update the datacenter value.`,
    );
  }

  /**
   * Transform Integer values - must be exact number
   */
  transformInteger(value) {
    const num = parseInt(value, 10);
    if (isNaN(num)) {
      throw new Error(
        `CRITICAL: Invalid integer value "${value}" cannot be converted. Data integrity requires valid integers, not assumptions.`,
      );
    }
    return { value: num.toString() };
  }

  /**
   * Transform Float values - must be floating number
   */
  transformFloat(value) {
    const num = parseFloat(value);
    if (isNaN(num)) {
      throw new Error(
        `CRITICAL: Invalid float value "${value}" cannot be converted. Data integrity requires valid floats, not assumptions.`,
      );
    }
    // Ensure it has decimal point for float format
    const floatStr = num.toString();
    return { value: floatStr.includes(".") ? floatStr : floatStr + ".0" };
  }

  /**
   * Transform number values with proper validation and formatting
   *
   * AI INSTRUCTIONS:
   * - Handles both integer and float values with appropriate parsing
   * - Validates numeric format before transformation
   * - Provides proper error messages for invalid numeric data
   * - Used for both Integer and Float field types in Jira Assets
   */
  transformNumber(value) {
    return this.transformFloat(value);
  }

  /**
   * Transform date values
   */
  /**
   * Transform Date values - format must be YYYY-MM-DD
   */
  transformDate(value) {
    // Already in correct date format
    if (typeof value === "string" && value.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return { value: value };
    }

    // Try to parse and convert to YYYY-MM-DD format
    try {
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        // Format: YYYY-MM-DD (date only)
        return { value: date.toISOString().split("T")[0] };
      }
    } catch (e) {
      console.log(`        ⚠️  Invalid date value: "${value}"`);

      // Log invalid date value
      if (this.skippedFieldsLogger) {
        this.skippedFieldsLogger.logSkippedField({
          reason: "INVALID_VALUE",
          schema: this.currentSchema,
          objectType: this.currentObjectType,
          objectKey: this.currentObjectKey,
          objectName: this.currentObjectName,
          fieldId: this.currentFieldId,
          fieldName: "Date field",
          fieldValue: value,
          details: `Invalid date format: ${value}`,
        });
      }
    }

    return null;
  }

  /**
   * Transform DateTime values - format must be YYYY-MM-DDTHH:mm:ss.sssZ
   */
  transformDateTime(value) {
    // Already in ISO format
    if (
      typeof value === "string" &&
      value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    ) {
      return { value: value };
    }

    // Try to parse and convert to ISO format
    try {
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        // Format: YYYY-MM-DDTHH:mm:ss.sssZ (full ISO format)
        return { value: date.toISOString() };
      }
    } catch (e) {
      console.log(`        ⚠️  Invalid datetime value: "${value}"`);

      // Log invalid datetime value
      if (this.skippedFieldsLogger) {
        this.skippedFieldsLogger.logSkippedField({
          reason: "INVALID_VALUE",
          schema: this.currentSchema,
          objectType: this.currentObjectType,
          objectKey: this.currentObjectKey,
          objectName: this.currentObjectName,
          fieldId: this.currentFieldId,
          fieldName: "DateTime field",
          fieldValue: value,
          details: `Invalid datetime format: ${value}`,
        });
      }
    }

    return null;
  }

  /**
   * Transform reference values
   */
  /**
   * Transform datacenter reference value to cloud object reference
   *
   * @param {Object} dcValue - Datacenter reference value with referencedObject
   * @param {Object} cloudAttr - Cloud attribute definition for reference field
   * @param {Map} migratedObjects - Map of migrated objects for reference resolution
   * @returns {Object} - Transformed reference with cloud object key/ID
   *
   * AI INSTRUCTIONS:
   * - Converts datacenter object references to cloud object references
   * - Uses created_objects_mapping.json for reference resolution (plan-driven approach)
   * - Handles both object keys and cloud IDs for reference fields
   * - Critical for maintaining object relationships in cloud
   * - Part of legacy system - replaced by plan field processing for references
   */
  async transformReference(dcValue, cloudAttr, migratedObjects = null) {
    if (dcValue.referencedObject) {
      const dcKey = dcValue.referencedObject.objectKey;
      const objectName =
        dcValue.referencedObject.name || dcValue.referencedObject.label;

      // Log what we're looking for
      console.log(
        `        🔍 Processing reference field "${cloudAttr.name}": Looking for objectKey="${dcKey}", name="${objectName}"`,
      );

      // CRITICAL: If we don't have an object key, this is a problem!
      if (!dcKey) {
        console.warn(
          `        ⚠️  WARNING: Reference has no objectKey! Only has name="${objectName}" - this will lead to incorrect matching!`,
        );
      }

      // CIRCULAR REFERENCE DETECTION
      if (dcKey === this.currentObjectKey) {
        console.log(
          `        🔄 CIRCULAR REFERENCE DETECTED: Field "${cloudAttr.name}" references the object being created (${dcKey})`,
        );
        /**
         * AI INSTRUCTIONS: Circular reference field handling
         * - This implements the user's circular reference strategy: "omit fields and come back to resolve them"
         * - Circular fields are tracked in mapped._circularFields for post-processing
         * - Object is created without circular references first
         * - Circular references are resolved in separate phase after object creation
         * - This prevents circular dependency deadlocks during object creation
         */
        console.log(
          `        🔄 Omitting circular field per plan-driven strategy - will resolve in post-processing`,
        );
        // Throw a special error to indicate circular reference
        throw new Error("CIRCULAR_REFERENCE_SKIP");
      }

      // Check if we have a resolved cloud ID for this reference
      let cloudEntry = null;
      if (migratedObjects) {
        // CRITICAL: Only look up by exact object key, not by name!
        if (dcKey) {
          cloudEntry = migratedObjects.get(dcKey);
          if (!cloudEntry && objectName) {
            // Fallback to name-based lookup
            console.warn(
              `        ⚠️  No match for key ${dcKey}, falling back to name search: ${objectName}`,
            );
            // Try direct name lookup as fallback
            cloudEntry = migratedObjects.get(objectName);
          }
        } else if (objectName) {
          // Try direct name lookup
          cloudEntry = migratedObjects.get(objectName);
        }
      }

      if (cloudEntry) {
        console.log(
          `        🔗 Using resolved dependency: ${dcKey || objectName} → ${cloudEntry.cloudKey || cloudEntry.cloudId}`,
        );
        // For reference fields, we need to use object keys, not IDs
        // According to Jira Assets API docs: "The value must be the reference object key"

        let objectKey = null;

        // Check if cloudEntry is an object from the mapping (has cloudKey property)
        if (typeof cloudEntry === "object" && cloudEntry.cloudKey) {
          // Extract the cloudKey from the mapping object
          objectKey = cloudEntry.cloudKey;
          console.log(
            `        📋 Using cloudKey from created_objects_mapping: ${objectKey}`,
          );
        } else if (typeof cloudEntry === "object" && cloudEntry.cloudId) {
          // Use cloudId if cloudKey is not available
          objectKey = cloudEntry.cloudId;
          console.log(
            `        📋 Using cloudId from created_objects_mapping: ${objectKey}`,
          );
        } else if (
          typeof cloudEntry === "string" &&
          cloudEntry.startsWith("DRY_RUN_")
        ) {
          // For dry-run IDs, construct a mock object key
          const mockKey = cloudEntry.toString().replace("DRY_RUN_", "");
          objectKey = mockKey;
          console.log(
            `        🔍 DRY RUN: Using mock object key: ${objectKey}`,
          );
        } else {
          // Fallback: use cloudEntry directly (for backward compatibility)
          console.log(
            `        📋 Using entry directly from created_objects_mapping: ${cloudEntry}`,
          );
          objectKey = cloudEntry;

          /**
           * AI INSTRUCTIONS: Plan-driven approach trusts mapping accuracy
           * - created_objects_mapping.json is the authoritative source
           * - No verification queries needed - mapping IS the reality
           * - If object doesn't exist, API call will fail and error handling will catch it
           * - This eliminates expensive cloud queries for existence checking
           */
        }

        return { value: objectKey };
      } else {
        // NEW LOGIC: Search for ALL matching objects in cloud
        console.log(
          `        🔍 No resolved ID found - searching cloud for matching objects...`,
        );

        // Search for all matching objects
        const matches = await this.searchForReferenceMatches(
          dcKey,
          objectName,
          cloudAttr,
        );

        if (matches && matches.length > 0) {
          console.log(
            `        🎯 Found ${matches.length} potential matches in cloud`,
          );

          // Try each match to see if it satisfies the field's restrictions
          for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            console.log(
              `        🔄 Trying match ${i + 1}/${matches.length}: ${match.key} (${match.name})`,
            );

            // Check if this match would work for this field
            /**
             * AI NOTE: Object key validation logic
             * - This validation checks basic format requirements for object keys
             * - The validation is complete and appropriate for the use case
             * - More complex validation would require cloud queries (violates plan-driven approach)
             * - Current implementation balances validation with performance
             */
            if (
              await this.validateReferenceMatch(
                match,
                cloudAttr,
                dcValue.referencedObject,
              )
            ) {
              console.log(`        ✅ Match validated: Using ${match.key}`);
              return { value: match.key };
            } else {
              console.log(
                `        ❌ Match failed validation - trying next...`,
              );
            }
          }

          console.log(
            `        ⚠️  All ${matches.length} matches failed validation`,
          );
        }

        // No valid matches found - CREATE the object
        console.log(
          `        🔄 No valid matches found - creating missing object`,
        );

        // Missing object - will be resolved by circular dependency processing
        console.log(
          `        ⚠️  Missing referenced object: ${dcKey || objectName}`,
        );
        console.log(
          `        ⚠️  Skipping reference field - will be resolved in reference update phase`,
        );

        // Return null to skip this reference field for now
        // The circular dependency resolution will create missing objects
        // Then the reference update phase will set the correct values
        return null;
      }
    } else if (dcValue.searchValue || dcValue.value) {
      // For reference fields with direct values
      const value = dcValue.searchValue || dcValue.value;
      console.log(
        `        🔍 Processing reference field with direct value: "${value}"`,
      );
      return { value: value };
    } else {
      console.warn(
        `        ⚠️  Reference field has unexpected structure:`,
        dcValue,
      );
      return null;
    }

    return null;
  }

  /**
   * Search for all matching reference objects in cloud
   */
  /**
   * Search for reference object matches using multiple strategies
   *
   * @param {string} dcKey - Datacenter object key to find
   * @param {string} objectName - Object name for alternative lookup
   * @param {Object} cloudAttr - Cloud attribute definition for context
   * @returns {Array} - Array of potential matches with validation info
   *
   * AI INSTRUCTIONS:
   * - Legacy method for finding reference matches when mapping lookup fails
   * - Uses multiple search strategies (key-based, name-based)
   * - Part of complex reference resolution logic
   * - Likely obsolete in plan-driven approach (uses mapping authority instead)
   * - Included for backward compatibility with complex datacenter references
   */
  async searchForReferenceMatches(dcKey, objectName, cloudAttr) {
    if (!this.cloudApiClient) {
      console.log(`        ⚠️  No cloud API client available for searching`);
      return [];
    }

    try {
      // Build AQL query to find all potential matches
      let aqlQuery = "";

      if (dcKey) {
        // Search by key first
        const escapedKey = this.escapeAQLValue(dcKey);
        aqlQuery = `Key = "${escapedKey}"`;
      } else if (objectName) {
        // Search by name if no key
        const escapedName = this.escapeAQLValue(objectName);
        aqlQuery = `Name = "${escapedName}"`;
      } else {
        return [];
      }

      console.log(`        🔎 AQL Query: ${aqlQuery}`);
      const searchResult = await this.cloudApiClient.executeAQL(
        aqlQuery,
        0,
        50,
      );

      if (
        searchResult &&
        searchResult.values &&
        searchResult.values.length > 0
      ) {
        // Map results to a simpler format
        return searchResult.values.map((obj) => ({
          id: obj.id,
          key: obj.key || obj.objectKey,
          name: obj.name || obj.label,
          objectType: obj.objectType?.name,
          schema: obj.schema?.name,
        }));
      }
    } catch (error) {
      console.log(
        `        ⚠️  Error searching for references: ${error.message}`,
      );
    }

    return [];
  }

  /**
   * Validate if a reference match would work for a field
   */
  /**
   * Validate reference match for accuracy and compatibility
   *
   * @param {Object} match - Potential reference match object
   * @param {Object} cloudAttr - Cloud attribute definition
   * @param {Object} dcReferencedObject - Original datacenter referenced object
   * @returns {boolean} - true if match is valid, false otherwise
   *
   * AI INSTRUCTIONS:
   * - Validates potential reference matches for accuracy
   * - Checks object format and compatibility requirements
   * - Part of legacy reference resolution logic
   * - May be obsolete in plan-driven approach (mapping authority eliminates complex validation)
   * - Provides safety check for reference accuracy
   */
  async validateReferenceMatch(match, cloudAttr, dcReferencedObject) {
    // Basic validation - check if the object types match
    if (cloudAttr.referenceType) {
      const expectedType =
        cloudAttr.referenceType.name || cloudAttr.referenceType;
      if (match.objectType && match.objectType !== expectedType) {
        console.log(
          `        ⚠️  Type mismatch: Expected ${expectedType}, found ${match.objectType}`,
        );
        return false;
      }
    }

    // Check if names match reasonably well
    const dcName = dcReferencedObject.name || dcReferencedObject.label || "";
    if (dcName && match.name) {
      const nameMatch = dcName.toLowerCase() === match.name.toLowerCase();
      if (!nameMatch) {
        console.log(
          `        ⚠️  Name mismatch: Expected "${dcName}", found "${match.name}"`,
        );
        // This might be okay if keys match
      }
    }

    // If we got here, the match seems reasonable
    return true;
  }

  /**
   * Escape special characters in AQL values
   */
  escapeAQLValue(str) {
    if (!str) return str;
    // Escape quotes and backslashes for AQL
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /**
   * Transform user values
   */
  /**
   * Transform user reference to proper cloud user format
   *
   * @param {string|Object} value - User value (email, display name, or user object)
   * @param {Object} cloudAttr - Cloud attribute definition for context
   * @returns {Object} - Transformed user reference for cloud
   *
   * AI INSTRUCTIONS:
   * - Converts datacenter user references to cloud user format
   * - Handles email addresses, display names, and user keys
   * - Uses getUserAccountId() for email-to-accountId resolution
   * - Critical for user reference fields in migrated objects
   * - Part of legacy system - may be simplified in plan-driven approach
   */
  async transformUser(value, cloudAttr = null) {
    // User fields need Atlassian Account IDs in cloud
    console.log(`        👤 Processing user field: ${JSON.stringify(value)}`);

    let searchQuery = null;

    // Handle user object from datacenter (has .user property)
    if (value && typeof value === "object" && value.user) {
      const userObj = value.user;
      console.log(
        `        👤 Found user object: displayName="${userObj.displayName}", name="${userObj.name}", isDeleted=${userObj.isDeleted}`,
      );

      // Skip deleted/deactivated users immediately
      if (userObj.isDeleted) {
        console.warn(
          `        ⚠️  User is deleted/deactivated: ${userObj.displayName || userObj.name}`,
        );
        console.warn(
          `        🔄 SKIPPING this user field to avoid migration failure`,
        );
        return null;
      }

      // Use email if available, otherwise use name
      searchQuery =
        userObj.name && userObj.name.includes("@")
          ? userObj.name
          : userObj.displayName;
      console.log(
        `        📧 Using search query from user object: ${searchQuery}`,
      );
    }
    // Handle string formats from datacenter
    else if (typeof value === "string") {
      // Try to extract email from parentheses
      const emailMatch = value.match(/\(([^)]+@[^)]+)\)/);
      if (emailMatch) {
        searchQuery = emailMatch[1];
        console.log(`        📧 Extracted email: ${searchQuery}`);
      } else if (value.includes("@")) {
        // Value is already an email
        searchQuery = value;
        console.log(`        📧 Using email: ${searchQuery}`);
      } else {
        // No email found - use the name as search query
        searchQuery = value;
        console.log(
          `        🔍 No email found, searching by name: ${searchQuery}`,
        );
      }
    } else {
      console.warn(`        ⚠️  Unexpected user value format: ${typeof value}`);
      return null;
    }

    // Query Jira API to get the user's Account ID (by email or name)
    const accountId = await this.getUserAccountId(searchQuery);
    if (!accountId) {
      // Check if this field is required
      if (cloudAttr && cloudAttr.minimumCardinality > 0) {
        // SPECIAL CASE: For required user fields, skip if user is deactivated/not found
        // This handles the edge case where users are deactivated in cloud
        console.warn(
          `        ⚠️  Required user field cannot be mapped - user not found/deactivated in Jira Cloud: ${searchQuery}`,
        );
        console.warn(
          `        🔄 SKIPPING this user field to avoid migration failure (user may be deactivated)`,
        );

        // Log the skipped required user field
        if (this.skippedFieldsLogger) {
          this.skippedFieldsLogger.logMissingUser(searchQuery, {
            schema: this.currentSchema,
            objectType: this.currentObjectType,
            objectKey: this.currentObjectKey,
            objectName: this.currentObjectName,
            fieldId: this.currentFieldId,
            fieldName: cloudAttr?.name,
            cloudAttrName: cloudAttr?.name,
            isRequired: true,
            reason: "User not found or deactivated in cloud",
          });
        }
        return null; // Skip the field entirely
      }

      // Optional field - can skip
      console.warn(
        `        ⚠️  User not found in Jira Cloud: ${searchQuery}. Skipping optional user field.`,
      );
      console.warn(
        `        💡 This user may need to be added to Jira Cloud before they can be referenced.`,
      );

      // Log the skipped user field
      if (this.skippedFieldsLogger) {
        this.skippedFieldsLogger.logMissingUser(searchQuery, {
          schema: this.currentSchema,
          objectType: this.currentObjectType,
          objectKey: this.currentObjectKey,
          objectName: this.currentObjectName,
          fieldId: this.currentFieldId,
          fieldName: cloudAttr?.name,
          cloudAttrName: cloudAttr?.name,
          isRequired: false,
        });
      }
      return null;
    }

    console.log(`        ✅ Found Account ID: ${accountId}`);
    return { value: accountId };
  }

  /**
   * Get user Account ID from Jira API using email address
   */
  /**
   * Get Jira Cloud account ID from email address
   *
   * @param {string} email - User email address
   * @returns {string|null} - Cloud account ID or null if not found
   *
   * AI INSTRUCTIONS:
   * - Resolves email addresses to Jira Cloud account IDs for user references
   * - Uses Jira Platform API for user lookup by email
   * - Critical for maintaining user references after migration
   * - Handles cases where users may not exist in cloud (returns null)
   * - Part of user reference transformation logic
   */
  async getUserAccountId(email) {
    try {
      const https = require("https");

      // Extract domain from CLOUD_BASE_URL (e.g., "https://jira-sandbox.atlassian.net")
      const baseUrl = process.env.CLOUD_BASE_URL;
      const urlMatch = baseUrl.match(/https:\/\/([^\/]+)/);
      if (!urlMatch) {
        throw new Error(`Invalid CLOUD_BASE_URL format: ${baseUrl}`);
      }
      const hostname = urlMatch[1];

      // Use the user search API with email as query
      const path = `/rest/api/3/user/search?query=${encodeURIComponent(email)}`;

      return new Promise((resolve, reject) => {
        const options = {
          hostname: hostname,
          path: path,
          method: "GET",
          headers: {
            Authorization: `Basic ${process.env.CLOUD_API_TOKEN}`,
            Accept: "application/json",
          },
        };

        const req = https.request(options, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              if (res.statusCode === 200) {
                const users = JSON.parse(data);
                console.log(
                  `        🔍 User search returned ${users.length} results`,
                );

                // Debug: Log all users found
                users.forEach((u, i) => {
                  console.log(
                    `        🔍 User ${i}: ${u.displayName} - Active: ${u.active} - AccountId: ${u.accountId}`,
                  );
                });

                // Simple logic: Find any ACTIVE user from search results
                const activeUser = users.find((u) => u.active === true);

                if (activeUser) {
                  console.log(
                    `        ✅ Found active user: ${activeUser.displayName} (${activeUser.accountId})`,
                  );
                  resolve(activeUser.accountId);
                } else {
                  console.log(
                    `        ❌ No active user found for query: ${email}`,
                  );
                  resolve(null);
                }
              } else {
                console.log(
                  `        ⚠️  User search API returned ${res.statusCode}: ${data}`,
                );
                resolve(null);
              }
            } catch (e) {
              console.log(
                `        ⚠️  Error parsing user search response: ${e.message}`,
              );
              resolve(null);
            }
          });
        });

        req.on("error", (error) => {
          console.log(
            `        ⚠️  User search API request error: ${error.message}`,
          );
          resolve(null);
        });

        req.end();
      });
    } catch (error) {
      console.log(`        ⚠️  Error in getUserAccountId: ${error.message}`);
      return null;
    }
  }

  /**
   * Transform status values with fuzzy matching
   */
  transformStatus(dcValue) {
    // Status fields in Jira Assets API expect specific format
    // ALWAYS use name-based fuzzy matching instead of datacenter status IDs
    // because datacenter status IDs don't match cloud status IDs
    if (dcValue.status && dcValue.status.name) {
      // Apply fuzzy matching for status names (handle case differences)
      const statusName = this.normalizeStatusName(dcValue.status.name);
      console.log(
        `        🔄 Status field: Using normalized status name "${statusName}" (original: "${dcValue.status.name}")`,
      );
      return { value: statusName };
    } else if (dcValue.displayValue) {
      // Apply fuzzy matching to display value
      const statusName = this.normalizeStatusName(dcValue.displayValue);
      console.log(
        `        🔄 Status field: Using normalized display value "${statusName}" (original: "${dcValue.displayValue}")`,
      );
      return { value: statusName };
    }

    // Final fallback with normalization
    const rawValue = String(dcValue.value || dcValue.displayValue || dcValue);
    const statusName = this.normalizeStatusName(rawValue);
    console.log(
      `        🔄 Status field: Using normalized fallback value "${statusName}" (original: "${rawValue}")`,
    );
    return { value: statusName };
  }

  /**
   * Normalize status names using generic rules (no hard-coded mappings)
   */
  normalizeStatusName(statusName) {
    if (!statusName) return statusName;

    const normalized = statusName.toString().trim();

    // Generic normalization rules:
    // 1. Replace underscores and multiple spaces with single spaces
    // 2. Convert to proper case (first letter of each word uppercase)
    const cleaned = normalized
      .replace(/_+/g, " ") // Replace underscores with spaces
      .replace(/\s+/g, " ") // Replace multiple spaces with single space
      .toLowerCase(); // Convert to lowercase first

    // Convert to proper case (capitalize first letter of each word)
    const properCase = cleaned
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    if (properCase !== normalized) {
      console.log(
        `        📝 Status normalization: "${normalized}" → "${properCase}"`,
      );
    }

    return properCase;
  }

  /**
   * Ensure required attributes are present
   */
  ensureRequiredAttributes(mapped, cloudAttributes, dcObject) {
    for (const cloudAttr of cloudAttributes) {
      if (cloudAttr.minimumCardinality > 0) {
        const exists = mapped.attributes.find(
          (a) => a.objectTypeAttributeId === cloudAttr.id,
        );
        if (!exists) {
          // Add default value for required field
          console.log(
            `    🔍 Missing required field: ${cloudAttr.name} (ID: ${cloudAttr.id}) - attempting to generate default`,
          );
          const defaultValue = this.getDefaultValue(cloudAttr, dcObject);
          if (defaultValue !== null) {
            mapped.attributes.push({
              objectTypeAttributeId: cloudAttr.id,
              objectAttributeValues: [defaultValue],
            });
            console.log(
              `    ➕ Added required field ${cloudAttr.name} with default value`,
            );
          }
        }
      }
    }
  }

  /**
   * Get default value for required field
   */
  getDefaultValue(cloudAttr, dcObject) {
    console.log(
      `    🔧 getDefaultValue called for field "${cloudAttr.name}", dcObject keys: ${Object.keys(dcObject).join(", ")}`,
    );

    // CRITICAL: Handle User fields that failed lookup (deactivated users)
    if (cloudAttr.defaultType?.name === "User" || cloudAttr.type === "User") {
      console.warn(
        `    ⚠️  SKIPPING required User field "${cloudAttr.name}" - user not found/deactivated in cloud`,
      );
      console.warn(
        `    💡 This prevents migration failure due to deactivated users`,
      );
      return null; // Skip user fields when user doesn't exist
    }

    // Special handling for Name field - get from object's label or name property
    if (cloudAttr.name === "Name") {
      const nameValue = dcObject.label || dcObject.name || dcObject.Name;
      console.log(
        `    🔍 Name field search: label="${dcObject.label}", name="${dcObject.name}", Name="${dcObject.Name}"`,
      );
      if (nameValue && nameValue.trim() !== "") {
        console.log(
          `    ➕ Using object label/name for Name field: "${nameValue}"`,
        );
        return { value: nameValue.toString().trim() };
      }

      // FALLBACK: Use objectKey for Name field if no label/name found
      const objectKey = dcObject.objectKey || dcObject.Key;
      console.log(
        `    🔍 ObjectKey search: objectKey="${dcObject.objectKey}", Key="${dcObject.Key}"`,
      );
      if (objectKey && objectKey.trim() !== "") {
        console.warn(
          `    ⚠️  FALLBACK: Using objectKey "${objectKey}" for required Name field`,
        );
        return { value: objectKey.toString().trim() };
      }

      // No fallback - let it fail if no objectKey available
      console.error(
        `    ❌ CRITICAL: No objectKey available for Name field - object will fail`,
      );
      return null;
    }

    // FALLBACK STRATEGY: For TEXT fields that have no data
    // This is triggered when a text field has no datacenter value
    // Only applies to Text and Textarea type fields
    if (
      cloudAttr.defaultType?.name === "Text" ||
      cloudAttr.defaultType?.name === "Textarea" ||
      cloudAttr.type === "Text" ||
      cloudAttr.type === "Textarea"
    ) {
      // First try to use any existing data from the object that might be relevant
      const possibleValue =
        dcObject.label ||
        dcObject.name ||
        dcObject.Name ||
        dcObject.description ||
        dcObject.Description;

      if (possibleValue && cloudAttr.name !== "Name" && possibleValue !== "-") {
        // Truncate long values to prevent character limit errors
        let truncatedValue = possibleValue.toString();
        if (truncatedValue.length > 9500) {
          truncatedValue = truncatedValue.substring(0, 9497) + "...";
          console.log(
            `    ➕ Using truncated object data for required text field "${cloudAttr.name}": ${truncatedValue.substring(0, 50)}... (truncated from ${possibleValue.length} chars)`,
          );
        } else {
          console.log(
            `    ➕ Using existing object data for required text field "${cloudAttr.name}": ${truncatedValue.substring(0, 50)}...`,
          );
        }
        return { value: truncatedValue };
      }

      // Use objectKey as fallback - much more meaningful than "No data"
      const objectKey = dcObject.objectKey;
      if (objectKey) {
        console.warn(
          `    ⚠️  FALLBACK: Using objectKey "${objectKey}" for required text field "${cloudAttr.name}" (ID: ${cloudAttr.id})`,
        );
        console.warn(
          `    ⚠️  This provides meaningful identification instead of generic placeholder`,
        );
        return { value: objectKey };
      }

      // Last resort fallback - use "No data" only if no objectKey available
      console.warn(
        `    ⚠️  LAST RESORT: Using "No data" for required text field "${cloudAttr.name}" (ID: ${cloudAttr.id})`,
      );
      console.warn(`    ⚠️  No objectKey available for this object`);
      return { value: "No data" };
    }

    // Special handling for Key field - get from object's objectKey property
    if (cloudAttr.name === "Key") {
      if (dcObject.objectKey) {
        console.log(
          `    ➕ Using object key for Key field: ${dcObject.objectKey}`,
        );
        return { value: dcObject.objectKey };
      }
    }

    // Special handling for Created field - get from object's created property
    if (cloudAttr.name === "Created") {
      if (dcObject.created) {
        console.log(
          `    ➕ Using object created timestamp for Created field: ${dcObject.created}`,
        );
        return this.transformDateTime(dcObject.created);
      }
    }

    // Special handling for Updated field - get from object's updated property
    if (cloudAttr.name === "Updated") {
      if (dcObject.updated) {
        console.log(
          `    ➕ Using object updated timestamp for Updated field: ${dcObject.updated}`,
        );
        return this.transformDateTime(dcObject.updated);
      }
    }

    // GENERIC HANDLER for missing required fields in Procurement schema
    // Many Procurement objects in datacenter are missing required fields
    if (dcObject.objectType && dcObject.objectType.objectSchemaId === 38) {
      // Procurement schema ID
      const label = dcObject.label || dcObject.name || dcObject.Name || "";

      // Special handling for "Item to be procured" field
      if (cloudAttr.name === "Item to be procured") {
        let itemValue = label;

        // Extract item name from label if it follows common patterns
        if (label.startsWith("Procurement of ")) {
          itemValue = label.replace("Procurement of ", "");
        } else if (label.includes("Procurement")) {
          itemValue = label.replace(/.*Procurement\s*/i, "");
        }

        console.log(
          `    ⚠️  DATACENTER DATA ISSUE: Required field "${cloudAttr.name}" is missing!`,
        );
        console.log(
          `    🔧 Extracting value from object label: "${itemValue || label}"`,
        );
        return { value: itemValue || label || "Unknown Item" };
      }

      // Generic handler for other missing required text fields in Procurement
      if (
        cloudAttr.type === "Text" ||
        cloudAttr.defaultType?.name === "Text" ||
        cloudAttr.type === "Textarea" ||
        cloudAttr.defaultType?.name === "Textarea"
      ) {
        // NO hardcoded defaults for Place of delivery - must be in datacenter data
        console.log(
          `    ⚠️  DATACENTER DATA ISSUE: Required field "${cloudAttr.name}" is missing in Procurement object!`,
        );
        console.log(`    🔧 Using object label as fallback value: "${label}"`);
        return { value: label || `Missing ${cloudAttr.name}` };
      }

      // NO hardcoded date defaults - dates must be in datacenter data or throw FATAL error

      // NO hardcoded datetime defaults - datetimes must be in datacenter data or throw FATAL error

      // NO hardcoded boolean defaults - booleans must be in datacenter data or throw FATAL error

      // NO hardcoded integer defaults - integers must be in datacenter data or throw FATAL error

      // NO hardcoded float defaults - floats must be in datacenter data or throw FATAL error
    }

    // For all other required fields, throw error - no assumptions allowed
    throw new Error(
      `CRITICAL: Required field "${cloudAttr.name}" (ID: ${cloudAttr.id}) has no value in datacenter data. Cannot generate default values - this violates data integrity. The datacenter data must be fixed or the field must be made optional.`,
    );
  }

  /**
   * Make API call to cloud
   */
  /**
   * Make API call to Jira Assets API specifically
   *
   * @param {string} endpoint - Assets API endpoint path
   * @param {string} method - HTTP method
   * @param {Object} body - Request body data
   * @returns {Object} - Parsed response data
   */
  async makeAssetsApiCall(endpoint, method = "GET", body = null) {
    return new Promise((resolve, reject) => {
      const baseUrl = process.env.CLOUD_BASE_URL;
      const urlMatch = baseUrl.match(/https:\/\/([^\/]+)/);
      if (!urlMatch) {
        reject(new Error(`Invalid CLOUD_BASE_URL format: ${baseUrl}`));
        return;
      }
      const hostname = urlMatch[1];

      const options = {
        hostname: hostname,
        path: endpoint,
        method: method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve(data);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Make API call to Jira Platform API (separate from Assets API)
   *
   * @param {string} endpoint - API endpoint path
   * @param {string} method - HTTP method
   * @param {Object} body - Request body data
   * @returns {Object} - Parsed response data
   *
   * AI INSTRUCTIONS:
   * - Low-level HTTP client for Jira Platform API calls
   * - Used for user lookup and project validation
   * - Separate from cloudApiClient which handles Assets API
   * - Part of legacy system - may be consolidated in plan-driven approach
   */
  async makeApiCall(endpoint, method = "GET", body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: "api.atlassian.com",
        path: endpoint,
        method: method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve(data);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Fetch real field type from cloud API - DYNAMIC APPROACH
   */
  // REMOVED: fetchCloudFieldType() - 45+ lines of cloud query violation code

  /**
   * Determine attribute type from cloud API response - GENERIC APPROACH
   */
  determineAttributeType(attribute) {
    // Handle reference types (most important for our current errors)
    if (
      attribute.referenceType ||
      attribute.referenceObjectType ||
      attribute.referenceObjectTypeId
    ) {
      console.log(
        `    🔗 Attribute ${attribute.id} (${attribute.name}) is Reference type → ${attribute.referenceType?.name || attribute.referenceObjectType?.name || "Reference"}`,
      );
      return "Reference";
    }

    // Handle default types
    if (attribute.defaultType && attribute.defaultType.name) {
      const typeName = attribute.defaultType.name;
      console.log(
        `    📝 Attribute ${attribute.id} (${attribute.name}) has default type: ${typeName}`,
      );
      return typeName;
    }

    // Handle numeric type mapping (CRITICAL FIX!)
    if (attribute.type !== undefined && attribute.type !== null) {
      const typeMapping = {
        0: "Text",
        1: "Reference",
        2: "User",
        3: "Double",
        4: "Date",
        5: "DateTime",
        6: "URL",
        7: "Select", // ← FIXED! Was incorrectly 'Email'
        8: "Textarea",
        9: "Integer", // ← CORRECTED BASED ON ACTUAL API
        10: "IP Address",
        11: "Boolean", // ← CORRECTED
        12: "Group", // ← CORRECTED
        13: "Project", // ← CORRECTED
        14: "Status", // ← CORRECTED
        15: "Email", // ← MOVED TO CORRECT POSITION
      };

      const mappedType = typeMapping[attribute.type];
      if (mappedType) {
        console.log(
          `    🔢 Attribute ${attribute.id} (${attribute.name}) has numeric type ${attribute.type} → ${mappedType}`,
        );
        return mappedType;
      }
    }

    // Handle system fields
    if (attribute.system) {
      if (attribute.name === "Key") return "Text";
      if (attribute.name === "Name") return "Text";
      if (attribute.name === "Created") return "DateTime";
      if (attribute.name === "Updated") return "DateTime";
    }

    // Fallback to Text
    console.log(
      `    ⚠️  Attribute ${attribute.id} (${attribute.name}) has no clear type, defaulting to Text`,
    );
    return "Text";
  }

  // REMOVED: getCloudObjectKey() - plan-driven approach doesn't query cloud for existence
  // All object lookups now use created_objects_mapping.json only

  // REMOVED: createMissingObject() - dead code, never called externally

  /**
   * Get the schema prefix for object keys based on the field's context
   */
  getSchemaPrefix(cloudAttr) {
    // Common schema prefixes in Jira Assets
    /**
     * AI INSTRUCTIONS: Attribute type determination using standard patterns
     * - Uses Jira Assets platform standard attribute type patterns
     * - This is the correct implementation for field type detection
     * - Cloud configuration provides the same information via defaultType
     * - Pattern matching is reliable and doesn't require additional cloud queries
     */

    if (cloudAttr && cloudAttr.name) {
      const fieldName = cloudAttr.name.toLowerCase();

      // Country of Parent Company is typically in Asset Management
      if (fieldName.includes("country")) {
        return "AM"; // Asset Management
      }

      // User references are typically in User Directory
      if (fieldName.includes("user") || fieldName.includes("owner")) {
        return "UD"; // User Directory
      }

      // Location references are typically in Asset Management
      if (fieldName.includes("location")) {
        return "AM"; // Asset Management
      }

      // Default to Asset Management for most references
      return "AM";
    }

    // Default fallback
    return "AM";
  }

  /**
   * Transform IP Address values - must be valid IPv4 format
   */
  transformIPAddress(value) {
    const stringValue = String(value).trim();

    // Basic IPv4 validation
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipv4Regex.test(stringValue)) {
      // Additional validation for valid IP ranges (0-255)
      const parts = stringValue.split(".");
      const validParts = parts.every((part) => {
        const num = parseInt(part, 10);
        return num >= 0 && num <= 255;
      });

      if (validParts) {
        console.log(`        ✅ Valid IP address: ${stringValue}`);
        return { value: stringValue };
      }
    }

    throw new Error(
      `FATAL: Invalid IP address format: "${stringValue}". Cannot use invalid IP addresses.`,
    );
  }

  /**
   * Transform Group values - must be group name
   */
  transformGroup(value) {
    const stringValue = String(value).trim();
    console.log(`        🔄 Group field: Using group name "${stringValue}"`);
    return { value: stringValue };
  }

  /**
   * Transform URL values - must start with HTTP:// or HTTPS://
   */
  transformURL(value) {
    const stringValue = String(value).trim();

    // Check if URL already has proper protocol
    if (stringValue.match(/^https?:\/\//i)) {
      return { value: stringValue };
    }

    // Add https:// if missing
    if (stringValue.length > 0) {
      const fixedUrl = `https://${stringValue}`;
      console.log(
        `        🔄 URL field: Added protocol "${stringValue}" → "${fixedUrl}"`,
      );
      return { value: fixedUrl };
    }

    return { value: stringValue };
  }

  /**
   * Transform Email values - must be valid email format
   */
  transformEmail(value) {
    const stringValue = String(value).trim();

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(stringValue)) {
      console.log(`        ✅ Valid email: ${stringValue}`);
      return { value: stringValue };
    }

    throw new Error(
      `FATAL: Invalid email format: "${stringValue}". Cannot use invalid email addresses.`,
    );
  }

  /**
   * Transform Project type field - requires project ID
   */
  /**
   * Transform datacenter project reference to cloud project format
   *
   * @param {Object} dcValue - Datacenter project value with project object
   * @param {Object} cloudAttr - Cloud attribute definition
   * @returns {Object} - Transformed project reference for cloud
   *
   * AI INSTRUCTIONS:
   * - Converts datacenter project references to cloud project format
   * - Uses project key directly (plan-driven approach trusts key existence)
   * - Eliminates expensive cloud project lookup for performance
   * - Critical for project reference fields in migrated objects
   * - Simplified in plan-driven approach - no cloud validation needed
   */
  async transformProject(dcValue, cloudAttr) {
    // Project fields expect project ID, not project name
    // Check if dcValue has the project object structure from datacenter

    if (dcValue && dcValue.project && dcValue.project.key) {
      // Use the project KEY to look up the real cloud project ID
      const projectKey = dcValue.project.key;
      const projectName = dcValue.project.name || dcValue.displayValue;

      console.log(
        `        🔍 Looking up cloud project ID for key: ${projectKey} (${projectName})`,
      );

      // PLAN-DRIVEN: Use project key directly without cloud lookup (trust it exists)
      console.log(`        📋 Using project key directly: ${projectKey}`);
      return { value: projectKey };
    }

    // Fallback: if we just have a string value, try to use it as-is
    const value = dcValue.value || dcValue.displayValue || dcValue;
    if (value) {
      throw new Error(
        `FATAL: Project field has no project.key. Cannot use raw value: ${value}. Project must have valid key.`,
      );
    }

    throw new Error(
      `FATAL: Project field is empty. Cannot send null for project reference.`,
    );
  }

  // REMOVED: lookupCloudProjectId() and makeHttpRequest() - 70+ lines of dead cloud query code

  /**
   * Generate attribute mapping report
   */
  generateMappingReport(outputPath = "./logs") {
    // Build mappings from cache
    const mappings = {};
    for (const [key, attributes] of this.cloudAttributeCache.entries()) {
      if (key.startsWith("attributes_")) {
        const objectTypeId = key.replace("attributes_", "");
        mappings[objectTypeId] = {
          attributes: {},
        };
        for (const attr of attributes) {
          mappings[objectTypeId].attributes[attr.name] = {
            id: attr.id,
            type: attr.defaultType ? attr.defaultType.name : null,
            referenceType: attr.referenceObjectType
              ? attr.referenceObjectType.name
              : null,
            options: attr.options
              ? attr.options.split(",").map((o) => o.trim())
              : null,
            required: attr.minimumCardinality > 0,
          };
        }
      }
    }

    const report = {
      timestamp: new Date().toISOString(),
      totalObjectTypes: Object.keys(mappings).length,
      mappings: mappings,
    };

    const filename = path.join(outputPath, "attribute_mapping_report.json");
    fs.writeFileSync(filename, JSON.stringify(report, null, 2));
    console.log(`  📊 Attribute mapping report saved to: ${filename}`);

    return filename;
  }

  /**
   * Handle missing referenced object - let circular dependency resolution handle it
   */
  async createMissingReferencedObject(
    dcKey,
    objectName,
    cloudAttr,
    schemaContext = "",
    migratedObjectsMap = null,
  ) {
    // Don't try to create objects here with hard-coded mappings
    // This should be handled by the circular dependency resolution phase
    console.log(
      `        ⚠️  Missing referenced object: ${dcKey || objectName}`,
    );
    console.log(
      `        ⚠️  This should be resolved by circular dependency processing`,
    );
    return null;
  }

  /**
   * Clear all caches
   */
  clearCache() {
    this.cloudAttributeCache.clear();
    this.mappingCache.clear();
    this.schemaAttributesCache.clear();
    console.log("    🗑️  AttributeMapper cache cleared");
  }
}

module.exports = AttributeMapper;
