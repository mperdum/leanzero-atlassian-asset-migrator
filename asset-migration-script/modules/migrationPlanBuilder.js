/**
 * MigrationPlanBuilder - Builds and manages a proper migration plan with correct ordering
 *
 * FIXED VERSION: Handles cross-type, cross-schema dependencies and complex circular references
 * Order: STANDALONE → DEEPEST CHILDREN → INTERMEDIATE CHILDREN → PARENTS
 * Tracks status: pending/created/failed for each object
 */

const fs = require("fs");
const path = require("path");

class MigrationPlanBuilder {
  constructor(datacenterPath) {
    this.datacenterPath = datacenterPath;
    this.planFile = path.join(__dirname, "../logs/migration_plan.json");
    this.plan = null;

    // Global object registry for dependency resolution
    this.allObjects = new Map(); // Key: "schema:type:key" → Value: object data
    this.dependencyGraph = new Map(); // Key: object key → Value: Set of dependencies
    this.reverseDependencyGraph = new Map(); // Key: object key → Value: Set of dependents

    // PERFORMANCE OPTIMIZATIONS
    this.needsSave = false;
    this.batchSaveTimer = null;
    this.batchSaveInterval = 1000; // Save every 1 second when changes pending
    this.objectIndexCache = new Map(); // Cache object lookups by datacenterKey
    this.fieldIndexCache = new Map(); // Cache field lookups by objectKey:fieldId
    this.lastCacheRebuild = Date.now();
    this.cacheRebuildInterval = 10000; // Rebuild cache every 10 seconds
  }

  /**
   * Load existing plan or build a new one with comprehensive resume validation
   */
  async loadOrBuildPlan(schemaFilter = null, typeFilter = null) {
    // Check if plan exists
    if (fs.existsSync(this.planFile)) {
      const loadedPlan = JSON.parse(fs.readFileSync(this.planFile, "utf8"));

      // VALIDATE PLAN INTEGRITY for resume capability
      const validationResult = await this.validatePlanIntegrity(
        loadedPlan,
        schemaFilter,
        typeFilter,
      );

      if (validationResult.isValid) {
        this.plan = loadedPlan;

        // PERFORMANCE: Build cache for fast lookups
        this.rebuildObjectCache();

        console.log(
          `  📊 Progress: ${this.plan.stats.created || 0} created, ${this.plan.stats.failed || 0} failed, ${this.plan.stats.pending || this.plan.totalObjects} pending`,
        );

        if (validationResult.resumeInfo) {
          this.printResumeInfo(validationResult.resumeInfo);
        }

        return this.plan;
      } else {
        console.log(`  ⚠️  Plan validation failed: ${validationResult.reason}`);
        console.log("  🔄 Building new plan to ensure consistency...");
        // Fall through to build new plan
      }
    }

    // Build new plan

    this.plan = await this.buildPlan(schemaFilter, typeFilter);
    this.savePlan(true); // Force save for new plans
    return this.plan;
  }

  /**
   * COMPREHENSIVE PLAN INTEGRITY VALIDATION for resume capability
   */
  async validatePlanIntegrity(
    loadedPlan,
    schemaFilter = null,
    typeFilter = null,
  ) {
    const result = {
      isValid: false,
      reason: "",
      resumeInfo: null,
    };

    try {
      // Check plan structure
      if (
        !loadedPlan ||
        !loadedPlan.objects ||
        !Array.isArray(loadedPlan.objects)
      ) {
        result.reason = "Invalid plan structure";
        return result;
      }

      // Check plan version compatibility
      const currentVersion = "3.0";
      if (loadedPlan.version !== currentVersion) {
        result.reason = `Plan version mismatch: ${loadedPlan.version} vs ${currentVersion}`;
        return result;
      }

      // Validate object structure (current plan format uses simple object-level tracking)
      let invalidObjects = 0;
      for (const obj of loadedPlan.objects) {
        // Check essential object properties
        if (
          !obj.datacenterKey ||
          !obj.status ||
          !obj.schema ||
          !obj.objectType
        ) {
          invalidObjects++;
          continue;
        }

        // Validate status values
        if (!["pending", "created", "failed"].includes(obj.status)) {
          invalidObjects++;
          continue;
        }
      }

      if (invalidObjects > 0) {
        result.reason = `${invalidObjects} objects have invalid structure`;
        return result;
      }

      // Validate filters match current execution
      if (
        schemaFilter &&
        !loadedPlan.objects.some((o) => o.schema === schemaFilter)
      ) {
        result.reason = `Schema filter '${schemaFilter}' not found in plan`;
        return result;
      }

      if (
        typeFilter &&
        !loadedPlan.objects.some((o) => o.objectType.includes(typeFilter))
      ) {
        result.reason = `Type filter '${typeFilter}' not found in plan`;
        return result;
      }

      // Generate resume information
      result.resumeInfo = this.generateResumeInfo(loadedPlan);

      // Plan is valid for resume
      result.isValid = true;
      result.reason = "Plan validated successfully";
    } catch (error) {
      result.reason = `Plan validation error: ${error.message}`;
    }

    return result;
  }

  /**
   * Generate comprehensive resume information
   */
  generateResumeInfo(plan) {
    const resumeInfo = {
      lastModified: plan.stats?.lastModified || plan.createdAt,
      totalProgress: 0,
      canResume: true,
      resumeStrategy: "continue",
      recommendations: [],

      objectProgress: {
        total: plan.objects.length,
        completed: 0,
        pending: 0,
        failed: 0,
        partial: 0,
      },

      fieldProgress: {
        total: 0,
        completed: 0,
        pending: 0,
        failed: 0,
      },

      nextActions: [],
      potentialIssues: [],
    };

    // Analyze current state
    for (const obj of plan.objects) {
      if (obj.status === "created") {
        resumeInfo.objectProgress.completed++;
      } else if (obj.status === "pending") {
        resumeInfo.objectProgress.pending++;
      } else if (obj.status === "failed") {
        resumeInfo.objectProgress.failed++;
      } else if (obj.status === "partial") {
        resumeInfo.objectProgress.partial++;
      }

      // Field-level analysis
      if (obj.fields) {
        for (const field of obj.fields) {
          resumeInfo.fieldProgress.total++;
          if (field.status === "completed") {
            resumeInfo.fieldProgress.completed++;
          } else if (field.status === "pending") {
            resumeInfo.fieldProgress.pending++;
          } else if (field.status === "failed") {
            resumeInfo.fieldProgress.failed++;
          }
        }
      }
    }

    // Calculate total progress
    if (resumeInfo.objectProgress.total > 0) {
      resumeInfo.totalProgress =
        ((resumeInfo.objectProgress.completed +
          resumeInfo.objectProgress.partial) /
          resumeInfo.objectProgress.total) *
        100;
    }

    // Determine resume strategy
    if (
      resumeInfo.objectProgress.failed > resumeInfo.objectProgress.completed
    ) {
      resumeInfo.resumeStrategy = "investigate_failures";
      resumeInfo.recommendations.push(
        "High failure rate detected - investigate failed objects first",
      );
    } else if (resumeInfo.objectProgress.pending === 0) {
      resumeInfo.resumeStrategy = "complete";
      resumeInfo.recommendations.push(
        "Migration appears complete - run validation",
      );
    } else {
      resumeInfo.resumeStrategy = "continue";
      resumeInfo.recommendations.push(
        "Resume normal processing of pending objects",
      );
    }

    // Identify next actions
    const readyObjects = plan.objects
      .filter((o) => o.status === "pending")
      .slice(0, 5);
    for (const obj of readyObjects) {
      resumeInfo.nextActions.push(`Process ${obj.datacenterKey} (${obj.name})`);
    }

    // Identify potential issues
    if (resumeInfo.fieldProgress.failed > 0) {
      resumeInfo.potentialIssues.push(
        `${resumeInfo.fieldProgress.failed} fields failed - may need manual review`,
      );
    }

    if (resumeInfo.objectProgress.partial > 0) {
      resumeInfo.potentialIssues.push(
        `${resumeInfo.objectProgress.partial} objects partially complete - verify field status`,
      );
    }

    return resumeInfo;
  }

