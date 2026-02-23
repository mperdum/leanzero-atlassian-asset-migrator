/**
 * Object Migrator Module - SIMPLIFIED
 *
 * Handles object migration using two-phase approach:
 * Phase 1: Create objects without reference fields
 * Phase 2: Update objects with reference fields
 */

const fs = require("fs");
const path = require("path");

const CircularReferenceTracker = require("./circularReferenceTracker");
const CreatedObjectsTracker = require("./createdObjectsTracker");

class ObjectMigrator {
  constructor(config, modules) {
    this.config = config;
    this.modules = modules;
    this.datacenterPath =
      process.env.DATACENTER_PATH ||
      path.join(process.cwd(), "..", "datacenter_assets");

    this.circularTracker = new CircularReferenceTracker();
    this.createdObjectsTracker = new CreatedObjectsTracker();

    // Initialize attribute mapper for proper field mapping
    const AttributeMapper = require("./attributeMapper");
    this.attributeMapper = new AttributeMapper(
      this.config.workspaceId,
      this.config.apiToken,
      this.modules.apiClient,
    );

    this.planBuilder = null;
    this.plan = null;
  }

  /**
   * SIMPLIFIED PLAN-DRIVEN MIGRATION
   */
  async migrateFromPlan(schemaFilter = null, typeFilter = null) {
    console.log("\n🎯 SIMPLIFIED PLAN-DRIVEN MIGRATION...");

    // Load or build the plan first
    if (this.planBuilder) {
      this.plan = await this.planBuilder.loadOrBuildPlan(
        schemaFilter,
        typeFilter,
      );
    }

    if (!this.plan || !this.plan.objects || this.plan.objects.length === 0) {
      console.log("❌ No migration plan available");
      return;
    }

    console.log(
      `  📊 Status: ${this.plan.stats.created || 0} created, ${this.plan.stats.pending || this.plan.objects.length} pending`,
    );

    // Process objects in plan order with minimal passes
    let passNumber = 1;
    const maxPasses = 3;

    while (passNumber <= maxPasses) {
      console.log(`\n📊 Pass ${passNumber} Results:`);
      console.log(`    Total processed: ${this.plan.objects.length}`);

      let passCreated = 0;
      let passSkipped = 0;

      for (const planObject of this.plan.objects) {
        if (planObject.status === "created") {
          continue; // Skip already created
        }

        // Check dependencies
        const depCheck = this.checkDependenciesInMapping(planObject);
        if (!depCheck.allSatisfied) {
          passSkipped++;
          continue;
        }

        // Create object
        const createResult = await this.createObjectFromPlan(planObject);

        if (createResult.success) {
          passCreated++;
        } else {
          console.log(`    ❌ FAILED: ${createResult.error}`);
          await this.markObjectFailed(planObject, createResult.error);
        }
      }

      // Stop if no progress made
      if (passCreated === 0) {
        if (passSkipped === 0) {
          console.log(`    🎉 All objects processed!`);
          break;
        } else {
          console.log(
            `    💡 No progress made - may need dependency resolution`,
          );
          if (passNumber >= maxPasses) {
            console.log(`    🛑 Reached max passes - stopping`);
            break;
          }
        }
      }

      // Save mapping after each pass (checkpoint)
      if (passCreated > 0 || passSkipped > 0) {
        this.createdObjectsTracker.forceSave();
      }

      passNumber++;
    }

    // PHASE 3: Process circular dependency groups
    try {
      console.log("\n🔄 PHASE 3: Processing circular dependency groups...");
      await this.processCircularDependencies();
      console.log("✅ Circular dependency processing completed");
      // Save after phase 3
      this.createdObjectsTracker.forceSave();
    } catch (error) {
      console.error(
        `❌ Circular dependency processing failed: ${error.message}`,
      );
      console.error(
        "⚠️  Continuing with reference updates despite circular processing failure...",
      );
    }

    // PHASE 4: Update all objects with references (separate phase to avoid duplicates)

    // Reset failed reference statuses to pending before reference updates
    // This prevents accumulation of historical failures across multiple runs
    const resetCount = this.planBuilder.resetFailedReferencesToPending();
    if (resetCount > 0) {
      console.log(
        `\n🔄 Reset ${resetCount} failed references to pending for retry`,
      );
    }

    try {
      console.log("\n🔗 PHASE 4: Starting reference updates...");
      await this.processReferenceUpdates();
      console.log("✅ Reference update processing completed");
      // Save after phase 4
      this.createdObjectsTracker.forceSave();
    } catch (error) {
      console.error(`❌ Reference update processing failed: ${error.message}`);
      console.error(error.stack);
    }

    // Save final state
    if (this.planBuilder.needsSave) {
      this.planBuilder.forceSave();
    }
    if (this.createdObjectsTracker.needsSave) {
      this.createdObjectsTracker.forceSave();
    }
  }

