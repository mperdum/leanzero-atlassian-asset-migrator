#!/usr/bin/env node

/**
 * Datacenter vs Cloud Attribute Analysis
 * 
 * This script compares datacenter_assets attributes with cloud attributes to identify:
 * 1. Missing object types in cloud
 * 2. Missing attributes in cloud object types  
 * 3. Missing attribute options/values
 * 
 * Provides GUI-focused actions like:
 * "Go to Asset_Management schema → License object type → Find attribute ID 1704 → Add 'Yes' and 'No' as valid options"
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const dotenv = require('dotenv');

// Load environment variables
const envPaths = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '.env')
];

for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
        break;
    }
}

const WORKSPACE_ID = process.env.WORKSPACE_ID;
const AUTH_TOKEN = process.env.CLOUD_API_TOKEN;
const DATACENTER_ASSETS_PATH = process.env.DATACENTER_PATH || path.join(__dirname, '..', '..', 'datacenter_assets');

class DatacenterVsCloudAnalyzer {
    constructor() {
        this.cloudSchemas = new Map();
        this.cloudObjectTypes = new Map();
        this.cloudAttributes = new Map();
        this.datacenterSchemas = new Map();
        this.missingItems = [];
        
        console.log('🔍 Datacenter vs Cloud Attribute Analysis');
        console.log('==========================================\n');
    }

    /**
     * Main analysis entry point - compares datacenter vs cloud configuration
     * 
     * @returns {Promise} - Completes when analysis is finished
     * 
     * AI INSTRUCTIONS:
     * - Comprehensive analysis comparing datacenter schemas/types/attributes with cloud
     * - Identifies missing elements that need creation in cloud before migration
     * - Generates actionable GUI instructions for cloud configuration setup
     * - Critical utility for preparing cloud environment for successful migration
     * - Prevents migration failures by ensuring configuration compatibility
     */
    async run() {
        try {
            console.log('📂 Step 1: Loading datacenter assets...');
            await this.loadDatacenterAssets();
            
            console.log('\n☁️  Step 2: Loading cloud configuration...');
            await this.loadCloudConfiguration();
            
            console.log('\n🔍 Step 3: Comparing and finding missing items...');
            await this.compareAndFindMissing();
            
            console.log('\n📋 Step 4: Generating GUI action tasks...');
            this.generateGUITasks();
            
        } catch (error) {
            console.error('❌ Analysis failed:', error.message);
            process.exit(1);
        }
    }

    /**
     * Load and analyze all datacenter asset schemas and objects
     * 
     * @returns {Promise} - Completes when datacenter analysis is finished
     * 
     * AI INSTRUCTIONS:
     * - Scans entire datacenter_assets directory structure for comprehensive analysis
     * - Extracts schemas, object types, attributes, and attribute values from datacenter
     * - Builds complete inventory of datacenter configuration for comparison
     * - Handles hierarchical structure (3 levels deep) and complex object relationships
     * - Foundation for identifying configuration gaps between datacenter and cloud
     */
    async loadDatacenterAssets() {
        const schemaFolders = fs.readdirSync(DATACENTER_ASSETS_PATH)
            .filter(item => fs.statSync(path.join(DATACENTER_ASSETS_PATH, item)).isDirectory());
        
        for (const schemaName of schemaFolders) {
            console.log(`  📋 Loading schema: ${schemaName}`);
            const schemaPath = path.join(DATACENTER_ASSETS_PATH, schemaName);
            
            // Load schema attributes
            const schemaAttributesFile = path.join(schemaPath, 'schema_attributes.json');
            let schemaAttributes = [];
            if (fs.existsSync(schemaAttributesFile)) {
                try {
                    schemaAttributes = JSON.parse(fs.readFileSync(schemaAttributesFile, 'utf8'));
                } catch (error) {
                    console.log(`    ⚠️  Failed to load schema attributes: ${error.message}`);
                }
            }
            
            // Scan for object types and their attributes
            const objectTypes = await this.scanDatacenterObjectTypes(schemaPath, '', schemaAttributes);
            
            this.datacenterSchemas.set(schemaName, {
                name: schemaName,
                attributes: schemaAttributes,
                objectTypes: objectTypes
            });
            
            console.log(`    📊 Found ${objectTypes.length} object types`);
        }
    }

    /**
     * Recursively scan datacenter object types within schema
     * 
     * @param {string} currentPath - Current file system path being scanned
     * @param {string} relativePath - Relative path from schema root
     * @param {Array} schemaAttributes - Schema attribute definitions for reference
     * @returns {Promise} - Completes when object type scanning is finished
     * 
     * AI INSTRUCTIONS:
     * - Recursively processes hierarchical object type structure
     * - Extracts object type information and attribute usage patterns
     * - Handles nested object types (Asset/Mobile_Phone, etc.)
     * - Analyzes attribute values and options used in datacenter
     * - Critical for understanding datacenter configuration structure
     */
    async scanDatacenterObjectTypes(currentPath, relativePath, schemaAttributes) {
        const objectTypes = [];
        const items = fs.readdirSync(currentPath);
        
        for (const item of items) {
            if (item === 'schema_attributes.json') continue;
            
            const itemPath = path.join(currentPath, item);
            const fullRelativePath = relativePath ? `${relativePath}/${item}` : item;
            
            if (fs.statSync(itemPath).isDirectory()) {
                const objectsFile = path.join(itemPath, 'objects.json');
                
                if (fs.existsSync(objectsFile)) {
                    // This is an object type directory
                    const attributes = await this.extractAttributesFromObjects(objectsFile, schemaAttributes);
                    
                    objectTypes.push({
                        name: item,
                        path: fullRelativePath,
                        attributes: attributes,
                        objectCount: this.countObjects(objectsFile)
                    });
                } else {
                    // Recursively scan subdirectories
                    const subObjectTypes = await this.scanDatacenterObjectTypes(itemPath, fullRelativePath, schemaAttributes);
                    objectTypes.push(...subObjectTypes);
                }
            }
        }
        
        return objectTypes;
    }

    /**
     * Extract attribute information from datacenter objects file
     * 
     * @param {string} objectsFile - Path to objects.json file
     * @param {Array} schemaAttributes - Schema attribute definitions
     * @returns {Object} - Extracted attribute information and usage patterns
     * 
     * AI INSTRUCTIONS:
     * - Analyzes objects.json files to understand attribute usage in datacenter
     * - Extracts attribute values, options, and patterns used in real data
     * - Identifies required vs optional attributes based on usage
     * - Maps attribute IDs to actual values for validation
     * - Critical for understanding data patterns and validation requirements
     */
    async extractAttributesFromObjects(objectsFile, schemaAttributes) {
        const attributes = new Map();
        
        try {
            const objects = JSON.parse(fs.readFileSync(objectsFile, 'utf8'));
            
            // Create a map of attribute ID to attribute info from schema
            const attrIdToInfo = new Map();
            for (const schemaAttr of schemaAttributes) {
                attrIdToInfo.set(schemaAttr.id, schemaAttr);
            }
            
            // Sample first few objects to get attribute patterns
            const sampleSize = Math.min(5, objects.length);
            for (let i = 0; i < sampleSize; i++) {
                const obj = objects[i];
                if (obj.attributes) {
                    for (const attr of obj.attributes) {
                        const attrId = attr.objectTypeAttributeId;
                        const schemaAttr = attrIdToInfo.get(attrId);
                        const attrName = schemaAttr?.name || `Unknown_${attrId}`;
                        
                        if (!attributes.has(attrName)) {
                            attributes.set(attrName, {
                                name: attrName,
                                id: attrId,
                                type: schemaAttr?.type,
                                values: new Set()
                            });
                        }
                        
                        // Collect possible values
                        if (attr.objectAttributeValues) {
                            for (const value of attr.objectAttributeValues) {
                                if (value.value && typeof value.value === 'string') {
                                    attributes.get(attrName).values.add(value.value);
                                }
                                if (value.displayValue && typeof value.displayValue === 'string') {
                                    attributes.get(attrName).values.add(value.displayValue);
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.log(`    ⚠️  Failed to extract attributes from ${objectsFile}: ${error.message}`);
        }
        
        // Convert Sets to Arrays for easier handling
        for (const [name, attr] of attributes) {
            attr.values = Array.from(attr.values).slice(0, 10); // Limit to first 10 values
        }
        
        return attributes;
    }

    countObjects(objectsFile) {
        try {
            const objects = JSON.parse(fs.readFileSync(objectsFile, 'utf8'));
            return objects.length;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Load cloud schemas, object types, and attributes for comparison
     * 
     * @returns {Promise} - Completes when cloud configuration is loaded
     * 
     * AI INSTRUCTIONS:
     * - Fetches complete cloud configuration via Assets API
     * - Loads schemas, object types, and attributes for comprehensive comparison
     * - Builds cloud configuration inventory for gap analysis
     * - Used to identify missing elements that need creation before migration
     * - Provides cloud baseline for datacenter comparison
     */
    async loadCloudConfiguration() {
        // Get cloud schemas
        const schemas = await this.makeCloudRequest('/objectschema/list');
        
        for (const schema of schemas.values || []) {
            console.log(`  📋 Loading cloud schema: ${schema.name} (ID: ${schema.id})`);
            this.cloudSchemas.set(schema.name, schema);
            
            try {
                // Get object types for this schema
                const objectTypes = await this.makeCloudRequest(`/objectschema/${schema.id}/objecttypes`);
                
                for (const objectType of objectTypes || []) {
                    const key = `${schema.name}/${objectType.name}`;
                    this.cloudObjectTypes.set(key, {
                        ...objectType,
                        schemaName: schema.name,
                        schemaId: schema.id
                    });
                    
                    try {
                        // Get attributes for this object type
                        const attributes = await this.makeCloudRequest(`/objecttype/${objectType.id}/attributes`);
                        
                        for (const attr of attributes || []) {
                            const attrKey = `${key}/${attr.name}`;
                            this.cloudAttributes.set(attrKey, {
                                ...attr,
                                schemaName: schema.name,
                                objectTypeName: objectType.name,
                                objectTypeId: objectType.id
                            });
                        }
                        
                        console.log(`    🏷️  ${objectType.name}: ${(attributes || []).length} attributes`);
                        
                    } catch (attrError) {
                        console.log(`    ⚠️  Failed to get attributes for ${objectType.name}: ${attrError.message}`);
                    }
                }
                
                console.log(`    📊 ${(objectTypes || []).length} object types`);
                
            } catch (typeError) {
                console.log(`    ⚠️  Failed to get object types: ${typeError.message}`);
            }
        }
    }

    /**
     * Compare datacenter and cloud configurations to identify missing elements
     * 
     * @returns {Promise} - Completes when comparison analysis is finished
     * 
     * AI INSTRUCTIONS:
     * - Performs comprehensive comparison between datacenter and cloud configurations
     * - Identifies missing schemas, object types, attributes, and attribute values
     * - Generates actionable recommendations for cloud configuration setup
     * - Provides specific GUI instructions for creating missing elements
     * - Critical for ensuring migration compatibility and preventing failures
     */
    async compareAndFindMissing() {
        for (const [schemaName, datacenterSchema] of this.datacenterSchemas) {
            console.log(`\n🔍 Analyzing schema: ${schemaName}`);
            console.log(`    📊 ${datacenterSchema.objectTypes.length} datacenter object types to check`);
            
            // Normalize schema name for comparison (replace underscores with spaces)
            const normalizedSchemaName = schemaName.replace(/_/g, ' ');
            
            // Check if schema exists in cloud (try both original and normalized names)
            const cloudSchema = this.cloudSchemas.get(schemaName) || this.cloudSchemas.get(normalizedSchemaName);
            
            if (!cloudSchema) {
                this.missingItems.push({
                    type: 'MISSING_SCHEMA',
                    priority: 'HIGH',
                    schema: schemaName,
                    action: `Create schema "${schemaName}" in Jira Cloud Assets`,
                    affectedObjects: datacenterSchema.objectTypes.reduce((sum, ot) => sum + ot.objectCount, 0)
                });
                continue;
            }
            
            // Check object types
            let checkedObjectTypes = 0;
            let foundObjectTypes = 0;
            let missingObjectTypes = 0;
            let checkedAttributes = 0;
            let missingAttributes = 0;
            
            for (const datacenterObjectType of datacenterSchema.objectTypes) {
                checkedObjectTypes++;
                
                // Normalize object type name (replace underscores with spaces)
                const normalizedObjectTypeName = datacenterObjectType.name.replace(/_/g, ' ');
                
                // Find cloud object type using sophisticated matching (like main.js)
                const cloudObjectType = this.findCloudObjectType(datacenterObjectType.name, schemaName, normalizedSchemaName);
                
                if (!cloudObjectType) {
                    missingObjectTypes++;
                    this.missingItems.push({
                        type: 'MISSING_OBJECT_TYPE',
                        priority: 'HIGH',
                        schema: schemaName,
                        objectType: datacenterObjectType.name,
                        action: `Go to ${normalizedSchemaName} schema → Create object type "${datacenterObjectType.name}"`,
                        affectedObjects: datacenterObjectType.objectCount
                    });
                    continue;
                } else {
                    foundObjectTypes++;
                }
                
                // Check attributes
                for (const [attrName, datacenterAttr] of datacenterObjectType.attributes) {
                    checkedAttributes++;
                    
                    // Find cloud attribute using the matched object type
                    const cloudAttr = this.findCloudAttribute(attrName, cloudObjectType, schemaName, normalizedSchemaName);
                    
                    if (!cloudAttr) {
                        missingAttributes++;
                        this.missingItems.push({
                            type: 'MISSING_ATTRIBUTE',
                            priority: 'MEDIUM',
                            schema: schemaName,
                            objectType: datacenterObjectType.name,
                            attribute: attrName,
                            action: `Go to ${normalizedSchemaName} schema → ${datacenterObjectType.name} object type → Create attribute "${attrName}"`,
                            affectedObjects: datacenterObjectType.objectCount,
                            sampleValues: datacenterAttr.values.slice(0, 5)
                        });
                    } else {
                        // Check if attribute values/options are missing
                        
                        if (cloudAttr.typeValue?.options && datacenterAttr.values.length > 0) {
                            const cloudOptions = cloudAttr.typeValue.options.map(opt => opt.name);
                            const missingValues = datacenterAttr.values.filter(val => 
                                !cloudOptions.some(opt => opt.toLowerCase() === val.toLowerCase())
                            );
                            
                            if (missingValues.length > 0) {
                                this.missingItems.push({
                                    type: 'MISSING_ATTRIBUTE_VALUES',
                                    priority: 'MEDIUM',
                                    schema: schemaName,
                                    objectType: datacenterObjectType.name,
                                    attribute: attrName,
                                    attributeId: cloudAttr.id,
                                    action: `Go to ${normalizedSchemaName} schema → ${datacenterObjectType.name} object type → Find attribute ID ${cloudAttr.id} → Add missing options: ${missingValues.join(', ')}`,
                                    affectedObjects: datacenterObjectType.objectCount,
                                    missingValues: missingValues
                                });
                            }
                        }
                    }
                }
            }
            
            console.log(`    📊 Checked ${checkedObjectTypes} object types: ${foundObjectTypes} found, ${missingObjectTypes} missing`);
            console.log(`    📊 Checked ${checkedAttributes} attributes: ${missingAttributes} missing`);
        }
    }

    /**
     * Find cloud object type using sophisticated matching (copied from main.js)
     */
    findCloudObjectType(dcTypeName, schemaName, normalizedSchemaName) {
        // Try all schema combinations
        const schemaVariations = [schemaName, normalizedSchemaName];
        
        for (const schemaVariation of schemaVariations) {
            // Get all object types for this schema
            const schemaObjectTypes = [];
            for (const [key, objectType] of this.cloudObjectTypes) {
                if (key.startsWith(`${schemaVariation}/`)) {
                    schemaObjectTypes.push(objectType);
                }
            }
            
            if (schemaObjectTypes.length > 0) {
                const match = this.findObjectTypeInSchema(dcTypeName, schemaObjectTypes);
                if (match) {
                    return match;
                }
            }
        }
        
        return null;
    }

    /**
     * Find object type within a specific schema's object types (copied from main.js)
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
     * Find cloud attribute for a given object type
     */
    findCloudAttribute(attrName, cloudObjectType, schemaName, normalizedSchemaName) {
        if (!cloudObjectType) return null;
        
        // Try different combinations of schema and object type names
        const schemaVariations = [schemaName, normalizedSchemaName];
        const objectTypeVariations = [cloudObjectType.name];
        
        for (const schemaVariation of schemaVariations) {
            for (const objectTypeVariation of objectTypeVariations) {
                const cloudAttrKey = `${schemaVariation}/${objectTypeVariation}/${attrName}`;
                const cloudAttr = this.cloudAttributes.get(cloudAttrKey);
                if (cloudAttr) {
                    return cloudAttr;
                }
            }
        }
        
        return null;
    }

    generateGUITasks() {
        // Sort by priority and affected objects
        this.missingItems.sort((a, b) => {
            const priorityOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
            if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
                return priorityOrder[b.priority] - priorityOrder[a.priority];
            }
            return b.affectedObjects - a.affectedObjects;
        });
        
        console.log('\n🎯 GUI ACTION TASKS (Priority Order)');
        console.log('====================================');
        
        let taskNumber = 1;
        for (const item of this.missingItems) { // Show all items
            const priority = item.priority === 'HIGH' ? '🚨 HIGHEST PRIORITY' : 
                           item.priority === 'MEDIUM' ? '⚠️  MEDIUM PRIORITY' : '💡 LOW PRIORITY';
            
            console.log(`\n${taskNumber}. ${item.objectType || item.schema} (${item.affectedObjects} objects) ${priority}`);
            
            if (item.type === 'MISSING_ATTRIBUTE_VALUES' && item.attributeId) {
                console.log(`   Field: rlabs-insight-attribute-${item.attributeId}`);
                console.log(`   Issue: Missing values (${item.missingValues.join(', ')})`);
            } else if (item.attribute) {
                console.log(`   Field: ${item.attribute}`);
                console.log(`   Issue: ${item.type.replace('_', ' ').toLowerCase()}`);
            }
            
            console.log(`   Action: ${item.action}`);
            
            if (item.sampleValues && item.sampleValues.length > 0) {
                console.log(`   Sample values: ${item.sampleValues.join(', ')}`);
            }
            
            taskNumber++;
        }
        
        console.log(`\n📊 SUMMARY`);
        console.log(`=========`);
        console.log(`Total issues found: ${this.missingItems.length}`);
        console.log(`Missing schemas: ${this.missingItems.filter(i => i.type === 'MISSING_SCHEMA').length}`);
        console.log(`Missing object types: ${this.missingItems.filter(i => i.type === 'MISSING_OBJECT_TYPE').length}`);
        console.log(`Missing attributes: ${this.missingItems.filter(i => i.type === 'MISSING_ATTRIBUTE').length}`);
        console.log(`Missing attribute values: ${this.missingItems.filter(i => i.type === 'MISSING_ATTRIBUTE_VALUES').length}`);
        
        const totalAffectedObjects = this.missingItems.reduce((sum, item) => sum + item.affectedObjects, 0);
        console.log(`Total affected objects: ${totalAffectedObjects.toLocaleString()}`);
    }

    /**
     * Make authenticated request to Jira Cloud Assets API
     * 
     * @param {string} endpoint - API endpoint path
     * @returns {Object} - Parsed response data
     * 
     * AI INSTRUCTIONS:
     * - Low-level HTTP client for Assets API within analysis utility
     * - Handles authentication and response parsing for cloud API calls
     * - Used by cloud configuration loading methods
     * - Separate from main cloudApiClient for utility isolation
     * - Provides foundation for cloud configuration discovery
     */
    async makeCloudRequest(endpoint) {
        return new Promise((resolve, reject) => {
            const fullUrl = `https://api.atlassian.com/jsm/assets/workspace/${WORKSPACE_ID}/v1${endpoint}`;
            const url = new URL(fullUrl);
            
            const options = {
                method: 'GET',
                headers: {
                    'Authorization': `Basic ${AUTH_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 30000
            };

            const req = https.request(url, options, (res) => {
                let responseData = '';
                res.on('data', chunk => { responseData += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(responseData));
                        } catch (e) {
                            resolve(responseData);
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
                    }
                });
            });
            
            req.on('error', reject);
            req.setTimeout(30000, () => { 
                req.destroy(); 
                reject(new Error('Request timeout')); 
            });
            
            req.end();
        });
    }
}

// Run the analysis
if (require.main === module) {
    const analyzer = new DatacenterVsCloudAnalyzer();
    analyzer.run().catch(error => {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    });
}

module.exports = DatacenterVsCloudAnalyzer;