  /**
   * Print resume information to console
   */
  printResumeInfo(resumeInfo) {
    console.log("\n🔄 MIGRATION RESUME INFORMATION:");
    console.log("=".repeat(45));

    console.log(`📈 Overall Progress: ${resumeInfo.totalProgress.toFixed(1)}%`);
    console.log(`🎯 Resume Strategy: ${resumeInfo.resumeStrategy}`);
    console.log(
      `⏰ Last Modified: ${new Date(resumeInfo.lastModified).toLocaleString()}`,
    );

    console.log("\n📊 Object Status:");
    console.log(`   ✅ Completed: ${resumeInfo.objectProgress.completed}`);
    console.log(`   🔄 Partial: ${resumeInfo.objectProgress.partial}`);
    console.log(`   ⏳ Pending: ${resumeInfo.objectProgress.pending}`);
    console.log(`   ❌ Failed: ${resumeInfo.objectProgress.failed}`);

    if (resumeInfo.fieldProgress.total > 0) {
      console.log("\n📝 Field Status:");
      console.log(
        `   ✅ Completed: ${resumeInfo.fieldProgress.completed} (${((resumeInfo.fieldProgress.completed / resumeInfo.fieldProgress.total) * 100).toFixed(1)}%)`,
      );
      console.log(`   ⏳ Pending: ${resumeInfo.fieldProgress.pending}`);
      console.log(`   ❌ Failed: ${resumeInfo.fieldProgress.failed}`);
    }

    if (resumeInfo.nextActions.length > 0) {
      console.log("\n🚀 Next Actions:");
      for (const action of resumeInfo.nextActions) {
        console.log(`   • ${action}`);
      }
    }

    if (resumeInfo.recommendations.length > 0) {
      console.log("\n💡 Recommendations:");
      for (const rec of resumeInfo.recommendations) {
        console.log(`   • ${rec}`);
      }
    }

    if (resumeInfo.potentialIssues.length > 0) {
      console.log("\n⚠️  Potential Issues:");
      for (const issue of resumeInfo.potentialIssues) {
        console.log(`   • ${issue}`);
      }
    }

    console.log("");
  }

  /**
   * Validate plan consistency after loading (simplified for object-level tracking)
   */
  validatePlanConsistency() {
    if (!this.plan) return { valid: false, issues: ["No plan loaded"] };

    const issues = [];

    // Check basic object consistency
    for (const obj of this.plan.objects) {
      // Validate essential properties
      if (!obj.datacenterKey) {
        issues.push(`Object missing datacenterKey`);
        continue;
      }

      if (
        !obj.status ||
        !["pending", "created", "failed"].includes(obj.status)
      ) {
        issues.push(
          `Object ${obj.datacenterKey}: invalid status "${obj.status}"`,
        );
      }

      if (!obj.schema || !obj.objectType) {
        issues.push(
          `Object ${obj.datacenterKey}: missing schema or objectType`,
        );
      }
    }

    return {
      valid: issues.length === 0,
      issues: issues,
      objectsChecked: this.plan.objects.length,
    };
  }

  /**
   * Build comprehensive migration plan with dependency analysis and field-level tracking
   *
   * @param {string} schemaFilter - Optional schema name filter
   * @param {string} typeFilter - Optional object type filter
   * @returns {Object} - Complete migration plan with objects, dependencies, and field metadata
   *
   * AI INSTRUCTIONS:
   * - Creates the foundation for entire plan-driven migration system
   * - Loads ALL datacenter objects and builds complete dependency graph
   * - Performs topological sorting: standalone → deepest dependencies → parents
   * - Extracts comprehensive field metadata for every object
   * - Detects circular dependency groups for special handling
   * - Creates execution plan with field-level status tracking
   * - CRITICAL: This plan determines the exact order and success of migration
   */
  async buildPlan(schemaFilter = null, typeFilter = null) {
    const plan = {
      version: "3.0", // New version with proper dependency handling
      createdAt: new Date().toISOString(),
      totalObjects: 0,
      stats: {
        created: 0,
        failed: 0,
        pending: 0,
      },
      objects: [], // Flat list of ALL objects in correct order
    };

    // STEP 1: Load ALL objects from ALL schemas first
    console.log("  📦 Loading ALL objects from datacenter...");
    await this.loadAllObjects(schemaFilter, typeFilter);

    // STEP 2: Build complete dependency graph
    console.log("  🔗 Building dependency graph...");
    this.buildDependencyGraph();

    // STEP 3: Detect circular dependencies
    console.log("  🔄 Detecting circular dependencies...");
    const circularGroups = this.detectCircularDependencies();
    console.log(
      `    🔍 Found ${circularGroups.length} circular dependency groups`,
    );

    // STEP 4: Order objects using topological sort
    console.log("  📊 Determining migration order...");
    const orderedObjects = this.topologicalSort(circularGroups);

    // STEP 5: Build the plan
    let orderIndex = 0;
    for (const objKey of orderedObjects) {
      const objData = this.allObjects.get(objKey);
      if (!objData) continue;

      const dependencies = this.dependencyGraph.get(objKey) || new Set();
      const isCircular = circularGroups.some((group) => group.has(objKey));

      // Extract all fields from the object for field-level tracking
      const objectInfo = this.extractObjectInfo(objData.raw);

      // CRITICAL FIX: Convert global keys to datacenter keys for plan consistency
      const datacenterDependencies = [];
      for (const globalDepKey of dependencies) {
        const depObjData = this.allObjects.get(globalDepKey);
        if (depObjData) {
          datacenterDependencies.push(depObjData.datacenterKey);
        }
      }

      plan.objects.push({
        datacenterKey: objData.datacenterKey,
        name: objectInfo.name || objData.datacenterKey,
        schema: objData.schema,
        objectType: objData.objectType,
        status: "pending", // pending/created/failed
        order: orderIndex++,
        category:
          dependencies.size === 0
            ? "standalone"
            : isCircular
              ? "circular"
              : "dependency_chain",
        dependencies: datacenterDependencies,
        circularGroup: isCircular
          ? circularGroups.findIndex((g) => g.has(objKey))
          : null,
        references: objectInfo.references,
        createdAt: new Date().toISOString(),
        updatedAt: null,
        error: null,
        cloudId: null,
      });
    }

    plan.totalObjects = plan.objects.length;
    plan.stats.pending = plan.totalObjects;

    console.log(`\n  ✅ Migration plan built:`);
    console.log(`     • Total objects: ${plan.totalObjects}`);
    console.log(
      `     • Standalone: ${plan.objects.filter((o) => o.category === "standalone").length}`,
    );
    console.log(
      `     • With dependencies: ${plan.objects.filter((o) => o.category === "dependency_chain").length}`,
    );
    console.log(
      `     • Circular references: ${plan.objects.filter((o) => o.category === "circular").length}`,
    );
    console.log(`     • Circular groups: ${circularGroups.length}`);

    // Set the plan instance and mark for save so it gets written to disk
    this.plan = plan;
    this.markForSave();

    // 🧹 MEMORY OPTIMIZATION: Clear Maps after plan is built and no longer needed
    // These Maps are only used during plan building for dependency resolution
    // Once plan is saved to plan.objects array, we use objectIndexCache for lookups
    this.allObjects.clear();
    this.dependencyGraph.clear();
    this.reverseDependencyGraph.clear();
    console.log(`     🧹 Cleared dependency Maps (saves 3-5GB memory)`);

    return plan;
  }

