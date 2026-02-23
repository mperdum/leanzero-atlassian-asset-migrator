#!/usr/bin/env node

/**
 * Enhanced Asset Migration Script - Main Entry Point
 *
 * This script coordinates the migration of assets from Jira Datacenter to Jira Cloud.
 * It ensures 100% migration success with no skipped objects, errors, or warnings.
 *
 * Version: 2.0 - Refactored for better modularity and maintainability
 */

// Try to load .env file, but don't fail if it doesn't exist
try {
  require("dotenv").config();
} catch (error) {
  console.log("ℹ️  No .env file found, using environment variables directly");
}

// Import built-in modules
const path = require("path");

// Import configuration manager first
const ConfigurationManager = require("./modules/configurationManager");
const configManager = new ConfigurationManager();

// Check for help flag before loading other modules
if (configManager.isHelpRequested()) {
  configManager.showHelp();
  process.exit(0);
}

// Validate API token
if (!configManager.validateApiToken()) {
  process.exit(1);
}

// Get configuration
const config = configManager.getConfig();

// Import required modules for main orchestration
const CloudApiClient = require("./modules/cloudApiClient");
const DependencyResolver = require("./modules/dependencyResolver");
const TicketConnector = require("./modules/ticketConnector");
const AttachmentUploader = require("./modules/attachmentUploader");
const SchemaMapper = require("./modules/schemaMapper");
const SimpleLogger = require("./modules/simpleLogger");
const MigrationOrchestrator = require("./modules/migrationOrchestrator");

// Note: Additional modules exist (AttributeMapper, ObjectMigrator, MigrationPlanBuilder, etc.)
// but are loaded dynamically by the orchestrator as needed

// Initialize simple text logger FIRST
const simpleLogger = new SimpleLogger();
simpleLogger.initialize();

// Initialize core modules
const datacenterPath =
  process.env.DATACENTER_PATH ||
  path.join(process.cwd(), "..", "datacenter_assets");

// Remove https:// prefix if present since CloudApiClient expects just the domain
const baseUrl = config.baseUrl.replace(/^https?:\/\//, "");
const apiClient = new CloudApiClient(
  config.workspaceId,
  config.apiToken,
  baseUrl,
);

const dependencyResolver = new DependencyResolver(datacenterPath);
const schemaMapper = new SchemaMapper();

const ticketConnector = new TicketConnector(apiClient, {
  enabled: config.connectTicketsToObjects,
  maxRetries: config.maxRetries,
  retryDelay: config.retryDelay,
});

const attachmentUploader = new AttachmentUploader(apiClient, {
  enabled: config.uploadAttachments,
  maxRetries: config.maxRetries,
  retryDelay: config.retryDelay,
});

// Bundle core modules for the orchestrator
// The orchestrator will load additional modules (AttributeMapper, ObjectMigrator, etc.) as needed
const modules = {
  configManager,
  apiClient,
  dependencyResolver,
  ticketConnector,
  attachmentUploader,
  schemaMapper,
};

// Handle circular reference cleanup if requested
if (config.cleanCircularRefs) {
  const CircularReferenceTracker = require("./modules/circularReferenceTracker");
  const tracker = new CircularReferenceTracker();

  console.log("🔄 Circular Reference Cleanup Mode");
  const result = tracker.cleanupReferences({
    removeFailed: true,
    removeResolved: config.removeResolved, // Simple - remove resolved if flag is set
  });

  console.log(`\n✅ Cleanup complete!`);
  if (!config.removeResolved && result.stats.resolved > 0) {
    console.log(
      `   💡 Use --clean-circular-refs --remove-resolved to also remove ${result.stats.resolved} resolved references`,
    );
  }

  simpleLogger.close();
  process.exit(0);
}

// Create and run the migration orchestrator
const orchestrator = new MigrationOrchestrator(config, modules);

// CRITICAL: Setup exit handlers to save mapping on CTRL-C or crashes
// This prevents data loss when script is interrupted
let isExiting = false;

function gracefulShutdown(signal) {
  if (isExiting) return;
  isExiting = true;

  console.log(`\n\n⚠️  Received ${signal} - saving state before exit...`);

  try {
    // Force save mapping and plan
    if (
      orchestrator.objectMigrator &&
      orchestrator.objectMigrator.createdObjectsTracker
    ) {
      orchestrator.objectMigrator.createdObjectsTracker.forceSave();
      console.log("✅ Mapping saved");
    }
    if (
      orchestrator.objectMigrator &&
      orchestrator.objectMigrator.planBuilder
    ) {
      orchestrator.objectMigrator.planBuilder.forceSave();
      console.log("✅ Plan saved");
    }
  } catch (error) {
    console.error("❌ Error saving state:", error.message);
  }

  simpleLogger.close();
  process.exit(signal === "SIGINT" ? 0 : 1);
}

// Register exit handlers
process.on("SIGINT", () => gracefulShutdown("SIGINT")); // CTRL-C
process.on("SIGTERM", () => gracefulShutdown("SIGTERM")); // kill command
process.on("uncaughtException", (error) => {
  console.error("\n❌ UNCAUGHT EXCEPTION:", error);
  console.error(error.stack);
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});

// Run migration
orchestrator
  .migrate()
  .then(() => {
    simpleLogger.close();
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ FATAL ERROR:", error);
    console.error(error.stack);
    simpleLogger.close();
    process.exit(1);
  });
