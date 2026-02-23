/**
 * Attribute Mapper Module
 *
 * Maps CSV column headers to Jira Cloud Assets object type attributes.
 * Supports fuzzy matching and manual mapping overrides.
 */

class AttributeMapper {
  constructor(cloudApiClient) {
    this.cloudApiClient = cloudApiClient;
    this.schemaCache = new Map();
    this.objectTypeCache = new Map();
    this.attributeCache = new Map();
  }

  /**
   * Load all schemas from cloud
   */
  async loadSchemas() {
    if (this.schemaCache.size > 0) {
      return Array.from(this.schemaCache.values());
    }

    const schemas = await this.cloudApiClient.getSchemas();
    for (const schema of schemas) {
      this.schemaCache.set(schema.id, schema);
      this.schemaCache.set(schema.name.toLowerCase(), schema);
    }
    return schemas;
  }

  /**
   * Load object types for a schema
   */
  async loadObjectTypes(schemaId) {
    const cacheKey = `schema_${schemaId}`;
    if (this.objectTypeCache.has(cacheKey)) {
      return this.objectTypeCache.get(cacheKey);
    }

    const objectTypes = await this.cloudApiClient.getObjectTypes(schemaId);
    this.objectTypeCache.set(cacheKey, objectTypes);

    for (const ot of objectTypes) {
      this.objectTypeCache.set(ot.id, ot);
      this.objectTypeCache.set(`${schemaId}_${ot.name.toLowerCase()}`, ot);
    }

    return objectTypes;
  }

  /**
   * Load attributes for an object type
   */
  async loadAttributes(objectTypeId) {
    if (this.attributeCache.has(objectTypeId)) {
      return this.attributeCache.get(objectTypeId);
    }

    const attributes =
      await this.cloudApiClient.getObjectTypeAttributes(objectTypeId);
    this.attributeCache.set(objectTypeId, attributes);
    return attributes;
  }

  /**
   * Find schema by name (fuzzy match)
   */
  async findSchema(schemaName) {
    await this.loadSchemas();

    // Exact match first
    if (this.schemaCache.has(schemaName.toLowerCase())) {
      return this.schemaCache.get(schemaName.toLowerCase());
    }

    // Fuzzy match
    const schemas = Array.from(this.schemaCache.values()).filter(
      (s) => typeof s === "object",
    );
    const normalizedName = this.normalizeString(schemaName);

    for (const schema of schemas) {
      if (this.normalizeString(schema.name) === normalizedName) {
        return schema;
      }
    }

    // Partial match
    for (const schema of schemas) {
      if (
        this.normalizeString(schema.name).includes(normalizedName) ||
        normalizedName.includes(this.normalizeString(schema.name))
      ) {
        return schema;
      }
    }

    return null;
  }

  /**
   * Find object type by name within a schema
   */
  async findObjectType(schemaId, objectTypeName) {
    const objectTypes = await this.loadObjectTypes(schemaId);

    // Exact match first
    const cacheKey = `${schemaId}_${objectTypeName.toLowerCase()}`;
    if (this.objectTypeCache.has(cacheKey)) {
      return this.objectTypeCache.get(cacheKey);
    }

    // Fuzzy match
    const normalizedName = this.normalizeString(objectTypeName);

    for (const ot of objectTypes) {
      if (this.normalizeString(ot.name) === normalizedName) {
        return ot;
      }
    }

    // Partial match
    for (const ot of objectTypes) {
      if (
        this.normalizeString(ot.name).includes(normalizedName) ||
        normalizedName.includes(this.normalizeString(ot.name))
      ) {
        return ot;
      }
    }

    return null;
  }

  /**
   * Map CSV headers to object type attributes
   */
  async mapHeaders(objectTypeId, csvHeaders, manualMapping = {}) {
    const attributes = await this.loadAttributes(objectTypeId);
    const mapping = {};
    const unmapped = [];

    for (const header of csvHeaders) {
      // Check manual mapping first
      if (manualMapping[header]) {
        const attr = attributes.find(
          (a) =>
            a.name === manualMapping[header] || a.id === manualMapping[header],
        );
        if (attr) {
          mapping[header] = {
            attributeId: attr.id,
            attributeName: attr.name,
            attributeType: attr.type,
            source: "manual",
          };
          continue;
        }
      }

      // Try exact match
      let attr = attributes.find((a) => a.name === header);
      if (attr) {
        mapping[header] = {
          attributeId: attr.id,
          attributeName: attr.name,
          attributeType: attr.type,
          source: "exact",
        };
        continue;
      }

      // Try case-insensitive match
      attr = attributes.find(
        (a) => a.name.toLowerCase() === header.toLowerCase(),
      );
      if (attr) {
        mapping[header] = {
          attributeId: attr.id,
          attributeName: attr.name,
          attributeType: attr.type,
          source: "case-insensitive",
        };
        continue;
      }

      // Try normalized match
      const normalizedHeader = this.normalizeString(header);
      attr = attributes.find(
        (a) => this.normalizeString(a.name) === normalizedHeader,
      );
      if (attr) {
        mapping[header] = {
          attributeId: attr.id,
          attributeName: attr.name,
          attributeType: attr.type,
          source: "normalized",
        };
        continue;
      }

      // Unmapped
      unmapped.push(header);
    }

    return { mapping, unmapped, attributes };
  }

  /**
   * Normalize a string for comparison
   */
  normalizeString(str) {
    return str
      .toLowerCase()
      .replace(/[_\-\s]+/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  /**
   * Get attribute type name
   */
  getAttributeTypeName(typeId) {
    const types = {
      0: "Default (Text)",
      1: "Object Reference",
      2: "User",
      3: "Confluence",
      4: "Group",
      5: "Version",
      6: "Project",
      7: "Status",
      8: "Email",
      9: "TextArea",
      10: "DateTime",
      11: "URL",
      12: "Checkbox",
      13: "Select",
      14: "Integer",
      15: "Float",
      16: "Date",
    };
    return types[typeId] || `Unknown (${typeId})`;
  }

  /**
   * List all schemas
   */
  async listSchemas() {
    const schemas = await this.loadSchemas();
    // Use a Map to deduplicate by ID since cache stores both by id and name
    const uniqueSchemas = new Map();
    for (const schema of this.schemaCache.values()) {
      if (typeof schema === "object" && schema.id) {
        uniqueSchemas.set(schema.id, schema);
      }
    }
    return Array.from(uniqueSchemas.values())
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * List all object types for a schema
   */
  async listObjectTypes(schemaId) {
    const objectTypes = await this.loadObjectTypes(schemaId);
    return objectTypes.map((ot) => ({ id: ot.id, name: ot.name }));
  }
}

module.exports = AttributeMapper;