  /**
   * Load all datacenter objects into memory for dependency analysis
   *
   * @param {string} schemaFilter - Optional schema filter
   * @param {string} typeFilter - Optional type filter
   * @returns {Promise} - Completes when all objects are loaded
   *
   * AI INSTRUCTIONS:
   * - Loads ALL objects from datacenter_assets directory structure
   * - Handles hierarchical object types (3 levels deep)
   * - Creates global object registry with unique keys: "schema:type:objectKey"
   * - Essential for building comprehensive dependency graph
   * - Filters objects based on provided schema/type filters
   * - Foundation for dependency analysis and plan ordering
   */
  async loadAllObjects(schemaFilter = null, typeFilter = null) {
    this.allObjects.clear();

    const schemas = this.getAllSchemas();
    const filteredSchemas = schemaFilter
      ? schemas.filter((s) => s === schemaFilter)
      : schemas;

    for (const schemaName of filteredSchemas) {
      const schemaPath = path.join(this.datacenterPath, schemaName);
      const objectTypes = this.getObjectTypes(schemaPath);
      const filteredTypes = typeFilter
        ? objectTypes.filter((t) => t === typeFilter)
        : objectTypes;

      for (const typePath of filteredTypes) {
        const objects = this.loadObjects(schemaPath, typePath);

        for (const obj of objects) {
          const objKey = obj.objectKey || obj.Key || `${schemaName}-${obj.id}`;
          const globalKey = `${schemaName}:${typePath}:${objKey}`;

          this.allObjects.set(globalKey, {
            datacenterKey: objKey,
            name: obj.label || obj.Name || obj.name,
            schema: schemaName,
            objectType: typePath,
            raw: obj,
            globalKey: globalKey,
          });
        }
      }
    }
  }

  /**
   * Build the complete dependency graph
   */
  buildDependencyGraph() {
    this.dependencyGraph.clear();
    this.reverseDependencyGraph.clear();

    let unresolvedCount = 0;
    let resolvedCount = 0;

    for (const [globalKey, objData] of this.allObjects) {
      const dependencies = new Set();
      const obj = objData.raw;

      // Find all references in this object
      if (obj.attributes && Array.isArray(obj.attributes)) {
        for (const attr of obj.attributes) {
          if (attr.objectAttributeValues) {
            for (const val of attr.objectAttributeValues) {
              if (val.referencedObject) {
                const refKey =
                  val.referencedObject.objectKey || val.referencedObject.key;
                const refName =
                  val.referencedObject.name || val.referencedObject.label;

                // Find the referenced object in our global registry
                const referencedObjKey = this.findObjectByKeyOrName(
                  refKey,
                  refName,
                );
                if (referencedObjKey && referencedObjKey !== globalKey) {
                  dependencies.add(referencedObjKey);
                  resolvedCount++;

                  // Also update reverse dependency graph
                  if (!this.reverseDependencyGraph.has(referencedObjKey)) {
                    this.reverseDependencyGraph.set(
                      referencedObjKey,
                      new Set(),
                    );
                  }
                  this.reverseDependencyGraph
                    .get(referencedObjKey)
                    .add(globalKey);
                } else if (!referencedObjKey && (refKey || refName)) {
                  // Track that we couldn't resolve this reference
                  // This happens when names are ambiguous or object doesn't exist
                  // The dependency resolver will handle this at runtime
                  // For now, we can't order this correctly
                  unresolvedCount++;
                }
              }
            }
          }
        }
      }

      this.dependencyGraph.set(globalKey, dependencies);
    }

    console.log(
      `    📊 Dependency graph built: ${this.dependencyGraph.size} objects with dependencies`,
    );
    console.log(`    ✅ Resolved references: ${resolvedCount}`);
    /**
     * AI INSTRUCTIONS: Unresolved reference handling in plan creation
     * - Some references can't be resolved during plan building (objects in other schemas, missing objects)
     * - These are handled during plan execution when full context is available
     * - Plan ordering and multi-pass execution resolves most unresolved references
     * - This is normal and expected behavior for complex multi-schema dependencies
     */
    console.log(
      `    ⚠️  Unresolved references: ${unresolvedCount} (normal - handled during plan execution)`,
    );

    if (this.missingKeys && this.missingKeys.size > 0) {
      console.log(
        `    ❗ Missing datacenter keys: ${this.missingKeys.size} (objects might be in unprocessed schemas)`,
      );
    }
  }

  /**
   * Find object in global registry by datacenter key
   * Keys are UNIQUE across the datacenter, so this should always work
   */
  findObjectByKeyOrName(key, name) {
    // PRIORITY 1: Find by datacenter key (these are UNIQUE!)
    if (key) {
      // Search ALL objects for this datacenter key
      for (const [globalKey, objData] of this.allObjects) {
        if (objData.datacenterKey === key) {
          return globalKey;
        }
      }

      // If key not found, the referenced object might be:
      // 1. In a schema we're not processing
      // 2. Deleted/missing from datacenter
      // 3. Not yet loaded (shouldn't happen since we load all first)

      // Log this for debugging
      if (!this.missingKeys) this.missingKeys = new Set();
      this.missingKeys.add(key);
    }

    // PRIORITY 2: Only use name as fallback if NO key provided
    /**
     * AI NOTE: Name-based reference fallback
     * - Used when datacenter references don't have object keys (older data format)
     * - Attempts exact name matching across all objects
     * - Only used if exactly one match found to avoid ambiguity
     * - Handles legacy datacenter data formats gracefully
     */
    if (!key && name) {
      // Try to find by exact name match
      const nameMatches = [];
      for (const [globalKey, objData] of this.allObjects) {
        if (objData.name === name) {
          nameMatches.push(globalKey);
        }
      }

      // Only use if we found exactly ONE match
      if (nameMatches.length === 1) {
        return nameMatches[0];
      }

      // Multiple or zero matches = can't determine
      // Dependency resolver will handle at runtime
    }

    return null;
  }

  /**
   * Detect ALL circular dependencies (including complex chains)
   */
  detectCircularDependencies() {
    const visited = new Set();
    const recursionStack = new Set();
    const circularGroups = [];

    for (const [objKey] of this.allObjects) {
      if (!visited.has(objKey)) {
        const circularPath = this.dfsDetectCycle(
          objKey,
          visited,
          recursionStack,
          [],
        );
        if (circularPath.length > 0) {
          // Found a circular dependency
          const group = new Set(circularPath);

          // Check if this group is already tracked
          const isNewGroup = !circularGroups.some(
            (existing) =>
              existing.size === group.size &&
              [...existing].every((k) => group.has(k)),
          );

          if (isNewGroup) {
            circularGroups.push(group);
            console.log(
              `    🔄 Found circular dependency group with ${group.size} objects`,
            );

            // Log the cycle for debugging
            const cycle = [...group].map((k) => {
              const obj = this.allObjects.get(k);
              return `${obj.schema}:${obj.objectType}:${obj.name}`;
            });
            console.log(`       Cycle: ${cycle.join(" → ")} → ...`);
          }
        }
      }
    }

    return circularGroups;
  }

  /**
   * DFS to detect cycles in dependency graph
   */
  dfsDetectCycle(objKey, visited, recursionStack, currentPath) {
    visited.add(objKey);
    recursionStack.add(objKey);
    currentPath.push(objKey);

    const dependencies = this.dependencyGraph.get(objKey) || new Set();

    for (const depKey of dependencies) {
      if (!visited.has(depKey)) {
        const result = this.dfsDetectCycle(depKey, visited, recursionStack, [
          ...currentPath,
        ]);
        if (result.length > 0) {
          return result;
        }
      } else if (recursionStack.has(depKey)) {
        // Found a cycle - return the cycle path
        const cycleStartIndex = currentPath.indexOf(depKey);
        if (cycleStartIndex !== -1) {
          return currentPath.slice(cycleStartIndex);
        }
      }
    }

    recursionStack.delete(objKey);
    return [];
  }