  /**
   * Check if object dependencies are satisfied using mapping
   */
  checkDependenciesInMapping(planObject) {
    const result = {
      allSatisfied: true,
      missingCount: 0,
      missingKeys: [],
    };

    if (!planObject.dependencies || planObject.dependencies.length === 0) {
      return result;
    }

    // Check each dependency in the mapping
    for (const depKey of planObject.dependencies) {
      if (!this.createdObjectsTracker.hasCreated(depKey)) {
        result.allSatisfied = false;
        result.missingCount++;
        result.missingKeys.push(depKey);
      }
    }

    return result;
  }

  /**
   * Create object from plan using two-phase approach
   */
  async createObjectFromPlan(planObject) {
    const result = {
      success: false,
      cloudId: null,
      error: null,
    };

    try {
      console.log(`    🔨 Creating: ${planObject.datacenterKey}`);

      // Load datacenter object
      const dcObject = await this.loadDCObject(planObject);
      if (!dcObject) {
        result.error = "Could not load datacenter object";
        return result;
      }

      // Get cloud configuration
      const config = await this.getCloudConfig(
        planObject.schema,
        planObject.objectType,
      );
      if (!config) {
        result.error = "Could not get cloud configuration";
        return result;
      }

      // PRE-VALIDATION: Check user fields and log which ones will be skipped (but don't block object creation)
      const userValidation = await this.validateUserFields(
        dcObject,
        config,
        planObject,
      );
      if (!userValidation.valid && userValidation.invalidUsers.length > 0) {
        console.log(
          `    ⚠️  ${userValidation.invalidUsers.length} invalid users will be skipped: ${userValidation.invalidUsers.join(", ")}`,
        );
        console.log(
          `    ➡️  Object creation will continue with remaining fields`,
        );
      }

      // PHASE 1: Create object without reference fields using existing attributeMapper
      const cloudObject = await this.buildCloudObjectWithoutReferences(
        dcObject,
        config,
        planObject,
      );

      if (!cloudObject || cloudObject.attributes.length === 0) {
        result.error = "No valid non-reference attributes found";
        return result;
      }

      // Create the object in cloud
      const cloudResult =
        await this.modules.apiClient.createObject(cloudObject);

      if (cloudResult && cloudResult.id) {
        result.success = true;
        result.cloudId = cloudResult.id;

        console.log(
          `    ✅ CREATED: ${planObject.datacenterKey} → ${cloudResult.id}`,
        );

        // Store mapping and update plan
        this.createdObjectsTracker.trackCreatedObject(
          planObject.datacenterKey,
          cloudResult.objectKey || cloudResult.id,
          {
            cloudId: cloudResult.id,
            name: planObject.name,
            schema: planObject.schema,
            objectType: planObject.objectType,
          },
        );
        await this.updateObjectStatus(
          planObject.datacenterKey,
          "created",
          cloudResult.id,
        );

        // POST-CREATION: Upload attachments if enabled and available
        if (
          this.modules.attachmentUploader &&
          dcObject.attachments &&
          dcObject.attachments.length > 0
        ) {
          try {
            const attachmentResult =
              await this.modules.attachmentUploader.uploadAttachmentsForObject(
                dcObject,
                cloudResult,
                null, // attachmentsDir not needed as we have localFilePath in dcObject.attachments
              );

            if (attachmentResult.skipped) {
              console.log(
                `    ⏭️  Attachment upload skipped: ${attachmentResult.reason}`,
              );
            } else if (attachmentResult.summary) {
              console.log(
                `    📎 Attachments: ${attachmentResult.summary.successful} uploaded, ${attachmentResult.summary.failed} failed`,
              );
            }
          } catch (error) {
            console.log(`    ⚠️  Attachment upload error: ${error.message}`);
            // Don't fail object creation if attachment upload fails
          }
        }

        // POST-CREATION: Connect tickets if enabled and available
        if (
          this.modules.ticketConnector &&
          dcObject.connectedTickets &&
          dcObject.connectedTickets.length > 0
        ) {
          try {
            const ticketResult =
              await this.modules.ticketConnector.connectTicketsToObject(
                dcObject,
                cloudResult,
              );

            if (ticketResult.skipped) {
              console.log(
                `    ⏭️  Ticket connection skipped: ${ticketResult.reason}`,
              );
            } else if (ticketResult.summary) {
              console.log(
                `    🎫 Tickets: ${ticketResult.summary.successful} connected, ${ticketResult.summary.failed} failed`,
              );
            }
          } catch (error) {
            console.log(`    ⚠️  Ticket connection error: ${error.message}`);
            // Don't fail object creation if ticket connection fails
          }
        }

        // SKIP PHASE 2 during creation - we'll do references separately
        // This prevents marking objects as failed when reference updates fail
      } else {
        console.log(`    ❌ CREATION FAILED: No object ID returned from cloud`);
        result.error = "Cloud API returned no object ID";
        // CRITICAL: Mark as failed when creation fails
        await this.markObjectFailed(planObject, result.error);
      }
    } catch (error) {
      result.error = error.message;
      // CRITICAL: Mark as failed when any exception occurs during creation
      await this.markObjectFailed(planObject, error.message);
    }
    // 🧹 MEMORY CLEANUP NOTE: Variables declared with 'const' are automatically
    // garbage collected when function exits. No explicit cleanup needed here.
    // The real memory savings come from the LRU caches limiting growth.

    return result;
  }

