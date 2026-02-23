const fs = require('fs');
const path = require('path');

/**
 * Dependency Resolver for Asset Migration
 * Handles smart dependency resolution by finding and migrating referenced objects first
 */

class DependencyResolver {
    constructor(datacenterPath = '../../datacenter_assets') {
        this.datacenterPath = datacenterPath;
        this.objectIndex = new Map(); // Cache of all objects by key
        this.dependencyGraph = new Map(); // Track dependencies
        this.migrationStack = []; // Track current migration chain
        this.resolvedObjects = new Set(); // Track migrated objects
        this.circularDependencies = new Set(); // Track circular references
    }

    /**
     * Initialize dependency resolver by indexing all datacenter objects
     * 
     * @returns {Promise} - Completes when indexing is finished
     * 
     * AI INSTRUCTIONS:
     * - Indexes all datacenter objects for fast dependency lookup during plan creation
     * - Creates comprehensive object registry by multiple keys (objectKey, name, label)
     * - Used during plan building phase to resolve dependencies across schemas
     * - Performance optimization - builds searchable index for 23,875+ objects
     * - Only used during plan creation, not during plan execution
     */
    async initialize() {
        console.log('🔍 Indexing datacenter objects for dependency resolution...');
        const startTime = Date.now();
        
        try {
            await this.indexDatacenterObjects();
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`✅ Indexed ${this.objectIndex.size} objects in ${duration}s`);
        } catch (error) {
            console.error('❌ Failed to index datacenter objects:', error.message);
            throw error;
        }
    }

    /**
     * Index all objects from datacenter_assets directory structure
     * 
     * @returns {Promise} - Completes when all schemas are indexed
     * 
     * AI INSTRUCTIONS:
     * - Recursively scans all datacenter_assets subdirectories
     * - Indexes objects from all schemas for comprehensive dependency analysis
     * - Handles hierarchical structure (3 levels deep: Schema/Parent/Child)
     * - Creates searchable registry for plan dependency graph building
     * - Critical for cross-schema dependency resolution during plan creation
     */
    async indexDatacenterObjects() {
        const schemasPath = path.resolve(__dirname, this.datacenterPath);
        
        if (!fs.existsSync(schemasPath)) {
            throw new Error(`Datacenter assets path not found: ${schemasPath}`);
        }

        const schemas = fs.readdirSync(schemasPath).filter(f => 
            fs.statSync(path.join(schemasPath, f)).isDirectory()
        );

        for (const schema of schemas) {
            await this.indexSchema(schema, path.join(schemasPath, schema));
        }
    }

    /**
     * Index all objects within a specific schema
     * 
     * @param {string} schemaName - Name of the schema being indexed
     * @param {string} schemaPath - File system path to schema directory
     * @returns {Promise} - Completes when schema indexing is finished
     * 
     * AI INSTRUCTIONS:
     * - Processes all objects.json files within a schema directory
     * - Handles hierarchical object type structure within schema
     * - Creates multiple index keys per object (objectKey, name, label) for flexible lookup
     * - Used by dependency graph building to resolve cross-schema references
     * - Populates objectIndex map for fast dependency resolution
     */
    async indexSchema(schemaName, schemaPath) {
        const objectFiles = this.findObjectFiles(schemaPath);
        
        for (const file of objectFiles) {
            const relativePath = path.relative(schemaPath, file);
            const objectType = path.dirname(relativePath).split(path.sep).join('/');
            
            try {
                const objects = JSON.parse(fs.readFileSync(file, 'utf8'));
                
                if (Array.isArray(objects)) {
                    for (const obj of objects) {
                        const indexKeys = this.createIndexKey(obj);
                        if (indexKeys && indexKeys.length > 0) {
                            const objectData = {
                                schema: schemaName,
                                objectType: objectType === '.' ? path.basename(path.dirname(file)) : objectType,
                                object: obj,
                                filePath: file
                            };
                            // Set the object data for each index key
                            for (const key of indexKeys) {
                                this.objectIndex.set(key, objectData);
                            }
                        }
                    }
                }
            } catch (error) {
                console.warn(`  Warning: Could not parse ${file}: ${error.message}`);
            }
        }
    }

    /**
     * Find all objects.json files recursively
     */
    findObjectFiles(dir, files = []) {
        const items = fs.readdirSync(dir);
        
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                this.findObjectFiles(fullPath, files);
            } else if (item === 'objects.json') {
                files.push(fullPath);
            }
        }
        
        return files;
    }

    /**
     * Create index key for an object
     */
    createIndexKey(obj) {
        const keys = [];
        
        // Index by multiple possible keys
        if (obj.objectKey) keys.push(obj.objectKey);
        if (obj.key) keys.push(obj.key);
        if (obj.name) keys.push(`name:${obj.name}`);
        if (obj.label) keys.push(`label:${obj.label}`);
        if (obj.id) keys.push(`id:${obj.id}`);
        
        return keys;
    }

    /**
     * Find an object by reference with optional schema/type constraints
     * @param {string} reference - The reference to search for (key, name, or label)
     * @param {object} constraints - Optional constraints for the search
     * @param {string} constraints.expectedSchema - Expected schema name
     * @param {string} constraints.expectedObjectType - Expected object type name
     * @param {number} constraints.expectedObjectTypeId - Expected object type ID
     * @returns {object|null} The found object data or null
     */
    findObjectByReference(reference, constraints = {}) {
        const { expectedSchema, expectedObjectType, expectedObjectTypeId } = constraints;
        
        // Helper function to check if an object matches constraints
        const matchesConstraints = (value) => {
            if (!constraints || Object.keys(constraints).length === 0) {
                return true; // No constraints, accept any match
            }
            
            // Check schema constraint
            if (expectedSchema) {
                // Handle schema name variations (e.g., "Software_Asset_Management" vs "Software Asset Management")
                // CRITICAL: Preserve schema distinctiveness - don't make different schemas identical!
                const normalizeSchema = (name) => name.trim().replace(/\s+/g, '_').toLowerCase();
                if (normalizeSchema(value.schema) !== normalizeSchema(expectedSchema)) {
                    return false;
                }
            }
            
            // Check object type constraint
            if (expectedObjectType) {
                // For object types, we can be more flexible with normalization since they don't cause cross-schema issues
                const normalizeType = (name) => name.trim().replace(/[_\s-]+/g, ' ').toLowerCase();
                if (normalizeType(value.objectType) !== normalizeType(expectedObjectType)) {
                    return false;
                }
            }
            
            // Check object type ID constraint
            if (expectedObjectTypeId && value.object.objectType) {
                if (value.object.objectType.id !== expectedObjectTypeId) {
                    return false;
                }
            }
            
            return true;
        };
        
        // First, try exact key lookups WITH constraints
        const directMatch = this.objectIndex.get(reference);
        if (directMatch && matchesConstraints(directMatch)) {
            console.log(`        ✅ Found exact match: ${reference} in ${directMatch.schema}/${directMatch.objectType}`);
            return directMatch;
        }
        
        // Try name lookup with constraints
        const nameKey = `name:${reference}`;
        const nameMatch = this.objectIndex.get(nameKey);
        if (nameMatch && matchesConstraints(nameMatch)) {
            console.log(`        ✅ Found by name: ${reference} in ${nameMatch.schema}/${nameMatch.objectType}`);
            return nameMatch;
        }
        
        // Try label lookup with constraints
        const labelKey = `label:${reference}`;
        const labelMatch = this.objectIndex.get(labelKey);
        if (labelMatch && matchesConstraints(labelMatch)) {
            console.log(`        ✅ Found by label: ${reference} in ${labelMatch.schema}/${labelMatch.objectType}`);
            return labelMatch;
        }
        
        // If we have constraints and no constrained match found, search more broadly
        // but still prefer matches that meet constraints
        const allMatches = [];
        
        for (const [key, value] of this.objectIndex.entries()) {
            if (key.includes(reference) || 
                value.object.name === reference || 
                value.object.label === reference ||
                value.object.objectKey === reference) {
                
                if (matchesConstraints(value)) {
                    // Perfect match with constraints
                    console.log(`        ✅ Found with constraints: ${reference} in ${value.schema}/${value.objectType}`);
                    return value;
                }
                allMatches.push(value);
            }
        }
        
        // If no constrained match but we have other matches, warn and return first
        if (allMatches.length > 0) {
            const firstMatch = allMatches[0];
            if (expectedSchema || expectedObjectType) {
                console.warn(`        ⚠️  Found ${reference} but in wrong location: ${firstMatch.schema}/${firstMatch.objectType}`);
                console.warn(`        ⚠️  Expected: ${expectedSchema || 'any schema'}/${expectedObjectType || 'any type'}`);
                console.warn(`        ⚠️  Found ${allMatches.length} matches, using first one`);
            }
            return firstMatch;
        }
        
        return null;
    }

    /**
     * Extract references from an object
     */
    extractReferences(obj) {
        const references = [];
        
        if (obj.attributes && Array.isArray(obj.attributes)) {
            for (const attr of obj.attributes) {
                if (attr.objectAttributeValues) {
                    for (const val of attr.objectAttributeValues) {
                        // Check for referenced objects
                        if (val.referencedObject) {
                            references.push({
                                type: 'object',
                                key: val.referencedObject.objectKey || val.referencedObject.key,
                                name: val.referencedObject.name || val.referencedObject.label,
                                objectType: val.referencedObject.objectType?.name,
                                attributeId: attr.objectTypeAttributeId
                            });
                        }
                        // Check for reference-like values
                        else if (val.referencedType === true && val.searchValue) {
                            references.push({
                                type: 'reference',
                                value: val.searchValue,
                                displayValue: val.displayValue,
                                attributeId: attr.objectTypeAttributeId
                            });
                        }
                    }
                }
            }
        }
        
        return references;
    }

    /**
     * Build dependency graph for an object
     */
    buildDependencyGraph(objectKey, visited = new Set()) {
        if (visited.has(objectKey)) {
            return { circular: true, dependencies: [] };
        }
        
        visited.add(objectKey);
        const objectData = this.findObjectByReference(objectKey);
        
        if (!objectData) {
            return { circular: false, dependencies: [] };
        }
        
        const references = this.extractReferences(objectData.object);
        const dependencies = [];
        
        for (const ref of references) {
            const refKey = ref.key || ref.name || ref.value;
            if (refKey && refKey !== objectKey) {
                const subDeps = this.buildDependencyGraph(refKey, new Set(visited));
                dependencies.push({
                    key: refKey,
                    type: ref.type,
                    attributeId: ref.attributeId,
                    circular: subDeps.circular,
                    dependencies: subDeps.dependencies
                });
            }
        }
        
        this.dependencyGraph.set(objectKey, dependencies);
        return { circular: false, dependencies };
    }

    /**
     * Get migration order based on dependencies
     */
    getMigrationOrder(objectKey) {
        const order = [];
        const visited = new Set();
        
        this.addToMigrationOrder(objectKey, order, visited);
        
        return order;
    }

    /**
     * Recursively add objects to migration order (depth-first)
     */
    addToMigrationOrder(objectKey, order, visited) {
        if (visited.has(objectKey)) return;
        visited.add(objectKey);
        
        const deps = this.dependencyGraph.get(objectKey) || [];
        
        // Add dependencies first
        for (const dep of deps) {
            if (!dep.circular) {
                this.addToMigrationOrder(dep.key, order, visited);
            }
        }
        
        // Then add the object itself
        const objectData = this.findObjectByReference(objectKey);
        if (objectData && !this.resolvedObjects.has(objectKey)) {
            order.push({
                key: objectKey,
                schema: objectData.schema,
                objectType: objectData.objectType,
                object: objectData.object
            });
        }
    }

    /**
     * Mark an object as resolved/migrated
     */
    markAsResolved(objectKey) {
        this.resolvedObjects.add(objectKey);
        
        // Also mark by name and label
        const objectData = this.findObjectByReference(objectKey);
        if (objectData) {
            if (objectData.object.name) {
                this.resolvedObjects.add(`name:${objectData.object.name}`);
            }
            if (objectData.object.label) {
                this.resolvedObjects.add(`label:${objectData.object.label}`);
            }
        }
    }

    /**
     * Check if an object is already resolved
     */
    isResolved(reference) {
        return this.resolvedObjects.has(reference) ||
               this.resolvedObjects.has(`name:${reference}`) ||
               this.resolvedObjects.has(`label:${reference}`);
    }

    /**
     * Get detailed dependency report
     */
    getDependencyReport(objectKey) {
        const objectData = this.findObjectByReference(objectKey);
        if (!objectData) {
            return null;
        }
        
        const graph = this.buildDependencyGraph(objectKey);
        const order = this.getMigrationOrder(objectKey);
        
        return {
            object: {
                key: objectKey,
                schema: objectData.schema,
                objectType: objectData.objectType,
                name: objectData.object.name || objectData.object.label
            },
            dependencies: graph.dependencies,
            migrationOrder: order,
            totalDependencies: order.length - 1,
            hasCircularDependencies: graph.dependencies.some(d => d.circular)
        };
    }

    /**
     * Clear the resolver state
     */
    clear() {
        this.objectIndex.clear();
        this.dependencyGraph.clear();
        this.migrationStack = [];
        this.resolvedObjects.clear();
        this.circularDependencies.clear();
    }
    
    /**
     * Clear resolver state
     */
    clearCache() {
        this.clear();
        console.log('    🗑️  DependencyResolver state cleared');
    }

    /**
     * Pure mapping lookup for dependency resolution (NO creation, NO cloud queries)
     * 
     * @param {string} objectKey - Datacenter key/name of object to find
     * @param {Object} modules - Module container with createdObjectsTracker
     * @param {Object} config - Configuration object (unused in plan-driven approach)
     * @param {Set} resolutionStack - Resolution stack (unused in plan-driven approach)
     * @param {Object} constraints - Search constraints (unused in plan-driven approach)
     * @returns {string|null} - Cloud ID if exists in mapping, null otherwise
     * 
     * AI INSTRUCTIONS:
     * - This is the ONLY function of DependencyResolver in plan-driven approach
     * - NEVER creates objects - only checks created_objects_mapping.json
     * - Returns cloud ID if object exists in mapping, null if not created yet
     * - Plan execution handles missing dependencies via plan ordering
     * - Eliminates expensive cloud queries and recursive object creation
     * - Critical performance improvement - pure O(1) mapping lookup
     */
    async resolveMissingDependency(objectKey, modules, config, resolutionStack = new Set(), constraints = {}) {
        console.log(`        🔍 Looking up: ${objectKey} (MAPPING ONLY - NO CREATION)`);
        
        // PRIMARY: Check created_objects_mapping.json
        if (modules.createdObjectsTracker) {
            const cloudId = modules.createdObjectsTracker.getCloudId(objectKey);
            if (cloudId) {
                console.log(`        ✅ Found in mapping: ${objectKey} → ${cloudId}`);
                return cloudId;
            }
        }
        
        /**
         * AI NOTE: Plan-driven simplification
         * - Legacy in-memory maps eliminated in favor of JSON mapping authority
         * - created_objects_mapping.json is the single source of truth
         * - Eliminates memory management complexity and synchronization issues
         * - Provides persistent mapping across migration runs
         */
        
        // ALTERNATIVE KEYS: Try name-based lookup if we have one
        if (objectKey.includes(':')) {
            // Try the object key part without the name prefix
            const keyPart = objectKey.split(':')[0];
            if (modules.createdObjectsTracker) {
                const cloudId = modules.createdObjectsTracker.getCloudId(keyPart);
                if (cloudId) {
                    console.log(`        ✅ Found by key part: ${keyPart} → ${cloudId}`);
                    return cloudId;
                }
            }
        }
        
        // NOT FOUND - Return null
        console.log(`        ❌ Not found in mappings: ${objectKey}`);
        /**
         * AI INSTRUCTIONS: Plan-driven dependency philosophy
         * - DependencyResolver no longer creates objects - it only checks mappings
         * - Missing objects are handled by plan execution in proper dependency order
         * - This message indicates object will be created when plan processes it
         * - Plan ordering ensures dependencies are created before dependents
         */
        console.log(`        📋 Object not in mapping - plan execution will create it in proper dependency order`);
        return null;
    }
    
    /**
     * SIMPLIFIED: Check if object exists in mappings
     * @param {string} objectKey - The key to check
     * @param {object} modules - Available modules
     * @returns {boolean} True if exists, false otherwise
     */
    hasObjectInMappings(objectKey, modules) {
        // Check created_objects_mapping.json (authoritative source)
        if (modules.createdObjectsTracker && modules.createdObjectsTracker.hasCreated(objectKey)) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Get cloud ID from mappings without logging
     * @param {string} objectKey - The key to look up
     * @param {object} modules - Available modules
     * @returns {string|null} Cloud ID if found, null otherwise
     */
    getCloudId(objectKey, modules) {
        // Check created_objects_mapping.json (authoritative source)
        if (modules.createdObjectsTracker) {
            return modules.createdObjectsTracker.getCloudId(objectKey);
        }
        
        return null;
    }
}

module.exports = DependencyResolver;
