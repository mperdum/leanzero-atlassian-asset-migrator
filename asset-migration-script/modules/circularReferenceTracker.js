/**
 * CircularReferenceTracker - Tracks and manages circular references in a JSON file
 * Stores pending circular references and their resolution status
 */

const fs = require('fs');
const path = require('path');

class CircularReferenceTracker {
    constructor() {
        this.filePath = path.join(__dirname, '..', 'logs', 'circular_references.json');
        this.references = [];
        this.loadFromFile();
    }

    /**
     * Load existing circular references from file
     */
    loadFromFile() {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf8');
                this.references = JSON.parse(data);
                console.log(`    📂 Loaded ${this.references.length} circular references from file`);
                
                // Log statistics
                const pending = this.references.filter(r => r.status === 'pending').length;
                const resolved = this.references.filter(r => r.status === 'resolved').length;
                const failed = this.references.filter(r => r.status === 'failed').length;
                
                if (pending > 0) {
                    console.log(`      ⏳ Pending: ${pending}`);
                }
                if (resolved > 0) {
                    console.log(`      ✅ Resolved: ${resolved}`);
                }
                if (failed > 0) {
                    console.log(`      ❌ Failed: ${failed}`);
                }
            }
        } catch (error) {
            console.warn(`    ⚠️  Could not load circular references: ${error.message}`);
            this.references = [];
        }
    }

    /**
     * Save circular references to file
     */
    saveToFile() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(this.filePath, JSON.stringify(this.references, null, 2));
        } catch (error) {
            console.error(`    ❌ Could not save circular references: ${error.message}`);
        }
    }

    /**
     * Add a new circular reference with plan integration
     */
    addCircularReference(objectInfo) {
        const reference = {
            id: `${objectInfo.objectKey}_${objectInfo.fieldName}_${Date.now()}`,
            timestamp: new Date().toISOString(),
            status: 'pending', // pending, resolved, failed
            
            // Object that has the circular reference
            sourceObject: {
                cloudId: objectInfo.cloudId,
                objectKey: objectInfo.objectKey,
                objectName: objectInfo.objectName,
                schemaName: objectInfo.schemaName,
                typePath: objectInfo.typePath,
                cloudObjectTypeId: objectInfo.cloudObjectTypeId,
                datacenterKey: objectInfo.datacenterKey || objectInfo.objectKey // For plan integration
            },
            
            // Field that contains the circular reference
            field: {
                name: objectInfo.fieldName,
                cloudAttributeId: objectInfo.cloudAttributeId,
                dcAttributeId: objectInfo.dcAttributeId,
                fieldId: objectInfo.fieldId || `attr_${objectInfo.dcAttributeId}` // For plan integration
            },
            
            // Object being referenced (the circular dependency)
            targetObject: {
                objectKey: objectInfo.targetObjectKey,
                objectName: objectInfo.targetObjectName,
                /**
                 * AI INSTRUCTIONS: Circular reference target tracking
                 * - expectedCloudId starts as null and is populated when target object is created
                 * - This lazy population pattern allows circular references to be resolved after both objects exist
                 * - The tracker waits for target creation, then updates the source object
                 * - This is the correct pattern for deferred circular reference resolution
                 */
                expectedCloudId: null // Populated when target object is created and tracked in mapping
            },
            
            // Original value from datacenter
            originalValue: objectInfo.originalValue,
            
            // Resolution attempts
            attempts: 0,
            lastAttemptTime: null,
            errorMessage: null,
            
            // PLAN INTEGRATION: Track which plan object and field this affects
            planIntegration: {
                objectKey: objectInfo.datacenterKey || objectInfo.objectKey,
                fieldId: objectInfo.fieldId || `attr_${objectInfo.dcAttributeId}`,
                lastPlanUpdate: null
            }
        };
        
        // Check if this circular reference already exists
        const existing = this.references.find(r => 
            r.sourceObject.cloudId === reference.sourceObject.cloudId &&
            r.field.cloudAttributeId === reference.field.cloudAttributeId &&
            r.targetObject.objectKey === reference.targetObject.objectKey
        );
        
        if (existing) {
            console.log(`      📝 Circular reference already tracked: ${existing.id}`);
            return existing.id;
        }
        
        this.references.push(reference);
        this.saveToFile();
        
        console.log(`      📝 Added circular reference: ${reference.id}`);
        console.log(`         Source: ${reference.sourceObject.objectName} (${reference.sourceObject.cloudId})`);
        console.log(`         Field: ${reference.field.name}`);
        console.log(`         Target: ${reference.targetObject.objectName || reference.targetObject.objectKey}`);
        
        return reference.id;
    }

    /**
     * Get all pending circular references
     */
    getPendingReferences() {
        return this.references.filter(r => r.status === 'pending');
    }

    /**
     * Get pending references for a specific object
     */
    getPendingReferencesForObject(cloudId) {
        return this.references.filter(r => 
            r.sourceObject.cloudId === cloudId && 
            r.status === 'pending'
        );
    }

    /**
     * Get failed references that should be retried
     * Only retry references with "invalid due to restrictions" errors
     * which usually mean the target object wasn't created yet
     */
    getFailedReferencesToRetry() {
        return this.references.filter(r => {
            if (r.status !== 'failed') return false;
            
            // Retry if error contains "invalid due to restrictions"
            if (r.errorMessage && r.errorMessage.includes('invalid due to restrictions')) {
                // Limit retries to avoid infinite loops
                const maxRetries = 3;
                if ((r.attempts || 0) < maxRetries) {
                    return true;
                }
            }
            
            return false;
        });
    }

    /**
     * Update the status of a circular reference
     */
    updateStatus(referenceId, status, errorMessage = null) {
        const reference = this.references.find(r => r.id === referenceId);
        if (reference) {
            reference.status = status;
            reference.lastAttemptTime = new Date().toISOString();
            reference.attempts++;
            
            if (errorMessage) {
                reference.errorMessage = errorMessage;
            }
            
            this.saveToFile();
            
            console.log(`      📝 Updated circular reference ${referenceId}: ${status}`);
            return true;
        }
        return false;
    }

    /**
     * Set the target cloud ID once the target object is created
     */
    setTargetCloudId(targetObjectKey, cloudId) {
        let updated = 0;
        
        this.references.forEach(reference => {
            if (reference.targetObject.objectKey === targetObjectKey && 
                !reference.targetObject.expectedCloudId) {
                reference.targetObject.expectedCloudId = cloudId;
                updated++;
            }
        });
        
        if (updated > 0) {
            this.saveToFile();
            console.log(`      📝 Updated ${updated} circular references with target cloud ID: ${cloudId}`);
        }
        
        return updated;
    }

    /**
     * Check prerequisites for circular reference resolution using plan integration
     * 
     * @param {Object} reference - Circular reference object with source/target info
     * @param {Object} apiClient - Cloud API client for AQL queries (if needed)
     * @param {Object} createdObjectsTracker - For mapping lookups (plan-driven approach)
     * @param {Object} migrationPlan - For field status updates and plan integration
     * @returns {boolean} - true if prerequisites met, false if target not ready
     * 
     * AI INSTRUCTIONS:
     * - Verifies target object exists in created_objects_mapping.json (no cloud queries)
     * - Updates plan field status when target object becomes available
     * - Plan integration ensures circular field status tracked in migration plan
     * - Used by processPendingReferences() to determine resolution readiness
     * - Eliminates expensive cloud AQL queries in favor of mapping lookup
     */
    async checkPrerequisites(reference, apiClient, createdObjectsTracker = null, migrationPlan = null) {
        // PLAN-DRIVEN: Check created_objects_mapping instead of cloud queries
        if (!reference.targetObject.expectedCloudId) {
            
            if (createdObjectsTracker) {
                // Check if target object exists in our mappings
                const cloudId = createdObjectsTracker.getCloudId(reference.targetObject.objectKey);
                if (cloudId) {
                    reference.targetObject.expectedCloudId = cloudId;
                    console.log(`        ✅ Found target in mapping: ${reference.targetObject.objectKey} → ${cloudId}`);
                    
                    // Update plan field status if we have access to the plan
                    if (migrationPlan && migrationPlan.updateFieldStatus) {
                        // Mark the circular reference field as ready to resolve
                        migrationPlan.updateFieldStatus(
                            reference.sourceObject.datacenterKey,
                            reference.field.fieldId,
                            'ready_for_circular_resolution',
                            cloudId
                        );
                    }
                    
                    this.saveToFile();
                    return true;
                }
            }
            
            // If not in mapping, check plan status
            if (migrationPlan && migrationPlan.findObjectForReference) {
                const targetObj = migrationPlan.findObjectForReference(reference.targetObject.objectKey);
                if (targetObj && targetObj.status === 'created') {
                    console.log(`        📋 Target object created according to plan: ${reference.targetObject.objectKey}`);
                    
                    // Try to get cloud ID from tracker again (might have been updated)
                    if (createdObjectsTracker) {
                        const cloudId = createdObjectsTracker.getCloudId(reference.targetObject.objectKey);
                        if (cloudId) {
                            reference.targetObject.expectedCloudId = cloudId;
                            this.saveToFile();
                            return true;
                        }
                    }
                } else if (targetObj) {
                    console.log(`        ⏳ Target object not ready: ${reference.targetObject.objectKey} (status: ${targetObj.status})`);
                }
            }
            
            console.log(`        ❌ Target object not found in mappings: ${reference.targetObject.objectKey}`);
            return false; // Target doesn't exist yet
        }
        
        return true; // Prerequisites met
    }
    
    /**
     * Escape special characters in AQL values
     */
    escapeAQLValue(str) {
        if (!str) return str;
        
        // Escape quotes and backslashes for AQL
        return str
            .replace(/\\/g, '\\\\')  // Escape backslashes first
            .replace(/"/g, '\\"');    // Escape quotes
    }

    /**
     * Get cloud attribute ID from datacenter attribute ID
     * This dynamically fetches cloud attributes and finds the matching one
     */
    /**
     * Get cloud attribute ID for circular reference field mapping
     * 
     * @param {string} cloudObjectTypeId - Cloud object type ID
     * @param {string} dcAttributeId - Datacenter attribute ID
     * @param {string} schemaName - Schema name for context
     * @param {string} typePath - Object type path for context
     * @param {Object} apiClient - Cloud API client for attribute fetching
     * @returns {string} - Cloud attribute ID for circular reference update
     * 
     * AI INSTRUCTIONS:
     * - Maps datacenter attribute ID to corresponding cloud attribute ID
     * - Fetches cloud object type attributes via API for accurate mapping
     * - Uses fuzzy matching (name-based) when direct ID mapping fails
     * - Critical for accurate circular reference field updates
     * - Used by processPendingReferences() for proper field mapping
     */
    async getCloudAttributeId(cloudObjectTypeId, dcAttributeId, schemaName, typePath, apiClient) {
        try {
            // Step 1: Get cloud attributes for this object type
            console.log(`        🔍 Fetching cloud attributes for object type ${cloudObjectTypeId}`);
            const cloudAttributes = await apiClient.getObjectTypeAttributes(cloudObjectTypeId);
            
            // Step 2: Load datacenter schema attributes to get the DC attribute name
            const fs = require('fs');
            const path = require('path');
            const datacenterPath = path.join(__dirname, '..', '..', 'datacenter_assets');
            const schemaAttrPath = path.join(datacenterPath, schemaName, 'schema_attributes.json');
            
            if (!fs.existsSync(schemaAttrPath)) {
                console.log(`        ⚠️  Cannot find DC schema attributes at ${schemaAttrPath}`);
                // Try to find by matching attribute names that contain the ID
                const found = cloudAttributes.find(ca => ca.name.includes(dcAttributeId.toString()));
                if (found) {
                    console.log(`        🎯 Found cloud attribute by ID match: ${found.name} (${found.id})`);
                    return found.id;
                }
                return dcAttributeId;
            }
            
            const dcSchemaAttributes = JSON.parse(fs.readFileSync(schemaAttrPath, 'utf8'));
            const dcAttrMeta = dcSchemaAttributes.find(a => a.id === dcAttributeId);
            
            if (!dcAttrMeta) {
                console.log(`        ⚠️  No DC attribute metadata found for ID ${dcAttributeId}`);
                return dcAttributeId;
            }
            
            console.log(`        📝 DC Attribute: ${dcAttrMeta.name} (ID: ${dcAttributeId})`);
            
            // Step 3: Find matching cloud attribute by name (using same logic as attributeMapper)
            // Direct match first
            let cloudAttr = cloudAttributes.find(ca => ca.name === dcAttrMeta.name);
            
            // Case-insensitive match
            if (!cloudAttr) {
                const dcNameLower = dcAttrMeta.name.toLowerCase();
                cloudAttr = cloudAttributes.find(ca => ca.name.toLowerCase() === dcNameLower);
            }
            
            // Handle underscores vs spaces
            if (!cloudAttr) {
                const normalizedDcName = dcAttrMeta.name.replace(/[_\s-]+/g, ' ').toLowerCase();
                cloudAttr = cloudAttributes.find(ca => 
                    ca.name.replace(/[_\s-]+/g, ' ').toLowerCase() === normalizedDcName
                );
            }
            
            if (cloudAttr) {
                console.log(`        ✅ Found cloud attribute: ${cloudAttr.name} (ID: ${cloudAttr.id})`);
                return cloudAttr.id;
            }
            
            console.log(`        ⚠️  No matching cloud attribute found for ${dcAttrMeta.name}`);
            return dcAttributeId;
            
        } catch (error) {
            console.log(`        ❌ Error getting cloud attribute ID: ${error.message}`);
            return dcAttributeId;
        }
    }
    
    /**
     * Process all pending circular references with plan field status integration
     * 
     * @param {Object} apiClient - Cloud API client for object updates
     * @param {Object} createdObjectsTracker - For target object mapping lookups
     * @param {Object} migrationPlan - For field status updates and plan integration
     * @returns {Object} - Processing statistics with success/failed/pending counts
     * 
     * AI INSTRUCTIONS:
     * - Resolves circular references by updating source objects with target object references
     * - Uses created_objects_mapping.json for target object lookup (no cloud queries)
     * - Updates plan field status when circular references are resolved successfully
     * - Handles both pending and previously failed references with retry logic
     * - Critical post-processing step for completing object relationships
     * - Plan integration ensures circular field resolution is tracked properly
     */
    async processPendingReferences(apiClient, createdObjectsTracker = null, migrationPlan = null) {
        // Get both pending and failed references that should be retried
        const pending = this.getPendingReferences();
        const failed = this.getFailedReferencesToRetry();
        const toProcess = [...pending, ...failed];
        
        if (toProcess.length === 0) {
            console.log('    ✅ No circular references to resolve');
            return { success: 0, failed: 0, pending: 0 };
        }
        
        console.log(`\n🔄 PLAN-INTEGRATED CIRCULAR REFERENCE RESOLUTION`);
        console.log(`    📊 Pending references: ${pending.length}`);
        console.log(`    🔄 Retrying failed references: ${failed.length}`);
        console.log(`    📊 Total to process: ${toProcess.length}`);
        console.log(`    📋 Using plan field status tracking`);
        
        let successCount = 0;
        let failedCount = 0;
        let stillPending = 0;
        
        for (const reference of toProcess) {
            console.log(`\n    🔄 Processing circular reference: ${reference.id}`);
            console.log(`        Source: ${reference.sourceObject.objectName} (${reference.sourceObject.cloudId})`);
            console.log(`        Field: ${reference.field.name}`);
            console.log(`        Target: ${reference.targetObject.objectName || reference.targetObject.objectKey}`);
            
            // If this is a retry of a failed reference, log that
            if (reference.status === 'failed') {
                console.log(`        🔄 Retrying previously failed reference (attempt ${(reference.attempts || 0) + 1})`);
            }
            
            // Check prerequisites using plan integration
            const ready = await this.checkPrerequisites(reference, apiClient, createdObjectsTracker, migrationPlan);
            if (!ready) {
                console.log(`        ⏳ Prerequisites not met - target object doesn't exist yet`);
                stillPending++;
                continue;
            }
            
            // Look up the correct cloud attribute ID dynamically
            const cloudAttributeId = await this.getCloudAttributeId(
                reference.sourceObject.cloudObjectTypeId,
                reference.field.dcAttributeId,
                reference.sourceObject.schemaName,
                reference.sourceObject.typePath,
                apiClient
            );
            
            // Build update payload with correct cloud attribute ID
            const payload = {
                objectTypeId: reference.sourceObject.cloudObjectTypeId,
                attributes: [{
                    objectTypeAttributeId: cloudAttributeId,
                    objectAttributeValues: [{
                        value: reference.targetObject.expectedCloudId || reference.targetObject.objectKey
                    }]
                }]
            };
            
            try {
                // Update the object
                console.log(`        🔧 Updating object with circular reference...`);
                const result = await apiClient.updateObject(reference.sourceObject.cloudId, payload);
                
                if (result) {
                    console.log(`        ✅ Successfully resolved circular reference`);
                    this.updateStatus(reference.id, 'resolved');
                    
                    // PLAN INTEGRATION: Update field status in plan when circular reference is resolved
                    if (migrationPlan && migrationPlan.resolveCircularField && reference.field.fieldId) {
                        migrationPlan.resolveCircularField(
                            reference.sourceObject.datacenterKey || reference.sourceObject.objectKey,
                            reference.field.fieldId,
                            reference.targetObject.expectedCloudId
                        );
                        console.log(`        📋 Updated plan: circular field ${reference.field.fieldId} → completed`);
                    }
                    
                    successCount++;
                } else {
                    console.log(`        ❌ Failed to update object`);
                    this.updateStatus(reference.id, 'failed', 'Update returned no result');
                    
                    // PLAN INTEGRATION: Update field status in plan when circular reference fails
                    if (migrationPlan && migrationPlan.updateFieldStatus && reference.field.fieldId) {
                        migrationPlan.updateFieldStatus(
                            reference.sourceObject.datacenterKey || reference.sourceObject.objectKey,
                            reference.field.fieldId,
                            'failed',
                            null,
                            'Circular reference update failed'
                        );
                        console.log(`        📋 Updated plan field status: ${reference.field.fieldId} → failed`);
                    }
                    
                    failedCount++;
                }
            } catch (error) {
                console.log(`        ❌ Error resolving circular reference: ${error.message}`);
                
                // Check if this is a restriction error that might be resolved later
                if (error.message && error.message.includes('invalid due to restrictions')) {
                    // Extract the problematic object key from error
                    const objectMatch = error.message.match(/Object: ([A-Z]+-\d+)/);
                    if (objectMatch) {
                        const missingObjectKey = objectMatch[1];
                        console.log(`        ⚠️  Referenced object ${missingObjectKey} is invalid due to restrictions`);
                        console.log(`        🔍 This may mean:`);
                        console.log(`           1. The object doesn't exist in the cloud yet`);
                        console.log(`           2. The field has AQL restrictions that filter this object`);
                        console.log(`           3. The object is in the wrong schema/type for this reference`);
                        
                        // Check if the referenced object exists
                        try {
                            const escapedKey = this.escapeAQLValue(missingObjectKey);
                            const aqlQuery = `Key = "${escapedKey}"`;
                            const searchResult = await apiClient.executeAQL(aqlQuery, 0, 1);
                            
                            if (searchResult && searchResult.values && searchResult.values.length > 0) {
                                console.log(`        ℹ️  Object ${missingObjectKey} EXISTS in cloud (ID: ${searchResult.values[0].id})`);
                                console.log(`        ⚠️  This is likely an AQL restriction or wrong object type issue`);
                            } else {
                                console.log(`        ❌ Object ${missingObjectKey} NOT FOUND in cloud - needs to be created first`);
                            }
                        } catch (checkError) {
                            console.log(`        ⚠️  Could not verify if object exists: ${checkError.message}`);
                        }
                    }
                }
                
                this.updateStatus(reference.id, 'failed', error.message);
                
                // PLAN INTEGRATION: Update field status in plan when circular reference fails
                if (migrationPlan && migrationPlan.updateFieldStatus && reference.field.fieldId) {
                    migrationPlan.updateFieldStatus(
                        reference.sourceObject.datacenterKey || reference.sourceObject.objectKey,
                        reference.field.fieldId,
                        'failed',
                        null,
                        `Circular reference error: ${error.message}`
                    );
                    console.log(`        📋 Updated plan field status: ${reference.field.fieldId} → failed`);
                }
                
                failedCount++;
            }
        }
        
        console.log(`\n    📊 Circular Reference Resolution Complete:`);
        console.log(`        ✅ Resolved: ${successCount}`);
        console.log(`        ❌ Failed: ${failedCount}`);
        console.log(`        ⏳ Still Pending: ${stillPending}`);
        
        return { success: successCount, failed: failedCount, pending: stillPending };
    }

    /**
     * Clear resolved references (optional cleanup)
     */
    clearResolved() {
        const before = this.references.length;
        this.references = this.references.filter(r => r.status !== 'resolved');
        const removed = before - this.references.length;
        
        if (removed > 0) {
            this.saveToFile();
            console.log(`    🧹 Cleared ${removed} resolved circular references`);
        }
        
        return removed;
    }

    /**
     * Get statistics
     */
    getStatistics() {
        return {
            total: this.references.length,
            pending: this.references.filter(r => r.status === 'pending').length,
            resolved: this.references.filter(r => r.status === 'resolved').length,
            failed: this.references.filter(r => r.status === 'failed').length
        };
    }
    
    /**
     * Clean up circular references (remove failed and optionally resolved ones)
     */
    cleanupReferences(options = {}) {
        const {
            removeFailed = true,
            removeResolved = false
        } = options;
        
        const now = new Date();
        const before = this.references.length;
        const beforeStats = this.getStatistics();
        
        console.log('\n🧹 CLEANING CIRCULAR REFERENCES');
        console.log(`    📊 Before cleanup:`);
        console.log(`        Total: ${beforeStats.total}`);
        console.log(`        Failed: ${beforeStats.failed}`);
        console.log(`        Resolved: ${beforeStats.resolved}`);
        console.log(`        Pending: ${beforeStats.pending}`);
        
        // Create backup before cleaning
        if (before > 0) {
            const backupPath = this.filePath.replace('.json', `_backup_${now.toISOString().replace(/[:.]/g, '-').substring(0, 19)}.json`);
            try {
                fs.writeFileSync(backupPath, JSON.stringify(this.references, null, 2));
                console.log(`    💾 Backup saved to: ${path.basename(backupPath)}`);
            } catch (error) {
                console.log(`    ⚠️  Could not create backup: ${error.message}`);
            }
        }
        
        // Filter references - SIMPLE
        let removed = 0;
        this.references = this.references.filter(ref => {
            // Remove failed references
            if (removeFailed && ref.status === 'failed') {
                removed++;
                return false;
            }
            
            // Remove resolved references if requested
            if (removeResolved && ref.status === 'resolved') {
                removed++;
                return false;
            }
            
            return true;
        });
        
        // Save cleaned file
        this.saveToFile();
        
        const afterStats = this.getStatistics();
        
        console.log(`\n    📊 After cleanup:`);
        console.log(`        Total: ${afterStats.total}`);
        console.log(`        Failed: ${afterStats.failed}`);
        console.log(`        Resolved: ${afterStats.resolved}`);
        console.log(`        Pending: ${afterStats.pending}`);
        console.log(`\n    ✅ Removed ${removed} references`);
        
        return {
            removed: removed,
            remaining: afterStats.total,
            stats: afterStats
        };
    }
}

module.exports = CircularReferenceTracker;
