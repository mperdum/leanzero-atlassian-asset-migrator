/**
 * Pure Plan-Driven Migration Orchestrator
 *
 * Orchestrates the entire migration process using the plan-driven approach.
 * Pure plan-driven migration orchestrator with comprehensive field-level tracking.
 *
 * AI INSTRUCTIONS:
 * - This orchestrator coordinates ONLY plan-driven migration (all legacy methods removed)
 * - Uses plan-based reporting instead of cloud queries for performance
 * - Integrates with utility features (cleanup, analysis) when requested
 * - Maintains clean separation between plan execution and utility operations
 * Everything is driven by the migration plan and created_objects_mapping.json.
 */

const fs = require("fs");
const path = require("path");

class MigrationOrchestrator {
  constructor(config, modules) {
    this.config = config;
    this.modules = modules;
    this.datacenterPath =
      process.env.DATACENTER_PATH ||
      path.join(process.cwd(), "..", "datacenter_assets");

    // Initialize the plan-driven object migrator
    const ObjectMigrator = require("./objectMigrator");
    this.objectMigrator = new ObjectMigrator(this.config, this.modules);

    // Initialize migration plan builder
    const MigrationPlanBuilder = require("./migrationPlanBuilder");
    this.planBuilder = new MigrationPlanBuilder(this.datacenterPath);

    // Connect planBuilder to objectMigrator
    this.objectMigrator.planBuilder = this.planBuilder;
  }

  /**
   * Main migration entry point for pure plan-driven architecture
   *
   * @returns {Object} - Migration completion statistics from plan analysis
   *
   * AI INSTRUCTIONS:
   * - Single entry point for complete plan-driven migration process
   * - Coordinates: utilities → cloud config → plan execution → reporting
   * - Uses objectMigrator.migrateFromPlan() for core migration logic
   * - Generates comprehensive completion reports from plan data (no cloud queries)
   * - Returns detailed migration statistics for external consumption
   * - Handles utility operations (cleanup, analysis) when requested
   * - ALL legacy migration methods have been removed - this is the only migration path
   */
  async migrate() {
    console.log("\n🎯 PURE PLAN-DRIVEN MIGRATION SYSTEM");
    console.log("=====================================");
    console.log("• Plan dictates all actions");
    console.log("• Field-level status tracking");
    console.log("• NO duplicate checks");
    console.log("• NO cloud queries");
    console.log("• created_objects_mapping.json is truth");
    console.log("• 100% deterministic execution");
    console.log("");

    // Run utilities if requested
    await this.runUtilities();

    // Test connection
    if (!(await this.modules.apiClient.testConnection())) {
      console.error("❌ Cannot connect to Jira Cloud. Exiting.");
      process.exit(1);
    }

    // Load cloud configuration (needed for object type mapping)
    await this.loadCloudConfiguration();

    // Execute pure plan-driven migration
    console.log("🚀 Starting pure plan-driven migration...\n");
    await this.objectMigrator.migrateFromPlan(
      this.config.schemaFilter,
      this.config.typeFilter,
    );

    // Report final stats using comprehensive plan-based analysis
    console.log("\n📊 GENERATING FINAL COMPLETION REPORT...");
    const migrationStats =
      this.objectMigrator.planBuilder.generateCompletenessReport();
    this.objectMigrator.planBuilder.printCompletenessReport();

    // Save detailed report to file
    const reportPath = "./logs/final_completeness_report.json";
    require("fs").writeFileSync(
      reportPath,
      JSON.stringify(migrationStats, null, 2),
    );
    console.log(`   💾 Detailed report saved to ${reportPath}`);

    console.log("\n✅ Migration orchestration complete");
    return migrationStats;
  }
  // REMOVED: generatePlanBasedReport() and printFinalSummary() (150+ lines of redundant code)
  // These are now handled by the comprehensive plan completeness tracking in MigrationPlanBuilder

