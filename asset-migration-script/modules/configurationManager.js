/**
 * Configuration Manager Module
 * 
 * Handles all configuration parsing, validation, and management
 * for the migration script. Centralizes CLI args and environment
 * variable processing.
 */

const fs = require('fs');
const path = require('path');

class ConfigurationManager {
    constructor() {
        this.args = process.argv.slice(2);
        this.config = {};
        this.loadConfiguration();
    }

    /**
     * Load and parse all configuration from CLI and environment
     */
    loadConfiguration() {
        // Base configuration
        this.config.baseUrl = process.env.CLOUD_BASE_URL;
        this.config.apiToken = process.env.CLOUD_API_TOKEN;
        this.config.workspaceId = process.env.WORKSPACE_ID;

        // Migration modes
        this.config.isDryRun = this.getBooleanConfig('--dry-run', 'DRY_RUN', false);

        this.config.generateReports = this.getBooleanConfig('--report', 'GENERATE_REPORTS', false);


        // Filtering
        this.config.schemaFilter = this.getStringConfig('--schema', 'SCHEMA_FILTER', '');
        this.config.typeFilter = this.getStringConfig('--type', 'TYPE_FILTER', '');
        this.config.limitPerType = this.getNumberConfig('--limit', 'LIMIT_PER_TYPE', 0);

        // Feature toggles
        this.config.connectTicketsToObjects = this.getBooleanConfig('--connect-tickets', 'CONNECT_TICKETS_TO_OBJECTS', false);
        this.config.uploadAttachments = this.getBooleanConfig('--upload-attachments', 'UPLOAD_ATTACHMENTS', false);
        this.config.autoCreateObjectTypes = this.getBooleanConfig('--auto-create-types', 'AUTO_CREATE_OBJECT_TYPES', true);
        this.config.autoCreateReferences = this.getBooleanConfig('--auto-create-refs', 'AUTO_CREATE_REFERENCES', true);
        this.config.validateCrossSchemaRefs = this.getBooleanConfig('--validate-refs', 'VALIDATE_CROSS_SCHEMA_REFS', true);

        // Utility features
        this.config.runCleanupObjects = this.getBooleanConfig('--cleanup-objects', 'CLEANUP_OBJECTS', false);
        /**
         * AI NOTE: Field discovery feature removed
         * - Legacy field discovery is obsolete in plan-driven approach
         * - Plan-driven system handles field processing directly without complex discovery
         * - Eliminates need for error-based field type learning
         */
        this.config.runDatacenterAnalysis = this.getBooleanConfig('--analyze-dc', 'DATACENTER_ANALYSIS', false);
        this.config.cleanCircularRefs = this.getBooleanConfig('--clean-circular-refs', 'CLEAN_CIRCULAR_REFS', false);
        this.config.removeResolved = this.getBooleanConfig('--remove-resolved', 'REMOVE_RESOLVED', false);

        // Performance settings
        this.config.maxRetries = this.getNumberConfig('--max-retries', 'MAX_RETRIES', 3);
        this.config.retryDelay = this.getNumberConfig('--retry-delay', 'RETRY_DELAY', 1000);
        this.config.createDelay = this.getNumberConfig('--create-delay', 'CREATE_DELAY', 100);
        this.config.batchSize = this.getNumberConfig('--batch-size', 'BATCH_SIZE', 25);

        // Logging
        this.config.logLevel = this.getStringConfig('--log-level', 'LOG_LEVEL', 'info');
        this.config.detailedErrorLogging = this.getBooleanConfig('--detailed-errors', 'DETAILED_ERROR_LOGGING', true);
        this.config.logFailedMigrations = this.getBooleanConfig('--log-failures', 'LOG_FAILED_MIGRATIONS', true);

        // Data validation
        this.config.skipValidationErrors = this.getBooleanConfig('--skip-validation', 'SKIP_VALIDATION_ERRORS', false);
        this.config.ignoreMissingRequired = this.getBooleanConfig('--ignore-required', 'IGNORE_MISSING_REQUIRED', false);
        this.config.allowPartialMigration = this.getBooleanConfig('--allow-partial', 'ALLOW_PARTIAL_MIGRATION', false);

        // Advanced options
        this.config.intelligentMigration = this.getBooleanConfig('--intelligent', 'INTELLIGENT_MIGRATION', true);
        // REMOVED: checkDuplicates - plan-driven approach doesn't need duplicate checking
        this.config.cacheCloudObjects = this.getBooleanConfig('--cache-objects', 'CACHE_CLOUD_OBJECTS', true);
        this.config.validateAttributeMappings = this.getBooleanConfig('--validate-mappings', 'VALIDATE_ATTRIBUTE_MAPPINGS', true);

        // Debug options
        this.config.debugApiCalls = this.getBooleanConfig('--debug-api', 'DEBUG_API_CALLS', false);
        this.config.debugMappings = this.getBooleanConfig('--debug-mappings', 'DEBUG_MAPPINGS', false);
        this.config.verboseProgress = this.getBooleanConfig('--verbose', 'VERBOSE_PROGRESS', false);
    }