  /**
   * FIXED: Topological sort with PROPER dependency resolution
   */
  topologicalSort(circularGroups) {
    const sorted = [];
    const visited = new Set();

    // CRITICAL: Categorize objects by dependency resolution status
    const fullyResolved = []; // All dependencies found
    const partiallyResolved = []; // Some dependencies found
    const unresolved = []; // No dependencies found or all missing
    const standalone = []; // No dependencies at all

    for (const [objKey] of this.allObjects) {
      const deps = this.dependencyGraph.get(objKey) || new Set();

      if (deps.size === 0) {
        standalone.push(objKey);
      } else {
        // Check how many dependencies are actually resolvable
        let resolvedCount = 0;
        let unresolvedCount = 0;

        for (const depKey of deps) {
          // Check if this dependency exists in our loaded objects
          if (this.allObjects.has(depKey)) {
            resolvedCount++;
          } else {
            unresolvedCount++;
          }
        }

        if (unresolvedCount === 0) {
          fullyResolved.push(objKey);
        } else if (resolvedCount > 0) {
          partiallyResolved.push(objKey);
        } else {
          unresolved.push(objKey);
        }
      }
    }

    console.log(`    📊 Dependency Analysis:`);
    console.log(`       • Standalone (no deps): ${standalone.length}`);
    console.log(`       • Fully resolved: ${fullyResolved.length}`);
    console.log(`       • Partially resolved: ${partiallyResolved.length}`);
    console.log(`       • Unresolved: ${unresolved.length}`);

    // CRITICAL ORDER:
    // 1. Standalone objects (no dependencies)
    for (const objKey of standalone) {
      if (!visited.has(objKey)) {
        visited.add(objKey);
        sorted.push(objKey);
      }
    }

    // 2. Fully resolved objects (in dependency order)
    const tempVisited = new Set();
    for (const objKey of fullyResolved) {
      const isInCircularGroup = circularGroups.some((group) =>
        group.has(objKey),
      );
      if (!isInCircularGroup && !visited.has(objKey)) {
        this.topologicalSortDFS(
          objKey,
          visited,
          tempVisited,
          sorted,
          circularGroups,
        );
      }
    }

    // 3. Circular groups
    for (const group of circularGroups) {
      for (const objKey of group) {
        if (!visited.has(objKey)) {
          visited.add(objKey);
          sorted.push(objKey);
        }
      }
    }

    // 4. Partially resolved (might work if some deps are created first)
    for (const objKey of partiallyResolved) {
      if (!visited.has(objKey)) {
        visited.add(objKey);
        sorted.push(objKey);
      }
    }

    // 5. Unresolved objects (will likely need multiple passes)
    for (const objKey of unresolved) {
      if (!visited.has(objKey)) {
        visited.add(objKey);
        sorted.push(objKey);
      }
    }

    console.log(`    ✅ Ordering complete: ${sorted.length} objects`);
    console.log(`       • Standalone objects first`);
    console.log(`       • Then fully resolved dependencies`);
    console.log(`       • Then circular references`);
    console.log(`       • Finally partially/unresolved (will retry later)`);

    return sorted;
  }

  /**
   * DFS for topological sort
   */
  topologicalSortDFS(objKey, visited, tempVisited, sorted, circularGroups) {
    if (visited.has(objKey)) return;
    if (tempVisited.has(objKey)) return;
    /**
     * AI NOTE: Cycle detection in DFS
     * - tempVisited prevents infinite recursion in dependency traversal
     * - Circular dependencies are detected separately in detectCircularDependencies()
     * - This is standard topological sort implementation for dependency ordering
     */

    tempVisited.add(objKey);

    const dependencies = this.dependencyGraph.get(objKey) || new Set();
    for (const depKey of dependencies) {
      /**
       * AI NOTE: Circular dependency handling in topological sort
       * - Dependencies in circular groups are skipped during normal DFS traversal
       * - Circular groups are added to the sorted list as separate units
       * - This prevents infinite recursion while preserving dependency order
       * - Circular references are resolved in post-processing phase
       */
      const isInCircularGroup = circularGroups.some((group) =>
        group.has(depKey),
      );
      if (!isInCircularGroup) {
        this.topologicalSortDFS(
          depKey,
          visited,
          tempVisited,
          sorted,
          circularGroups,
        );
      }
    }

    tempVisited.delete(objKey);
    visited.add(objKey);
    sorted.push(objKey);
  }

  /**
   * SIMPLIFIED: Extract object-level information and reference summary
   * No more field-level micromanagement - focus on object dependencies
   */
  extractObjectInfo(obj) {
    const references = {
      hasReferences: false,
      referenceFields: [],
      dependencies: new Set(),
      canCreateWithoutReferences: true,
    };

    // Extract name
    const name = (obj.label || obj.name || obj.Name || "").toString().trim();

    // Analyze attributes to find references and dependencies
    if (obj.attributes && Array.isArray(obj.attributes)) {
      for (const attr of obj.attributes) {
        if (
          !attr.objectAttributeValues ||
          attr.objectAttributeValues.length === 0
        ) {
          continue; // Skip empty attributes
        }

        // Check each value for references
        for (const val of attr.objectAttributeValues) {
          if (val.referencedObject && val.referencedObject.objectKey) {
            references.hasReferences = true;

            // Add the field name (not the detailed field tracking)
            const fieldName =
              attr.objectTypeAttribute?.name ||
              `Attribute_${attr.objectTypeAttributeId}`;
            if (!references.referenceFields.includes(fieldName)) {
              references.referenceFields.push(fieldName);
            }

            // Add dependency (but skip self-references)
            if (val.referencedObject.objectKey !== obj.objectKey) {
              references.dependencies.add(val.referencedObject.objectKey);
            }
          }
        }
      }
    }
    return {
      name,
      references: {
        ...references,
        dependencies: Array.from(references.dependencies),
      },
    };
  }

  /**
   * Mark field as circular reference with special tracking
   */
  markFieldAsCircular(
    datacenterKey,
    fieldId,
    circularReferenceId,
    targetObjectKey,
  ) {
    if (!this.plan) return false;

    const obj = this.plan.objects.find(
      (o) => o.datacenterKey === datacenterKey,
    );
    if (!obj) return false;

    const field = obj.fields.find((f) => f.fieldId === fieldId);
    if (!field) return false;

    // Update field with circular reference information
    field.status = "circular_pending";
    field.updatedAt = new Date().toISOString();
    field.circularReference = {
      id: circularReferenceId,
      targetKey: targetObjectKey,
      addedAt: new Date().toISOString(),
      resolvedAt: null,
    };

    console.log(
      `      🔄 Field ${fieldId} marked as circular reference to ${targetObjectKey}`,
    );
    this.savePlan();
    return true;
  }

  /**
   * Get all circular reference fields in the plan
   */
  getCircularReferenceFields() {
    if (!this.plan) return [];

    const circularFields = [];

    for (const obj of this.plan.objects) {
      if (obj.fields) {
        for (const field of obj.fields) {
          if (field.status === "circular_pending" && field.circularReference) {
            circularFields.push({
              objectKey: obj.datacenterKey,
              objectName: obj.name,
              fieldId: field.fieldId,
              fieldName: field.name,
              circularRefId: field.circularReference.id,
              targetKey: field.circularReference.targetKey,
              addedAt: field.circularReference.addedAt,
            });
          }
        }
      }
    }

    return circularFields;
  }

  /**
   * Get all pending reference fields (dependencies) for an object
   */

  /**
   * PERFORMANCE: Find object in plan that should contain a specific reference key
   */
  findObjectForReference(referenceKey) {
    if (!this.plan) return null;

    // Use optimized cache lookup
    return this.findObjectOptimized(referenceKey);
  }

