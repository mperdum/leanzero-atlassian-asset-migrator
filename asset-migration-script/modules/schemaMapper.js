/**
 * Schema Mapper Module
 * 
 * Handles mapping between datacenter and cloud schemas/object types.
 * Provides fuzzy matching and normalization for schema and type names.
 */

class SchemaMapper {
    constructor() {
        // REMOVED: progressManager - not used in plan-driven approach
        /**
         * AI INSTRUCTIONS: Schema mapping initialization
         * - cloudSchemas and cloudObjectTypes are populated by MigrationOrchestrator during loadCloudConfiguration()
         * - This lazy initialization pattern allows orchestrator to load cloud config and pass it to mapper
         * - setCloudSchemas() and setCloudObjectTypes() methods populate these during migration startup
         * - This is the correct initialization pattern for this architecture
         */
        this.cloudSchemas = null;  // Populated during loadCloudConfiguration()
        this.cloudObjectTypes = null;  // Populated during loadCloudConfiguration()
    }

    /**
     * Set cloud schemas for datacenter→cloud mapping
     * 
     * @param {Map} cloudSchemas - Map of schema name → schema object
     * 
     * AI INSTRUCTIONS:
     * - Called by MigrationOrchestrator during loadCloudConfiguration()
     * - Populates cloud schemas for subsequent findCloudSchema() lookups
     * - Essential initialization step before plan execution
     * - Enables fuzzy matching between datacenter and cloud schema names
     */
    setCloudSchemas(cloudSchemas) {
        this.cloudSchemas = cloudSchemas;
    }

    /**
     * Set cloud object types for datacenter→cloud mapping
     * 
     * @param {Map} cloudObjectTypes - Map of schema ID → Map of type name → type object
     * 
     * AI INSTRUCTIONS:
     * - Called by MigrationOrchestrator during loadCloudConfiguration()
     * - Populates cloud object types for subsequent findCloudObjectType() lookups
     * - Essential initialization step before plan execution
     * - Enables fuzzy matching between datacenter and cloud object type names
     * - Supports hierarchical type name resolution
     */
    setCloudObjectTypes(cloudObjectTypes) {
        this.cloudObjectTypes = cloudObjectTypes;
    }