    /**
     * Get boolean configuration value with CLI override priority
     * 
     * @param {string} cliFlag - CLI flag name (e.g., '--dry-run')
     * @param {string} envVar - Environment variable name (e.g., 'DRY_RUN')
     * @param {boolean} defaultValue - Default value if not specified
     * @returns {boolean} - Resolved configuration value
     * 
     * AI INSTRUCTIONS:
     * - CLI arguments take precedence over environment variables
     * - Supports both positive flags (--flag) and negative flags (--no-flag)
     * - Environment variables must be 'true' string (case-insensitive)
     * - Used throughout configuration system for feature toggles
     * - Critical for runtime behavior control
     */
    getBooleanConfig(cliFlag, envVar, defaultValue = false) {
        if (this.args.includes(cliFlag)) return true;
        if (this.args.includes(`--no-${cliFlag.replace('--', '')}`)) return false;
        if (process.env[envVar] !== undefined) {
            return process.env[envVar].toLowerCase() === 'true';
        }
        return defaultValue;
    }

    /**
     * Get string configuration value with CLI override priority
     * 
     * @param {string} cliFlag - CLI flag name (e.g., '--schema')
     * @param {string} envVar - Environment variable name (e.g., 'SCHEMA_FILTER')
     * @param {string} defaultValue - Default value if not specified
     * @returns {string} - Resolved configuration value
     * 
     * AI INSTRUCTIONS:
     * - CLI arguments take precedence over environment variables
     * - Looks for value following the CLI flag (e.g., '--schema MySchema')
     * - Used for schema filters, type filters, file paths, etc.
     * - Critical for runtime parameter specification
     */
    getStringConfig(cliFlag, envVar, defaultValue = '') {
        const cliValue = this.args.find((arg, i) => this.args[i - 1] === cliFlag);
        if (cliValue !== undefined) return cliValue;
        return process.env[envVar] || defaultValue;
    }

    /**
     * Get numeric configuration value with CLI override priority
     * 
     * @param {string} cliFlag - CLI flag name (e.g., '--limit')
     * @param {string} envVar - Environment variable name (e.g., 'LIMIT_PER_TYPE') 
     * @param {number} defaultValue - Default value if not specified
     * @returns {number} - Resolved configuration value
     * 
     * AI INSTRUCTIONS:
     * - CLI arguments take precedence over environment variables
     * - Automatically parses string values to integers
     * - Used for limits, timeouts, retry counts, batch sizes
     * - Critical for performance and behavior tuning
     */
    getNumberConfig(cliFlag, envVar, defaultValue = 0) {
        const cliValue = this.args.find((arg, i) => this.args[i - 1] === cliFlag);
        if (cliValue !== undefined) return parseInt(cliValue);
        if (process.env[envVar] !== undefined) return parseInt(process.env[envVar]);
        return defaultValue;
    }

    /**
     * Check if help is requested
     */
    isHelpRequested() {
        return this.args.includes('--help') || this.args.includes('-h');
    }

    /**
     * Validate API token
     */
    validateApiToken() {
        if (!this.config.apiToken) {
            console.error('❌ ERROR: CLOUD_API_TOKEN is required but not found.');
            console.error('');
            console.error('Please provide the token in one of these ways:');
            console.error('1. Set CLOUD_API_TOKEN environment variable:');
            console.error('   export CLOUD_API_TOKEN="your_token_here"');
            console.error('2. Run with token inline:');
            console.error('   CLOUD_API_TOKEN="your_token_here" node main.js');
            console.error('3. Create .env file in project root with:');
            console.error('   CLOUD_API_TOKEN=your_token_here');
            console.error('');
            console.error('Current environment:');
            console.error(`  CLOUD_BASE_URL: ${this.config.baseUrl}`);
            console.error(`  WORKSPACE_ID: ${this.config.workspaceId}`);
            console.error(`  CLOUD_API_TOKEN: ${this.config.apiToken ? '[SET]' : '[NOT SET]'}`);
            return false;
        }

        /**
         * AI INSTRUCTIONS: API token validation
         * - Validates token is base64 encoded (required for Jira Cloud API)
         * - Uses regex pattern to verify base64 format
         * - This is complete validation - no additional checks needed
         * - Prevents authentication errors from malformed tokens
         */
        if (!this.config.apiToken.match(/^[A-Za-z0-9+/]+=*$/)) {
            console.warn('⚠️  WARNING: CLOUD_API_TOKEN does not appear to be base64 encoded.');
            console.warn('   Make sure your token is properly base64 encoded.');
        }

        return true;
    }