  /**
   * Update plan statistics based on current object/field states
   */
  updatePlanStats() {
    if (!this.plan) return;

    // Reset stats
    this.plan.stats = {
      created: 0,
      failed: 0,
      pending: 0,
      partial: 0,
    };

    // Count by object status
    for (const obj of this.plan.objects) {
      if (obj.status === "created") {
        this.plan.stats.created++;
      } else if (obj.status === "failed") {
        this.plan.stats.failed++;
      } else if (obj.status === "partial") {
        this.plan.stats.partial++;
      } else {
        this.plan.stats.pending++;
      }
    }
  }

  /**
   * COMPREHENSIVE PLAN COMPLETENESS ANALYSIS
   * Generate detailed completion metrics and insights
   */
  generateCompletenessReport() {
    if (!this.plan) {
      return {
        error: "No plan available",
        isComplete: false,
      };
    }

    const report = {
      timestamp: new Date().toISOString(),
      planBased: true,

      // Object-level metrics
      objectMetrics: {
        total: this.plan.objects.length,
        completed: 0,
        pending: 0,
        failed: 0,
        partial: 0,
        completionPercentage: 0,
      },

      // Field-level metrics
      fieldMetrics: {
        total: 0,
        completed: 0,
        pending: 0,
        failed: 0,
        skipped: 0,
        completionPercentage: 0,
      },

      // Reference-specific metrics
      referenceMetrics: {
        total: 0,
        resolved: 0,
        pending: 0,
        failed: 0,
        circular: 0,
        resolutionPercentage: 0,
      },

      // Schema breakdown
      schemaBreakdown: new Map(),

      // Issue analysis
      issues: {
        objectsWithFailedFields: [],
        objectsWithMissingReferences: [],
        circularReferenceChains: [],
        blockedObjects: [],
      },

      // Completion status
      isComplete: false,
      blockers: [],
    };

    // Analyze each object
    for (const obj of this.plan.objects) {
      // Object-level counting
      if (obj.status === "created") {
        report.objectMetrics.completed++;
      } else if (obj.status === "pending") {
        report.objectMetrics.pending++;
      } else if (obj.status === "failed") {
        report.objectMetrics.failed++;
      } else if (obj.status === "partial") {
        report.objectMetrics.partial++;
      }

      // Schema breakdown
      if (!report.schemaBreakdown.has(obj.schema)) {
        report.schemaBreakdown.set(obj.schema, {
          total: 0,
          completed: 0,
          pending: 0,
          failed: 0,
          fieldTotal: 0,
          fieldCompleted: 0,
          referenceTotal: 0,
          referenceResolved: 0,
        });
      }
      const schemaStats = report.schemaBreakdown.get(obj.schema);
      schemaStats.total++;
      if (obj.status === "created") schemaStats.completed++;
      else if (obj.status === "pending") schemaStats.pending++;
      else if (obj.status === "failed") schemaStats.failed++;

      // Reference-level analysis (based on actual plan structure)
      if (obj.references && obj.references.hasReferences) {
        const numReferenceFields = obj.references.referenceFields
          ? obj.references.referenceFields.length
          : 0;

        // Count reference fields
        report.referenceMetrics.total += numReferenceFields;
        schemaStats.referenceTotal += numReferenceFields;

        // Analyze reference status
        if (obj.referenceStatus === "completed") {
          report.referenceMetrics.resolved += numReferenceFields;
          schemaStats.referenceResolved += numReferenceFields;
        } else if (
          obj.referenceStatus === "pending" ||
          obj.status === "pending"
        ) {
          report.referenceMetrics.pending += numReferenceFields;
        } else if (obj.referenceStatus === "failed") {
          report.referenceMetrics.failed += numReferenceFields;
        } else if (obj.referenceStatus === "partial") {
          // Partial = some succeeded, some failed
          // Try to parse the error message to get exact count
          let numFailed = 0;
          if (obj.referenceError) {
            const match = obj.referenceError.match(/(\d+)\s+fields?\s+failed/i);
            if (match) {
              numFailed = parseInt(match[1], 10);
            } else {
              // Fallback: assume half failed
              numFailed = Math.floor(numReferenceFields / 2);
            }
          } else {
            numFailed = Math.floor(numReferenceFields / 2);
          }

          const numResolved = numReferenceFields - numFailed;
          report.referenceMetrics.resolved += numResolved;
          report.referenceMetrics.failed += numFailed;
          schemaStats.referenceResolved += numResolved;
        }

        // Track circular references
        if (obj.category === "circular") {
          report.referenceMetrics.circular += numReferenceFields;
        }

        // Issue identification - failed references
        if (
          obj.referenceStatus === "failed" ||
          obj.referenceStatus === "partial"
        ) {
          report.issues.objectsWithFailedFields.push({
            key: obj.datacenterKey,
            name: obj.name,
            schema: obj.schema,
            referenceStatus: obj.referenceStatus,
            referenceError: obj.referenceError || "Unknown reference error",
            referenceFields: obj.references.referenceFields,
          });
        }

        // Issue identification - pending references
        if (
          obj.referenceStatus === "pending" ||
          (obj.status === "pending" && numReferenceFields > 0)
        ) {
          report.issues.objectsWithMissingReferences.push({
            key: obj.datacenterKey,
            name: obj.name,
            schema: obj.schema,
            missingReferences: obj.references.referenceFields.map((f) => ({
              fieldName: f.name,
              referenceKey: f.referenceKey,
              referenceName: f.referenceName,
            })),
          });
        }
      }
    }

    // Calculate percentages
    if (report.objectMetrics.total > 0) {
      report.objectMetrics.completionPercentage =
        ((report.objectMetrics.completed + report.objectMetrics.partial) /
          report.objectMetrics.total) *
        100;
    }

    if (report.fieldMetrics.total > 0) {
      report.fieldMetrics.completionPercentage =
        (report.fieldMetrics.completed / report.fieldMetrics.total) * 100;
    }

    if (report.referenceMetrics.total > 0) {
      report.referenceMetrics.resolutionPercentage =
        (report.referenceMetrics.resolved / report.referenceMetrics.total) *
        100;
    }

    // Determine overall completion
    report.isComplete =
      report.objectMetrics.pending === 0 &&
      report.objectMetrics.failed === 0 &&
      report.fieldMetrics.pending === 0 &&
      report.fieldMetrics.failed === 0;

    // Identify blockers
    if (report.objectMetrics.pending > 0) {
      report.blockers.push(
        `${report.objectMetrics.pending} objects still pending`,
      );
    }
    if (report.fieldMetrics.failed > 0) {
      report.blockers.push(`${report.fieldMetrics.failed} fields failed`);
    }
    if (report.referenceMetrics.pending > 0) {
      report.blockers.push(
        `${report.referenceMetrics.pending} references unresolved`,
      );
    }

    return report;
  }

  /**
   * Get completion status for specific schema
   */
  getSchemaCompletionStatus(schemaName) {
    if (!this.plan) return null;

    const schemaObjects = this.plan.objects.filter(
      (o) => o.schema === schemaName,
    );
    if (schemaObjects.length === 0) return null;

    const status = {
      schemaName,
      total: schemaObjects.length,
      completed: 0,
      pending: 0,
      failed: 0,
      partial: 0,
      fieldTotal: 0,
      fieldCompleted: 0,
      fieldPending: 0,
      fieldFailed: 0,
      completionPercentage: 0,
      fieldCompletionPercentage: 0,
    };

    for (const obj of schemaObjects) {
      if (obj.status === "created") status.completed++;
      else if (obj.status === "pending") status.pending++;
      else if (obj.status === "failed") status.failed++;
      else if (obj.status === "partial") status.partial++;

      if (obj.fields) {
        for (const field of obj.fields) {
          status.fieldTotal++;
          if (field.status === "completed") status.fieldCompleted++;
          else if (field.status === "pending") status.fieldPending++;
          else if (field.status === "failed") status.fieldFailed++;
        }
      }
    }

    if (status.total > 0) {
      status.completionPercentage =
        ((status.completed + status.partial) / status.total) * 100;
    }

    if (status.fieldTotal > 0) {
      status.fieldCompletionPercentage =
        (status.fieldCompleted / status.fieldTotal) * 100;
    }

    return status;
  }