  /**
   * Execute utility features when requested via configuration flags
   *
   * @returns {Promise} - Completes when utilities finish
   *
   * AI INSTRUCTIONS:
   * - Runs datacenter analysis (--analyze-dc) and cleanup (--cleanup-objects) when requested
   * - Utilities run BEFORE migration to prepare environment
   * - Datacenter analysis compares schemas/types between datacenter and cloud
   * - Cleanup utility safely removes objects while preserving schema structure
   * - These are optional preparatory steps, not part of core migration logic
   */
  async runUtilities() {
    // Run datacenter analysis
    if (this.config.runDatacenterAnalysis) {
      await this.runDatacenterAnalysis();
    }

    // Run cleanup
    if (this.config.runCleanupObjects) {
      await this.runCleanup();
    }
  }

  /**
   * Run datacenter vs cloud configuration analysis
   *
   * @returns {Promise} - Completes when analysis finishes
   *
   * AI INSTRUCTIONS:
   * - Compares datacenter schemas/types/attributes with cloud configuration
   * - Identifies missing schemas, object types, and attributes that need creation
   * - Provides actionable GUI instructions for cloud configuration setup
   * - Optional utility - helps prepare cloud environment before migration
   * - Exits process if only running analysis (no migration follows)
   */
  async runDatacenterAnalysis() {
    console.log("🔍 Running Datacenter vs Cloud Analysis...\n");
    try {
      const DatacenterVsCloudAnalyzer = require("./datacenterVsCloudAnalysis");
      const analyzer = new DatacenterVsCloudAnalyzer();
      await analyzer.run();
      console.log(
        "\n✅ Analysis complete. Review the GUI action tasks above before proceeding with migration.\n",
      );

      if (!this.config.runCleanupObjects && !this.config.generateReports) {
        // Only running analysis, exit
        process.exit(0);
      }
    } catch (error) {
      console.error("❌ Failed to run datacenter analysis:", error.message);
      if (!this.config.runCleanupObjects && !this.config.generateReports) {
        process.exit(1);
      }
    }
  }

  /**
   * Execute object cleanup utility using standalone cleanup script
   *
   * @returns {Promise} - Completes when cleanup finishes
   *
   * AI INSTRUCTIONS:
   * - Spawns standalone cleanup_objects.js script as child process
   * - Safely deletes all cloud objects while preserving schema structure
   * - Supports dry-run mode and schema filtering
   * - Uses fork() to run cleanup in separate process with proper error handling
   * - Critical for preparing clean environment before migration
   */
  async runCleanup() {
    console.log("🧹 Running Object Cleanup...\n");
    try {
      const cleanupPath = path.join(
        __dirname,
        "../../standalone-utilities/cleanup_objects.js",
      );
      const { fork } = require("child_process");

      const cleanupArgs = [];
      if (this.config.isDryRun) {
        cleanupArgs.push("--dry-run");
      } else {
        cleanupArgs.push("--confirm");
      }
      if (this.config.schemaFilter) {
        cleanupArgs.push("--schema", this.config.schemaFilter);
      }

      const cleanupProcess = fork(cleanupPath, cleanupArgs, {
        env: process.env,
        silent: false,
      });

      await new Promise((resolve, reject) => {
        cleanupProcess.on("exit", (code) => {
          if (code === 0) {
            console.log("\n✅ Cleanup completed successfully\n");
            resolve();
          } else {
            reject(new Error(`Cleanup process exited with code ${code}`));
          }
        });
      });

      console.log(
        "🎯 Cleanup utilities completed. Proceeding with migration...\n",
      );
    } catch (error) {
      console.error("❌ Failed to run cleanup:", error.message);
      process.exit(1);
    }
  }