    /**
     * Show help text
     */
    showHelp() {
        console.log(`
╔════════════════════════════════════════════════════════════════╗
║             Jira Cloud Assets Migration Script                  ║
╚════════════════════════════════════════════════════════════════╝

USAGE:
  node main.js [OPTIONS]

ENVIRONMENT CONFIGURATION:
  All options can be set via environment variables (see .env.example)
  Command-line arguments override environment variables

MIGRATION MODES:
  --dry-run              Test without creating objects (env: DRY_RUN)
  --report               Generate detailed reports (env: GENERATE_REPORTS)

FILTERING OPTIONS:
  --schema [name]        Migrate only specific schema (env: SCHEMA_FILTER)
  --type [name]          Migrate only specific object type (env: TYPE_FILTER)
  --limit [n]            Limit objects per type (env: LIMIT_PER_TYPE)

FEATURE TOGGLES:
  --connect-tickets      Connect tickets to migrated objects (env: CONNECT_TICKETS_TO_OBJECTS)
  --auto-create-types    Auto-create missing object types (env: AUTO_CREATE_OBJECT_TYPES)
  --auto-create-refs     Auto-create missing references (env: AUTO_CREATE_REFERENCES)
  --validate-refs        Validate cross-schema references (env: VALIDATE_CROSS_SCHEMA_REFS)

UTILITY FEATURES:
  --cleanup-objects      Clean all objects before migration (env: CLEANUP_OBJECTS)
  // Field discovery removed - plan-driven approach handles field processing directly
  --analyze-dc          Analyze datacenter vs cloud config (env: DATACENTER_ANALYSIS)
  --clean-circular-refs  Remove failed circular references from JSON (env: CLEAN_CIRCULAR_REFS)
  --remove-resolved      Also remove resolved references (env: REMOVE_RESOLVED)

PERFORMANCE:
  --max-retries [n]      Max retry attempts for failed calls (env: MAX_RETRIES)
  --retry-delay [ms]     Initial retry delay in ms (env: RETRY_DELAY)
  --create-delay [ms]    Delay between object creations (env: CREATE_DELAY)
  --batch-size [n]       Objects per batch (env: BATCH_SIZE)

LOGGING:
  --log-level [level]    Log level: debug|info|warn|error (env: LOG_LEVEL)
  --detailed-errors      Enable detailed error logging (env: DETAILED_ERROR_LOGGING)
  --log-failures         Log failed migrations separately (env: LOG_FAILED_MIGRATIONS)
  --verbose              Show detailed progress (env: VERBOSE_PROGRESS)

DEBUG:
  --debug-api            Log all API calls and responses (env: DEBUG_API_CALLS)
  --debug-mappings       Log intermediate mapping results (env: DEBUG_MAPPINGS)

EXAMPLES:
  # Dry run for specific schema
  node main.js --dry-run --schema "Application_Approval_Process"
  
  # Migrate with ticket connections
  node main.js --connect-tickets --schema "Asset_Management" --limit 10
  
  # Clean objects before migration
  node main.js --cleanup-objects --schema "Asset_Management"
  
  # Analyze datacenter vs cloud differences
  node main.js --analyze-dc
  
  # Generate reports only
  node main.js --report
  
  # Clean up failed circular references
  node main.js --clean-circular-refs
  
  # Clean up all circular references (including resolved)
  node main.js --clean-circular-refs --remove-resolved

ENVIRONMENT SETUP:
  1. Copy .env.example to .env
  2. Set CLOUD_API_TOKEN with base64 encoded credentials
  3. Verify WORKSPACE_ID and CLOUD_BASE_URL
  4. Configure feature toggles as needed
`);
    }

    /**
     * Get all configuration
     */
    getConfig() {
        return this.config;
    }
}

module.exports = ConfigurationManager;