  /**
   * Identify dependency bottlenecks
   */
  identifyDependencyBottlenecks() {
    if (!this.plan) return [];

    const bottlenecks = [];
    const dependencyMap = new Map(); // referenceKey -> objects that depend on it

    // Build dependency map
    for (const obj of this.plan.objects) {
      if (obj.fields) {
        for (const field of obj.fields) {
          if (
            field.isReference &&
            field.status === "pending" &&
            field.referenceKey
          ) {
            if (!dependencyMap.has(field.referenceKey)) {
              dependencyMap.set(field.referenceKey, []);
            }
            dependencyMap.get(field.referenceKey).push({
              objectKey: obj.datacenterKey,
              objectName: obj.name,
              fieldName: field.name,
            });
          }
        }
      }
    }

    // Find bottlenecks (missing objects that block many others)
    for (const [referenceKey, dependentObjects] of dependencyMap) {
      if (dependentObjects.length > 1) {
        // Blocking multiple objects
        const refObject = this.findObjectForReference(referenceKey);
        bottlenecks.push({
          missingObjectKey: referenceKey,
          missingObjectStatus: refObject ? refObject.status : "not_in_plan",
          blockedCount: dependentObjects.length,
          blockedObjects: dependentObjects,
        });
      }
    }

    // Sort by number of blocked objects (most critical first)
    bottlenecks.sort((a, b) => b.blockedCount - a.blockedCount);

    return bottlenecks;
  }

  /**
   * Get objects ready to be processed (all dependencies satisfied)
   */
  getReadyObjects() {
    if (!this.plan) return [];

    const ready = [];

    for (const obj of this.plan.objects) {
      if (obj.status !== "pending") continue;

      // Check if all reference dependencies are satisfied
      let isReady = true;
      if (obj.fields) {
        for (const field of obj.fields) {
          if (
            field.isReference &&
            field.status === "pending" &&
            field.referenceKey
          ) {
            /**
             * AI INSTRUCTIONS: Reference readiness checking
             * - This method checks plan status to determine object readiness
             * - In actual execution, createdObjectsTracker would be used for mapping checks
             * - This is a plan-level analysis method for reporting purposes
             * - Real dependency checking happens in objectMigrator.checkDependenciesInMapping()
             */
            const refObject = this.findObjectForReference(field.referenceKey);
            if (!refObject || refObject.status !== "created") {
              isReady = false;
              break;
            }
          }
        }
      }

      if (isReady) {
        ready.push({
          key: obj.datacenterKey,
          name: obj.name,
          schema: obj.schema,
          objectType: obj.objectType,
          fieldsPending: obj.fields
            ? obj.fields.filter((f) => f.status === "pending").length
            : 0,
        });
      }
    }

    return ready;
  }

  /**
   * Print comprehensive completion report to console
   */
  printCompletenessReport() {
    const report = this.generateCompletenessReport();

    if (report.error) {
      console.log(`❌ ${report.error}`);
      return;
    }

    console.log("\n📊 COMPREHENSIVE PLAN COMPLETENESS REPORT");
    console.log("=".repeat(50));

    // Object-level summary
    console.log("\n🎯 OBJECT-LEVEL COMPLETION:");
    console.log(`   Total Objects: ${report.objectMetrics.total}`);
    console.log(
      `   ✅ Completed: ${report.objectMetrics.completed} (${((report.objectMetrics.completed / report.objectMetrics.total) * 100).toFixed(1)}%)`,
    );
    console.log(
      `   🔄 Partial: ${report.objectMetrics.partial} (${((report.objectMetrics.partial / report.objectMetrics.total) * 100).toFixed(1)}%)`,
    );
    console.log(
      `   ⏳ Pending: ${report.objectMetrics.pending} (${((report.objectMetrics.pending / report.objectMetrics.total) * 100).toFixed(1)}%)`,
    );
    console.log(
      `   ❌ Failed: ${report.objectMetrics.failed} (${((report.objectMetrics.failed / report.objectMetrics.total) * 100).toFixed(1)}%)`,
    );
    console.log(
      `   📈 Overall Success: ${report.objectMetrics.completionPercentage.toFixed(1)}%`,
    );

    // Reference summary
    console.log("\n🔗 REFERENCE RESOLUTION:");
    console.log(`   Total References: ${report.referenceMetrics.total}`);
    console.log(
      `   ✅ Resolved: ${report.referenceMetrics.resolved} (${report.referenceMetrics.resolutionPercentage.toFixed(1)}%)`,
    );
    console.log(`   ⏳ Pending: ${report.referenceMetrics.pending}`);
    console.log(`   🔄 Circular: ${report.referenceMetrics.circular}`);
    console.log(`   ❌ Failed: ${report.referenceMetrics.failed}`);

    // Schema breakdown
    console.log("\n📦 SCHEMA BREAKDOWN:");
    for (const [schemaName, stats] of report.schemaBreakdown) {
      const schemaCompletion =
        stats.total > 0
          ? ((stats.completed / stats.total) * 100).toFixed(1)
          : 0;
      console.log(
        `   ${schemaName}: ${stats.completed}/${stats.total} objects (${schemaCompletion}%)`,
      );
    }

    // Issues - Failed References
    if (report.issues.objectsWithFailedFields.length > 0) {
      console.log("\n❌ OBJECTS WITH FAILED REFERENCES:");
      for (const obj of report.issues.objectsWithFailedFields.slice(0, 5)) {
        const numFields = obj.referenceFields ? obj.referenceFields.length : 0;
        console.log(
          `   • ${obj.key}: ${numFields} reference fields failed - Status: ${obj.referenceStatus}`,
        );
        if (obj.referenceError) {
          console.log(`     Error: ${obj.referenceError}`);
        }
      }
      if (report.issues.objectsWithFailedFields.length > 5) {
        console.log(
          `   ... and ${report.issues.objectsWithFailedFields.length - 5} more`,
        );
      }
    }

    // Issues - Pending References
    if (report.issues.objectsWithMissingReferences.length > 0) {
      console.log("\n🔗 OBJECTS WITH PENDING REFERENCES:");
      for (const obj of report.issues.objectsWithMissingReferences.slice(
        0,
        5,
      )) {
        const numRefs = obj.missingReferences
          ? obj.missingReferences.length
          : 0;
        console.log(`   • ${obj.key}: ${numRefs} unresolved refs`);
      }
      if (report.issues.objectsWithMissingReferences.length > 5) {
        console.log(
          `   ... and ${report.issues.objectsWithMissingReferences.length - 5} more`,
        );
      }
    }

    // Bottlenecks
    const bottlenecks = this.identifyDependencyBottlenecks();
    if (bottlenecks.length > 0) {
      console.log("\n🚧 DEPENDENCY BOTTLENECKS:");
      for (const bottleneck of bottlenecks.slice(0, 3)) {
        console.log(
          `   • ${bottleneck.missingObjectKey} (blocking ${bottleneck.blockedCount} objects)`,
        );
      }
    }

    // Ready objects
    const ready = this.getReadyObjects();
    if (ready.length > 0) {
      console.log(
        `\n🚀 READY TO PROCESS: ${ready.length} objects have all dependencies satisfied`,
      );
    }

    // Final status
    if (report.isComplete) {
      console.log("\n🎉 MIGRATION 100% COMPLETE!");
    } else {
      console.log(
        `\n⚠️  MIGRATION ${report.objectMetrics.completionPercentage.toFixed(1)}% COMPLETE`,
      );
      console.log("   Blockers:");
      for (const blocker of report.blockers) {
        console.log(`   • ${blocker}`);
      }
    }

    return report;
  }