  /**
   * Build cloud object WITHOUT reference fields using existing attributeMapper
   */
  async buildCloudObjectWithoutReferences(dcObject, config, planObject) {
    try {
      // Get cloud attributes and datacenter schema attributes
      const cloudAttributes = await this.attributeMapper.fetchCloudAttributes(
        config.cloudObjectType.id,
      );
      const dcSchemaAttributes = await this.loadDCSchemaAttributes(
        planObject.schema,
      );

      const cloudObject = {
        objectTypeId: config.cloudObjectType.id,
        attributes: [],
      };

      // Process each datacenter attribute
      if (dcObject.attributes && Array.isArray(dcObject.attributes)) {
        for (const dcAttr of dcObject.attributes) {
          try {
            // Skip reference fields in phase 1
            if (this.isReferenceField(dcAttr)) {
              continue;
            }

            // User fields are now processed normally in phase 1
            // Invalid/deactivated users will be handled by transformUser() returning null

            // Use existing attributeMapper logic
            const mappedAttr = await this.attributeMapper.mapAttribute(
              dcAttr,
              cloudAttributes,
              dcSchemaAttributes,
              this.createdObjectsTracker.mapping,
              {
                schema: planObject.schema,
                objectType: planObject.objectType,
                objectKey: dcObject.objectKey,
              },
            );

            if (mappedAttr) {
              cloudObject.attributes.push(mappedAttr);
            }
          } catch (error) {
            // Skip circular references and missing dependencies for phase 1
            if (
              error.message === "CIRCULAR_REFERENCE_SKIP" ||
              error.message.includes("MISSING_OBJECT_CREATE_NEEDED")
            ) {
              continue;
            }
            throw error;
          }
        }
      }

      // CRITICAL: Ensure required attributes are present (like Name field)
      // This is where the fallback strategy gets applied
      console.log(
        `    🔍 Ensuring required attributes for ${dcObject.objectKey || dcObject.Key}`,
      );
      this.attributeMapper.ensureRequiredAttributes(
        cloudObject,
        cloudAttributes,
        dcObject,
      );

      return cloudObject;
    } catch (error) {
      console.error(`    ❌ Error building cloud object: ${error.message}`);
      throw error;
    }
  }