  /**
   * Load cloud schemas and object types for plan-driven migration
   *
   * @returns {Promise} - Completes when cloud configuration is loaded and cached
   *
   * AI INSTRUCTIONS:
   * - Fetches all cloud schemas and object types via cloudApiClient
   * - Builds Maps for fast lookup during plan execution
   * - Configures schemaMapper with cloud configuration for datacenter→cloud mapping
   * - Caches configuration to logs/cloud_configuration.json for reference
   * - Critical for plan execution - must complete before migration starts
   * - Only cloud queries allowed in plan-driven approach (for configuration, not existence checking)
   */
  async loadCloudConfiguration() {
    console.log("📡 Loading cloud configuration...");

    try {
      const schemas = await this.modules.apiClient.getSchemas();
      console.log(`  ✅ Found ${schemas.length} cloud schemas`);

      const cloudSchemas = new Map();
      const cloudObjectTypes = new Map();

      for (const schema of schemas) {
        cloudSchemas.set(schema.name, schema);

        // 🔥 FIX: Fetch schema-level status types for Type 7 Status fields
        console.log(
          `    🔧 GET https://api.atlassian.com/jsm/assets/workspace/${this.modules.apiClient.workspaceId}/v1/config/statustype?objectSchemaId=${schema.id}`,
        );
        let schemaStatusMap = new Map();
        try {
          const statusEndpoint = `/jsm/assets/workspace/${this.modules.apiClient.workspaceId}/v1/config/statustype?objectSchemaId=${schema.id}`;
          const statusTypes = await this.modules.apiClient.makeRequest(
            "GET",
            statusEndpoint,
          );

          // Build status ID -> status name mapping for this schema
          if (statusTypes && Array.isArray(statusTypes)) {
            for (const status of statusTypes) {
              schemaStatusMap.set(String(status.id), status.name);
            }
            console.log(
              `        ✅ Loaded ${statusTypes.length} status types for schema ${schema.name}`,
            );

            // Store schema status map in cloudApiClient for automatic application
            this.modules.apiClient.setSchemaStatusMap(
              schema.id,
              schemaStatusMap,
            );
          }
        } catch (statusError) {
          console.warn(
            `        ⚠️  Failed to fetch status types for schema ${schema.name}: ${statusError.message}`,
          );
        }

        const objectTypes = await this.modules.apiClient.getObjectTypes(
          schema.id,
        );
        const typeMap = new Map();

        for (const type of objectTypes) {
          // Store object type to schema mapping for status field resolution
          this.modules.apiClient.setObjectTypeSchema(type.id, schema.id);

          // Fetch attributes for each object type to get select field options
          console.log(
            `    🔧 GET https://api.atlassian.com/jsm/assets/workspace/${this.modules.apiClient.workspaceId}/v1/objecttype/${type.id}/attributes`,
          );
          try {
            const attributes =
              await this.modules.apiClient.getObjectTypeAttributes(type.id);

            // Process attributes to populate options for select fields
            for (const attr of attributes) {
              // Type 7 = Status fields - use schema-level status mapping
              if (
                attr.type === 7 &&
                attr.typeValueMulti &&
                attr.typeValueMulti.length > 0
              ) {
                const statusNames = attr.typeValueMulti
                  .map((id) => schemaStatusMap.get(String(id)))
                  .filter((name) => name); // Remove undefined values

                if (statusNames.length > 0) {
                  attr.options = statusNames.join(",");
                  console.log(
                    `        ✅ Mapped ${statusNames.length} status options for ${attr.name}: ${attr.options}`,
                  );
                } else {
                  console.warn(
                    `        ⚠️  No status mappings found for ${attr.name} (IDs: ${attr.typeValueMulti.join(", ")})`,
                  );
                }
              }
              // Type 0 = Regular select fields - options are already populated in the response
              // No additional processing needed for Type 0 fields
            }

            type.attributes = attributes; // Add attributes to type object
          } catch (attrError) {
            console.warn(
              `    ⚠️  Failed to fetch attributes for type ${type.name}: ${attrError.message}`,
            );
            type.attributes = []; // Set empty array to prevent crashes
          }

          typeMap.set(type.name, type);
        }

        cloudObjectTypes.set(schema.id, typeMap);
        console.log(
          `    📦 ${schema.name}: ${objectTypes.length} object types`,
        );
      }

      // Pass cloud schemas to SchemaMapper
      this.modules.schemaMapper.setCloudSchemas(cloudSchemas);
      this.modules.schemaMapper.setCloudObjectTypes(cloudObjectTypes);

      // Save configuration for reference
      const configFile = "./logs/cloud_configuration.json";
      const config = {
        schemas: Array.from(cloudSchemas.entries()),
        objectTypes: Array.from(cloudObjectTypes.entries()).map(
          ([schemaId, types]) => ({
            schemaId,
            types: Array.from(types.entries()),
          }),
        ),
      };
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      console.log(`  💾 Configuration saved to ${configFile}\n`);
    } catch (error) {
      console.error("❌ Failed to load cloud configuration:", error.message);
      process.exit(1);
    }
  }
}

module.exports = MigrationOrchestrator;