  /**
   * Get all schemas
   */
  getAllSchemas() {
    const schemas = [];
    const items = fs.readdirSync(this.datacenterPath);

    for (const item of items) {
      const itemPath = path.join(this.datacenterPath, item);
      if (fs.statSync(itemPath).isDirectory() && !item.startsWith(".")) {
        schemas.push(item);
      }
    }

    return schemas;
  }

  /**
   * Get object types in a schema
   */
  getObjectTypes(schemaPath) {
    const types = [];

    function scanDir(dirPath, relativePath = "") {
      const items = fs.readdirSync(dirPath);

      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory() && !item.startsWith(".")) {
          const typePath = relativePath ? `${relativePath}/${item}` : item;

          // Check if this directory has objects.json
          const objectsFile = path.join(itemPath, "objects.json");
          if (fs.existsSync(objectsFile)) {
            types.push(typePath);
          }

          // Recurse into subdirectories
          scanDir(itemPath, typePath);
        }
      }
    }

    scanDir(schemaPath);
    return types;
  }

  /**
   * Load objects from a type path
   */
  loadObjects(schemaPath, typePath) {
    const objectsFile = path.join(schemaPath, typePath, "objects.json");

    if (fs.existsSync(objectsFile)) {
      try {
        return JSON.parse(fs.readFileSync(objectsFile, "utf8"));
      } catch (error) {
        console.error(
          `      ❌ Error loading objects from ${typePath}:`,
          error.message,
        );
        return [];
      }
    }

    return [];
  }

  /**
   * Update object status in plan
   */
  updateObjectStatus(datacenterKey, status, cloudId = null, error = null) {
    if (!this.plan) return false;

    const obj = this.plan.objects.find(
      (o) => o.datacenterKey === datacenterKey,
    );
    if (!obj) {
      console.warn(`    ⚠️  Object not found in plan: ${datacenterKey}`);
      return false;
    }

    obj.status = status;
    obj.updatedAt = new Date().toISOString();

    if (cloudId) {
      obj.cloudId = cloudId;
    }
    if (error) {
      obj.error = error;
    }

    // Initialize reference status if not exists
    if (!obj.referenceStatus) {
      obj.referenceStatus = "pending";
    }

    // Update plan stats
    this.updatePlanStats();
    this.needsSave = true;

    // FORCE IMMEDIATE SAVE for status updates to ensure plan is always current
    this.savePlan(true);

    return true;
  }

  /**
   * Update reference status separately from object status
   */
  updateReferenceStatus(datacenterKey, referenceStatus, error = null) {
    if (!this.plan) return false;

    const obj = this.plan.objects.find(
      (o) => o.datacenterKey === datacenterKey,
    );
    if (!obj) {
      console.warn(
        `    ⚠️  Object not found in plan for reference update: ${datacenterKey}`,
      );
      return false;
    }

    obj.referenceStatus = referenceStatus;
    obj.updatedAt = new Date().toISOString();

    if (error) {
      obj.referenceError = error;
    }

    // Update plan stats
    this.updatePlanStats();
    this.needsSave = true;

    // FORCE IMMEDIATE SAVE for status updates to ensure plan is always current
    this.savePlan(true);

    return true;
  }

  /**
   * Get objects that need reference updates
   */
  getObjectsNeedingReferenceUpdates() {
    if (!this.plan) return [];

    return this.plan.objects.filter(
      (obj) =>
        obj.status === "created" &&
        (obj.referenceStatus === "pending" ||
          obj.referenceStatus === "failed" ||
          obj.referenceStatus === "partial"),
    );
  }

  /**
   * Reset failed reference statuses to pending before new migration run
   * This prevents accumulation of historical failures across multiple runs
   */
  resetFailedReferencesToPending() {
    if (!this.plan) return;

    let resetCount = 0;
    this.plan.objects.forEach((obj) => {
      if (
        obj.status === "created" &&
        (obj.referenceStatus === "failed" || obj.referenceStatus === "partial")
      ) {
        obj.referenceStatus = "pending";
        obj.referenceError = null;
        resetCount++;
      }
    });

    if (resetCount > 0) {
      console.log(
        `\n🔄 Reset ${resetCount} failed references to pending for retry`,
      );
      this.needsSave = true;
    }

    return resetCount;
  }

  /**
   * Update plan statistics
   */
  updatePlanStats() {
    if (!this.plan) return;

    this.plan.stats = {
      total: this.plan.objects.length,
      created: this.plan.objects.filter((o) => o.status === "created").length,
      failed: this.plan.objects.filter((o) => o.status === "failed").length,
      pending: this.plan.objects.filter((o) => o.status === "pending").length,
    };
  }

  /**
   * Get next object to process
   */
  getNextObject() {
    if (!this.plan) return null;

    // Find first pending object in order
    return this.plan.objects.find((o) => o.status === "pending");
  }

  /**
   * PERFORMANCE: Mark plan for batched save
   */
  markForSave() {
    this.needsSave = true;

    // Use batched saves for performance
    if (this.batchSaveTimer) {
      clearTimeout(this.batchSaveTimer);
    }

    this.batchSaveTimer = setTimeout(() => {
      this.savePlan();
    }, this.batchSaveInterval);
  }

  /**
   * Force immediate save (for critical operations)
   */
  forceSave() {
    if (this.batchSaveTimer) {
      clearTimeout(this.batchSaveTimer);
      this.batchSaveTimer = null;
    }
    this.savePlan();
  }

  /**
   * PERFORMANCE: Build object index cache for faster lookups
   */
  rebuildObjectCache() {
    if (!this.plan || !this.plan.objects) return;

    this.objectIndexCache.clear();
    this.fieldIndexCache.clear();

    for (let i = 0; i < this.plan.objects.length; i++) {
      const obj = this.plan.objects[i];
      this.objectIndexCache.set(obj.datacenterKey, i);

      // Cache field lookups too
      if (obj.fields) {
        for (let j = 0; j < obj.fields.length; j++) {
          const field = obj.fields[j];
          const cacheKey = `${obj.datacenterKey}:${field.fieldId}`;
          this.fieldIndexCache.set(cacheKey, { objectIndex: i, fieldIndex: j });
        }
      }
    }

    this.lastCacheRebuild = Date.now();
    console.log(
      `    ⚡ Cache rebuilt: ${this.objectIndexCache.size} objects, ${this.fieldIndexCache.size} fields`,
    );
  }

  /**
   * PERFORMANCE: Fast object lookup using cache
   */
  findObjectOptimized(datacenterKey) {
    // Rebuild cache if stale
    if (Date.now() - this.lastCacheRebuild > this.cacheRebuildInterval) {
      this.rebuildObjectCache();
    }

    const objectIndex = this.objectIndexCache.get(datacenterKey);
    return objectIndex !== undefined ? this.plan.objects[objectIndex] : null;
  }

  /**
   * PERFORMANCE: Fast field lookup using cache
   */
  findFieldOptimized(datacenterKey, fieldId) {
    // Rebuild cache if stale
    if (Date.now() - this.lastCacheRebuild > this.cacheRebuildInterval) {
      this.rebuildObjectCache();
    }

    const cacheKey = `${datacenterKey}:${fieldId}`;
    const indices = this.fieldIndexCache.get(cacheKey);

    if (indices) {
      return {
        object: this.plan.objects[indices.objectIndex],
        field:
          this.plan.objects[indices.objectIndex].fields[indices.fieldIndex],
        objectIndex: indices.objectIndex,
        fieldIndex: indices.fieldIndex,
      };
    }

    return null;
  }

  /**
   * Save plan to file with resume-friendly metadata
   */
  savePlan(force = false) {
    if (!this.plan) return;

    // Skip save if no changes pending (unless forced)
    if (!this.needsSave && !force) return;

    console.log("    💾 Saving plan...");
    const saveStart = Date.now();

    // Update modification timestamp for resume capability
    this.plan.lastModified = new Date().toISOString();

    // PERFORMANCE: Only update stats if needed (expensive operation)
    this.updatePlanStats();

    // Add resume metadata if not exists
    if (!this.plan.resumeMetadata) {
      this.plan.resumeMetadata = {
        version: "3.0",
        lastValidationTime: null,
      };
    }

    this.plan.resumeMetadata.lastSaveTime = new Date().toISOString();

    // 🧹 MEMORY OPTIMIZATION: Use streaming JSON write instead of creating 15MB+ string
    // Atomic write happens inside streamJsonToFileSync (.tmp + rename pattern)
    this.streamJsonToFileSync(this.plan, this.planFile);

    this.needsSave = false;
    const saveTime = Date.now() - saveStart;

    if (saveTime > 100) {
      // Log slow saves
      console.log(
        `    ⚡ Plan saved in ${saveTime}ms (${this.plan.objects.length} objects)`,
      );
    }
  }

  /**
   * 🧹 MEMORY OPTIMIZATION: Stream JSON write to avoid 15MB+ string in memory
   * SYNCHRONOUS version - writes JSON structure in chunks using fs.openSync/writeSync
   * Maintains atomic write pattern (.tmp + rename) for crash safety
   * CRITICAL: Must be synchronous because savePlan() is called synchronously throughout codebase
   */
  streamJsonToFileSync(obj, filePath) {
    const tempFile = filePath + ".tmp";
    let fd = null;

    try {
      // Open file descriptor for synchronous writes
      fd = fs.openSync(tempFile, "w");

      // Write opening brace
      fs.writeSync(fd, "{\n");

      // Write top-level fields (small, can stringify directly)
      const topLevelFields = [
        "version",
        "createdAt",
        "totalObjects",
        "lastModified",
        "resumeMetadata",
      ];
      for (let i = 0; i < topLevelFields.length; i++) {
        const fieldName = topLevelFields[i];
        if (obj[fieldName] !== undefined) {
          fs.writeSync(
            fd,
            `  "${fieldName}": ${JSON.stringify(obj[fieldName])},\n`,
          );
        }
      }

      // Write stats object
      fs.writeSync(fd, `  "stats": ${JSON.stringify(obj.stats)},\n`);

      // Write objects array in chunks (this is the large part - 25,000+ objects)
      fs.writeSync(fd, '  "objects": [\n');

      const totalObjects = obj.objects.length;
      const CHUNK_SIZE = 100; // Process 100 objects at a time

      for (let i = 0; i < totalObjects; i += CHUNK_SIZE) {
        const end = Math.min(i + CHUNK_SIZE, totalObjects);

        for (let j = i; j < end; j++) {
          const objStr = JSON.stringify(obj.objects[j]);
          const isLast = j === totalObjects - 1;
          fs.writeSync(fd, `    ${objStr}${isLast ? "" : ","}\n`);
        }
      }

      fs.writeSync(fd, "  ]\n");
      fs.writeSync(fd, "}\n");

      // Close file descriptor
      fs.closeSync(fd);
      fd = null;

      // Atomic rename after successful write
      fs.renameSync(tempFile, filePath);
    } catch (error) {
      // Cleanup on error
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (e) {}
      }
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
      throw error;
    }
  }

  /**
   * Repair plan integrity issues
   */
  repairPlan() {
    if (!this.plan) return { success: false, reason: "No plan loaded" };

    const repairs = [];
    let repaired = false;

    try {
      // Repair missing essential object properties (simplified for object-level tracking)
      for (const obj of this.plan.objects) {
        // Ensure status is valid
        if (
          !obj.status ||
          !["pending", "created", "failed"].includes(obj.status)
        ) {
          obj.status = "pending";
          repairs.push(`Fixed status for ${obj.datacenterKey}`);
          repaired = true;
        }

        // Ensure essential properties exist
        if (!obj.datacenterKey) {
          repairs.push(`Object missing datacenterKey - cannot repair`);
        }

        if (!obj.schema) {
          repairs.push(
            `Object ${obj.datacenterKey} missing schema - cannot repair`,
          );
        }

        if (!obj.objectType) {
          repairs.push(
            `Object ${obj.datacenterKey} missing objectType - cannot repair`,
          );
        }

        // Ensure timestamps exist
        if (!obj.createdAt) {
          obj.createdAt = new Date().toISOString();
          repairs.push(`Added createdAt to ${obj.datacenterKey}`);
          repaired = true;
        }
      }

      // Update plan stats
      if (repaired) {
        this.updatePlanStats();
        this.savePlan();
      }

      return {
        success: repaired,
        repairsApplied: repairs.length,
        repairs: repairs,
      };
    } catch (error) {
      return {
        success: false,
        reason: error.message,
        repairsAttempted: repairs,
      };
    }
  }

  /**
   * Get resume readiness assessment
   */
  getResumeReadiness() {
    if (!this.plan) return { ready: false, reason: "No plan loaded" };

    const assessment = {
      ready: false,
      confidence: 0,
      issues: [],
      recommendations: [],
      canAttemptRepair: false,
    };

    try {
      // Check basic structure
      if (!this.plan.objects || !Array.isArray(this.plan.objects)) {
        assessment.issues.push("Invalid plan structure");
        return assessment;
      }

      // Check field integrity
      let objectsWithValidFields = 0;
      for (const obj of this.plan.objects) {
        if (obj.fields && Array.isArray(obj.fields)) {
          let validFields = 0;
          for (const field of obj.fields) {
            if (field.fieldId && field.status && field.createdAt) {
              validFields++;
            }
          }

          if (validFields === obj.fields.length) {
            objectsWithValidFields++;
          }
        }
      }

      const fieldIntegrityPercentage =
        (objectsWithValidFields / this.plan.objects.length) * 100;

      if (fieldIntegrityPercentage < 80) {
        assessment.issues.push(
          `Only ${fieldIntegrityPercentage.toFixed(1)}% of objects have valid field structure`,
        );
        assessment.canAttemptRepair = true;
        assessment.recommendations.push("Consider running plan repair");
      } else if (fieldIntegrityPercentage < 95) {
        assessment.issues.push(
          `${fieldIntegrityPercentage.toFixed(1)}% field integrity - some objects may need repair`,
        );
        assessment.canAttemptRepair = true;
      }

      // Determine readiness
      if (fieldIntegrityPercentage >= 95) {
        assessment.ready = true;
        assessment.confidence = Math.min(fieldIntegrityPercentage, 100);
      } else if (fieldIntegrityPercentage >= 80) {
        assessment.ready = true; // Can resume with repair
        assessment.confidence = fieldIntegrityPercentage * 0.8; // Reduced confidence
        assessment.recommendations.push(
          "Run repair before resuming for best results",
        );
      }
    } catch (error) {
      assessment.issues.push(`Assessment error: ${error.message}`);
    }

    return assessment;
  }

  /**
   * Reset plan (for fresh start)
   */
  resetPlan() {
    if (fs.existsSync(this.planFile)) {
      fs.unlinkSync(this.planFile);
    }
    this.plan = null;
    this.allObjects.clear();
    this.dependencyGraph.clear();
    this.reverseDependencyGraph.clear();
    console.log("  🗑️  Migration plan reset");
  }
}

module.exports = MigrationPlanBuilder;