  /**
   * PRE-VALIDATE: Check if all user fields contain valid users before object creation
   */
  async validateUserFields(dcObject, config, planObject) {
    const result = {
      valid: true,
      invalidUsers: [],
      checkedUsers: 0,
    };

    try {
      // Get cloud attributes to identify user fields
      const cloudAttributes = await this.attributeMapper.fetchCloudAttributes(
        config.cloudObjectType.id,
      );
      const dcSchemaAttributes = await this.loadDCSchemaAttributes(
        planObject.schema,
      );

      // Check each datacenter attribute for user fields
      if (dcObject.attributes && Array.isArray(dcObject.attributes)) {
        for (const dcAttr of dcObject.attributes) {
          // Find the datacenter attribute metadata
          const dcAttrMeta = dcSchemaAttributes.find(
            (a) => a.id === dcAttr.objectTypeAttributeId,
          );
          if (!dcAttrMeta) continue;

          // Find matching cloud attribute
          const cloudAttr = this.attributeMapper.findCloudAttributeByName(
            dcAttrMeta.name,
            cloudAttributes,
          );
          if (!cloudAttr) continue;

          // Check if this is a user field
          if (
            cloudAttr.defaultType?.name === "User" ||
            cloudAttr.type === "User"
          ) {
            // Check each user value
            if (dcAttr.objectAttributeValues) {
              for (const dcValue of dcAttr.objectAttributeValues) {
                const userValue = dcValue.value || dcValue.displayValue;
                if (userValue) {
                  result.checkedUsers++;

                  // Extract email or name for validation
                  let searchQuery = userValue;
                  const emailMatch = userValue.match(/\(([^)]+@[^)]+)\)/);
                  if (emailMatch) {
                    searchQuery = emailMatch[1];
                  } else if (userValue.includes("@")) {
                    searchQuery = userValue;
                  }

                  // Check if user exists in Jira Cloud
                  const accountId =
                    await this.attributeMapper.getUserAccountId(searchQuery);
                  if (!accountId) {
                    result.valid = false;
                    result.invalidUsers.push(searchQuery);
                    console.log(`      ❌ Invalid user: ${searchQuery}`);
                  }
                }
              }
            }
          }
        }
      }