    /**
     * Find cloud schema by datacenter schema name with fuzzy matching
     * 
     * @param {string} schemaName - Datacenter schema name
     * @returns {Object|null} - Cloud schema object or null if not found
     * 
     * AI INSTRUCTIONS:
     * - Maps datacenter schema names to cloud schema objects
     * - Handles naming variations (underscores vs spaces)
     * - Performs fuzzy matching for slight name differences
     * - Critical for proper schema mapping during plan execution
     * - Used by objectMigrator.getCloudConfig() for schema resolution
     */
    findCloudSchema(schemaName) {
        if (!this.cloudSchemas) {
            console.error('  ❌ Cloud schemas not loaded in SchemaMapper');
            return null;
        }
        
        // Normalize schema names for comparison
        const normalizedName = schemaName.replace(/_/g, ' ').toLowerCase();
        
        // Search through the cloudSchemas Map
        for (const [name, schema] of this.cloudSchemas) {
            const cloudName = name.toLowerCase();
            
            // First try exact match
            if (cloudName === normalizedName) {
                return schema;
            }
        }
        
        // If no exact match, try partial matching but prefer longer matches
        let bestMatch = null;
        let bestScore = 0;
        
        for (const [name, schema] of this.cloudSchemas) {
            const cloudName = name.toLowerCase();

            // Calculate match score (prefer longer common substrings)
            if (cloudName.includes(normalizedName)) {
                const score = normalizedName.length / cloudName.length;
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = schema;
                }
            } else if (normalizedName.includes(cloudName)) {
                const score = cloudName.length / normalizedName.length;
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = schema;
                }
            }
        }
        
        if (bestMatch) {
            console.log(`    🔧 Schema matched "${schemaName}" → "${bestMatch.name}" (score: ${bestScore.toFixed(2)})`);
        }
        
        return bestMatch;
    }

    /**
     * Find cloud object type by name with fuzzy matching
     */
    findCloudObjectType(typeName, cloudSchema, allowCrossSchema = false) {
        if (!cloudSchema) return null;
        
        if (!this.cloudObjectTypes) {
            console.error('  ❌ Cloud object types not loaded in SchemaMapper');
            return null;
        }
        
        // Extract the actual type name from hierarchical paths
        const actualTypeName = this.extractActualTypeName(typeName);
        
        // Get object types for this schema
        const objectTypesMap = this.cloudObjectTypes.get(cloudSchema.id);
        if (objectTypesMap) {
            const match = this.findObjectTypeInSchema(actualTypeName, Array.from(objectTypesMap.values()));
            if (match) return match;
        }
        
        // If not found in current schema and cross-schema search is allowed, search all schemas
        // But be VERY careful and log warnings
        if (allowCrossSchema) {
            console.warn(`    ⚠️  WARNING: Cross-schema search for object type: ${actualTypeName}`);
            console.warn(`    ⚠️  This may lead to incorrect schema associations!`);
            
            for (const [schemaId, objectTypesMap] of this.cloudObjectTypes) {
                if (schemaId === cloudSchema.id) continue; // Skip current schema (already searched)
                
                const match = this.findObjectTypeInSchema(actualTypeName, Array.from(objectTypesMap.values()));
                if (match) {
                    // Get schema name for warning
                    let crossSchemaName = 'Unknown';
                    for (const [name, schema] of this.cloudSchemas) {
                        if (schema.id === schemaId) {
                            crossSchemaName = name;
                            break;
                        }
                    }
                    
                    console.warn(`    🚨 CROSS-SCHEMA MATCH: "${actualTypeName}" found in different schema "${crossSchemaName}"`);
                    console.warn(`    🚨 Original schema: "${cloudSchema.name}" → Found in: "${crossSchemaName}"`);
                    console.warn(`    🚨 This may cause cross-reference issues! Consider creating the object type in the correct schema.`);
                    
                    // Don't actually use cross-schema matches for safety
                    return null;
                }
            }
        }
        
        /**
         * AI INSTRUCTIONS: Missing object type handling
         * - This is the correct behavior - object types must exist in cloud before migration
         * - The warning alerts user to create missing object types in Jira Cloud GUI
         * - Auto-creation would be dangerous without user approval of schema changes
         * - This error prevents data corruption from wrong object type mapping
         */
        console.log(`    ⚠️  Object type "${typeName}" not found in cloud schema "${cloudSchema.name}"`);
        console.log(`    💡 ACTION REQUIRED: Create this object type in Jira Cloud Assets GUI before migration`);
        
        return null;
    }

    /**
     * Extract actual type name from hierarchical paths
     */
    extractActualTypeName(typeName) {
        // Handle hierarchical paths like "Software_Asset_Details/Storage_of_Data" → "Storage of Data"
        if (typeName.includes('/')) {
            const parts = typeName.split('/');
            const lastPart = parts[parts.length - 1];
            
            // PRESERVE triple underscores for pipe pattern matching, convert single underscores to spaces
            if (lastPart.includes('___')) {
                return lastPart; // Keep triple underscores intact for pipe matching
            }
            return lastPart.replace(/_/g, ' ').trim();
        }
        
        // PRESERVE triple underscores for pipe pattern matching, convert single underscores to spaces
        if (typeName.includes('___')) {
            return typeName; // Keep triple underscores intact for pipe matching
        }
        return typeName.replace(/_/g, ' ').trim();
    }

    /**
     * Find object type within a specific schema's object types
     */
    findObjectTypeInSchema(typeName, objectTypes) {
        // First try exact match
        let match = objectTypes.find(type => type.name === typeName);
        if (match) return match;
        
        // Try fuzzy matching - normalize spaces, underscores, and case
        const normalizedTypeName = typeName.trim().toLowerCase().replace(/[_\s]+/g, ' ');
        match = objectTypes.find(type => 
            type.name.trim().toLowerCase().replace(/[_\s]+/g, ' ') === normalizedTypeName
        );
        if (match) {
            console.log(`    🔧 Fuzzy matched "${typeName}" → "${match.name}"`);
            return match;
        }
        
        // Special handling for patterns like "DAP___Assets" → "DAP | Assets"
        if (typeName.includes('___')) {
            const pipePattern = typeName.replace(/___/g, ' | ');
            match = objectTypes.find(type => type.name === pipePattern);
            if (match) {
                console.log(`    🔧 Pipe pattern matched "${typeName}" → "${match.name}"`);
                return match;
            }
        }
        
        // Try partial matching for common variations
        match = objectTypes.find(type => {
            const cloudName = type.name.trim().toLowerCase();
            const searchName = typeName.trim().toLowerCase();
            return cloudName.includes(searchName) || searchName.includes(cloudName);
        });
        
        if (match) {
            console.log(`    🔧 Partial matched "${typeName}" → "${match.name}"`);
            return match;
        }
        
        return null;
    }

    /**
     * Validate cross-schema references before migration
     */
    validateCrossSchemaReferences(dcObject, cloudSchema, cloudObjectType) {
        const issues = [];
        
        // Check for references that might point to other schemas
        if (dcObject.attributes) {
            dcObject.attributes.forEach(attr => {
                if (attr.objectAttributeValues) {
                    attr.objectAttributeValues.forEach(value => {
                        if (value.referencedObject) {
                            const refObjectType = value.referencedObject.objectType;
                            const refSchemaId = refObjectType?.objectSchemaId;
                            
                            // Check if referenced object is from a different schema
                            if (refSchemaId && refSchemaId !== cloudSchema.id) {
                                issues.push({
                                    type: 'CROSS_SCHEMA_REFERENCE',
                                    fieldId: attr.objectTypeAttributeId,
                                    referencedObject: value.referencedObject.label,
                                    referencedObjectKey: value.referencedObject.objectKey,
                                    referencedSchema: refSchemaId,
                                    currentSchema: cloudSchema.id,
                                    message: `Object references "${value.referencedObject.label}" from different schema`
                                });
                            }
                            
                            // Check for specific problematic references like "Single/Named" to Testing schema
                            if (value.referencedObject.label === 'Single/Named' && 
                                value.searchValue && value.searchValue.includes('AMT')) {
                                issues.push({
                                    type: 'TESTING_SCHEMA_REFERENCE',
                                    fieldId: attr.objectTypeAttributeId,
                                    referencedObject: value.referencedObject.label,
                                    referencedObjectKey: value.referencedObject.objectKey,
                                    message: `"Single/Named" references Testing schema (AMT) - cross-schema relations may be disabled`
                                });
                            }
                        }
                    });
                }
            });
        }
        
        return issues;
    }

    /**
     * Report cross-schema reference issues
     */
    reportCrossSchemaIssues(issues, objectName, schemaName, objectTypeName) {
        if (issues.length === 0) return;
        
        console.warn(`    ⚠️  Cross-schema reference issues found for ${objectName}:`);
        issues.forEach(issue => {
            console.warn(`      🔗 ${issue.type}: ${issue.message}`);
            if (issue.type === 'TESTING_SCHEMA_REFERENCE') {
                console.warn(`      💡 Solution: Update "${issue.referencedObject}" to reference production schema instead of Testing schema`);
            } else if (issue.type === 'CROSS_SCHEMA_REFERENCE') {
                console.warn(`      💡 Solution: Enable cross-schema relations or move referenced object to ${schemaName} schema`);
            }
        });
    }
}

module.exports = SchemaMapper;