      if (result.checkedUsers > 0) {
        console.log(
          `    👥 Validated ${result.checkedUsers} users: ${result.invalidUsers.length} invalid`,
        );
      }
    } catch (error) {
      console.warn(`    ⚠️  User validation error: ${error.message}`);
      // If validation fails, allow creation (don't block migration)
      result.valid = true;
    }

    return result;
  }

  /**
   * Check if an attribute is a reference field
   * Enhanced to detect various types of reference structures
   */
  isReferenceField(dcAttr) {
    if (dcAttr.objectAttributeValues) {
      return dcAttr.objectAttributeValues.some((val) => {
        // Standard reference object structure
        if (val.referencedObject) {
          return true;
        }

        // Reference field with referencedType flag
        if (val.referencedType === true) {
          return true;
        }

        // Reference field with object-like structure but no referencedObject wrapper
        if (
          val.objectKey ||
          (val.searchValue &&
            val.displayValue &&
            val.searchValue !== val.displayValue)
        ) {
          return true;
        }

        return false;
      });
    }
    return false;
  }

  /**
   * PHASE 2: Update object with reference fields
   */
  async updateObjectWithReferences(planObject, cloudId, dcObject, config) {
    try {
      if (!planObject.references.hasReferences) {
        return;
      }

      console.log(
        `    🔗 Updating ${planObject.references.referenceFields.length} reference fields...`,
      );

      // Get cloud attributes and datacenter schema attributes
      const cloudAttributes = await this.attributeMapper.fetchCloudAttributes(
        config.cloudObjectType.id,
      );
      const dcSchemaAttributes = await this.loadDCSchemaAttributes(
        planObject.schema,
      );

      const updateObject = {
        id: cloudId,
        objectTypeId: config.cloudObjectType.id,
        attributes: [],
      };

      let referenceErrors = [];
      let processedReferences = 0;

      // Process ONLY reference fields
      if (dcObject.attributes && Array.isArray(dcObject.attributes)) {
        for (const dcAttr of dcObject.attributes) {
          try {
            // Only process reference fields in phase 2
            if (!this.isReferenceField(dcAttr)) {
              continue;
            }

            processedReferences++;

            // Use existing attributeMapper logic for reference fields
            const mappedAttr = await this.attributeMapper.mapAttribute(
              dcAttr,
              cloudAttributes,
              dcSchemaAttributes,
              this.createdObjectsTracker.mapping,
              {
                schema: planObject.schema,
                objectType: planObject.objectType,
                objectKey: dcObject.objectKey,
              },
            );

            if (mappedAttr) {
              updateObject.attributes.push(mappedAttr);
            }
          } catch (error) {
            // IMPROVED: Reference field error should NOT stop processing other references
            console.log(`      ❌ Reference field failed: ${error.message}`);
            referenceErrors.push(error.message);
            // Continue processing other reference fields instead of stopping
            continue;
          }
        }
      }

      // Report processing summary
      console.log(
        `      📊 Reference processing summary: ${processedReferences} total, ${updateObject.attributes.length} successful, ${referenceErrors.length} failed`,
      );

      // Update object with reference fields if any were processed successfully
      if (updateObject.attributes.length > 0) {
        console.log(
          `      🔗 Updating object with ${updateObject.attributes.length} reference fields...`,
        );
        const updateResult = await this.modules.apiClient.updateObject(
          cloudId,
          updateObject,
        );

        if (updateResult) {
          console.log(`      ✅ References updated successfully`);
          if (this.planBuilder) {
            const status = referenceErrors.length > 0 ? "partial" : "completed";
            const message =
              referenceErrors.length > 0
                ? `Partial success: ${referenceErrors.length} fields failed`
                : null;
            this.planBuilder.updateReferenceStatus(
              planObject.datacenterKey,
              status,
              message,
            );
          }
        } else {
          console.log(
            `      ❌ REFERENCE UPDATE FAILED: API returned no result`,
          );
          if (this.planBuilder) {
            this.planBuilder.updateReferenceStatus(
              planObject.datacenterKey,
              "failed",
              "Reference update API returned no result",
            );
          }
          return;
        }
      } else if (processedReferences > 0) {
        console.log(
          `      ❌ All ${processedReferences} reference fields failed`,
        );
        if (this.planBuilder) {
          this.planBuilder.updateReferenceStatus(
            planObject.datacenterKey,
            "failed",
            `All ${processedReferences} reference fields failed: ${referenceErrors.join("; ")}`,
          );
        }
      } else {
        console.log(`      ⏭️  No reference fields to update`);
        if (this.planBuilder) {
          this.planBuilder.updateReferenceStatus(
            planObject.datacenterKey,
            "completed",
            "No references needed",
          );
        }
      }
    } catch (error) {
      // FIXED: Any exception during reference update should NOT mark the entire object as failed
      console.error(
        `    ❌ FATAL: Exception during reference update - marking reference as FAILED: ${error.message}`,
      );
      if (this.planBuilder) {
        this.planBuilder.updateReferenceStatus(
          planObject.datacenterKey,
          "failed",
          `Reference update exception: ${error.message}`,
        );
      }
    }
    // 🧹 MEMORY CLEANUP NOTE: Variables declared with 'const' are automatically
    // garbage collected when function exits. No explicit cleanup needed.
  }

  /**
   * Process reference updates for all created objects
   */
  async processReferenceUpdates() {
    console.log("🔗 STARTING processReferenceUpdates()...");

    if (!this.planBuilder) {
      console.log("    ⚠️  No plan builder available for reference updates");
      return;
    }

    console.log("🔍 Getting objects needing reference updates...");
    const objectsNeedingReferences =
      this.planBuilder.getObjectsNeedingReferenceUpdates();

    console.log(
      `📊 Found ${objectsNeedingReferences.length} objects needing reference updates`,
    );

    if (objectsNeedingReferences.length === 0) {
      console.log("    ✅ No objects need reference updates");
      return;
    }

    console.log(
      `\n🔗 PHASE: REFERENCE UPDATES (${objectsNeedingReferences.length} objects)`,
    );
    console.log("=====================================");

    for (const planObject of objectsNeedingReferences) {
      console.log(
        `\n    🔗 Processing references for: ${planObject.datacenterKey}`,
      );

      try {
        // Load datacenter object
        const dcObject = this.loadDCObject(planObject);
        if (!dcObject) {
          console.log(`        ❌ Could not load datacenter object`);
          continue;
        }

        // Get cloud configuration
        const config = await this.getCloudConfig(
          planObject.schema,
          planObject.objectType,
        );
        if (!config) {
          console.log(`        ❌ Could not get cloud configuration`);
          continue;
        }

        // Update references
        await this.updateObjectWithReferences(
          planObject,
          planObject.cloudId,
          dcObject,
          config,
        );
      } catch (error) {
        console.log(`        ❌ Error processing references: ${error.message}`);
        if (this.planBuilder) {
          this.planBuilder.updateReferenceStatus(
            planObject.datacenterKey,
            "failed",
            error.message,
          );
        }
      }
    }

    console.log("\n✅ Reference update phase completed");
  }

  /**
   * Update object status in plan
   */
  async updateObjectStatus(
    datacenterKey,
    status,
    cloudId = null,
    error = null,
  ) {
    if (this.planBuilder) {
      this.planBuilder.updateObjectStatus(
        datacenterKey,
        status,
        cloudId,
        error,
      );
    }
  }

  /**
   * Mark object as failed in plan
   */
  async markObjectFailed(planObject, error) {
    await this.updateObjectStatus(
      planObject.datacenterKey,
      "failed",
      null,
      error,
    );
  }

  /**
   * Load datacenter object from file system
   */
  loadDCObject(planObject) {
    const parts = planObject.objectType.split("/");
    let filePath = path.join(
      this.datacenterPath,
      planObject.schema,
      ...parts,
      "objects.json",
    );

    if (!fs.existsSync(filePath)) return null;

    const objects = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return objects.find(
      (o) =>
        o.objectKey === planObject.datacenterKey ||
        o.Key === planObject.datacenterKey,
    );
  }

  /**
   * Load datacenter schema attributes
   */
  async loadDCSchemaAttributes(schemaName) {
    return this.attributeMapper.loadDatacenterSchemaAttributes(schemaName);
  }

  /**
   * Get cloud configuration for schema and object type
   */
  async getCloudConfig(schemaName, objectTypeName) {
    if (!this.modules.schemaMapper) {
      throw new Error("SchemaMapper not available");
    }

    try {
      const cloudSchema = this.modules.schemaMapper.findCloudSchema(schemaName);
      if (!cloudSchema) {
        throw new Error(`No cloud schema found for: ${schemaName}`);
      }

      const cloudObjectType = this.modules.schemaMapper.findCloudObjectType(
        objectTypeName,
        cloudSchema,
      );
      if (!cloudObjectType) {
        throw new Error(
          `No cloud object type found for: ${schemaName}/${objectTypeName}`,
        );
      }

      return {
        cloudSchema,
        cloudObjectType,
      };
    } catch (error) {
      console.error(`    ❌ Error getting cloud config: ${error.message}`);
      return null;
    }
  }

  /**
   * PHASE 3: Process circular dependency groups
   * Create objects in circular groups without references first
   */
  async processCircularDependencies() {
    console.log("\n🔄 PHASE 3: Processing circular dependency groups...");

    // Find all pending circular objects
    const circularObjects = this.plan.objects.filter(
      (obj) => obj.status === "pending" && obj.category === "circular",
    );

    if (circularObjects.length === 0) {
      console.log("    ✅ No circular dependencies to process");
      return;
    }

    console.log(
      `    📊 Found ${circularObjects.length} circular dependency objects to create`,
    );

    // Group by circular group for batch processing
    const groups = new Map();
    for (const obj of circularObjects) {
      const groupId = obj.circularGroup;
      if (!groups.has(groupId)) {
        groups.set(groupId, []);
      }
      groups.get(groupId).push(obj);
    }

    console.log(`    🔗 Processing ${groups.size} circular dependency groups`);

    // Process each circular group
    for (const [groupId, groupObjects] of groups) {
      console.log(
        `\n    🔄 Processing circular group ${groupId} (${groupObjects.length} objects)`,
      );

      // Create all objects in the group WITHOUT references
      for (const planObject of groupObjects) {
        console.log(
          `        🔨 Creating circular object: ${planObject.datacenterKey} (${planObject.name})`,
        );

        const createResult = await this.createObjectFromPlan(planObject);

        if (createResult.success) {
          console.log(
            `        ✅ Created circular object: ${planObject.datacenterKey} → ${createResult.cloudId}`,
          );
        } else {
          console.log(
            `        ❌ Failed to create circular object: ${createResult.error}`,
          );
          await this.markObjectFailed(planObject, createResult.error);
        }
      }
    }

    console.log("    ✅ Circular dependency creation phase complete");
  }

  /**
   * PHASE 4: Update all objects with references
   * Now that all objects exist, we can safely add references
   */
  async updateAllObjectReferences() {
    console.log("\n🔗 PHASE 4: Updating all objects with references...");

    // Find all created objects that have references
    const objectsWithReferences = this.plan.objects.filter(
      (obj) => obj.status === "created" && obj.references.hasReferences,
    );

    if (objectsWithReferences.length === 0) {
      console.log("    ✅ No objects need reference updates");
      return;
    }

    console.log(
      `    📊 Found ${objectsWithReferences.length} objects needing reference updates`,
    );

    let successCount = 0;
    let failedCount = 0;

    for (const planObject of objectsWithReferences) {
      try {
        // Load the datacenter object
        const dcObject = await this.loadDatacenterObject(planObject);
        if (!dcObject) {
          console.log(
            `        ❌ Could not load datacenter object: ${planObject.datacenterKey}`,
          );
          failedCount++;
          continue;
        }

        // Get cloud configuration
        const config = await this.getCloudConfig(
          planObject.schema,
          planObject.objectType,
        );

        // Update with references
        console.log(
          `        🔗 Updating references for: ${planObject.datacenterKey} (${planObject.name})`,
        );
        await this.updateObjectWithReferences(
          planObject,
          planObject.cloudId,
          dcObject,
          config,
        );

        successCount++;
      } catch (error) {
        console.log(
          `        ❌ Failed to update references for ${planObject.datacenterKey}: ${error.message}`,
        );
        failedCount++;
      }
    }

    console.log(
      `    📊 Reference updates: ${successCount} success, ${failedCount} failed`,
    );
    console.log("    ✅ Reference update phase complete");
  }

  /**
   * Load datacenter object data for a plan object
   */
  async loadDatacenterObject(planObject) {
    try {
      // Construct the path to the datacenter object file
      const schemaPath = path.join(this.datacenterPath, planObject.schema);
      const objectTypePath = path.join(schemaPath, planObject.objectType);
      const objectsFile = path.join(objectTypePath, "objects.json");

      if (!fs.existsSync(objectsFile)) {
        console.log(`        ❌ Objects file not found: ${objectsFile}`);
        return null;
      }

      // Load and find the specific object
      const objects = JSON.parse(fs.readFileSync(objectsFile, "utf8"));
      const dcObject = objects.find(
        (obj) =>
          obj.objectKey === planObject.datacenterKey ||
          obj.Key === planObject.datacenterKey,
      );

      if (!dcObject) {
        console.log(
          `        ❌ Object not found in datacenter: ${planObject.datacenterKey}`,
        );
        return null;
      }

      return dcObject;
    } catch (error) {
      console.log(
        `        ❌ Error loading datacenter object: ${error.message}`,
      );
      return null;
    }
  }
}

module.exports = ObjectMigrator;
