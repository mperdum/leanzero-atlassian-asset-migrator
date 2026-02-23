/**
 * Configuration Check Script for Attachment Upload Utility
 *
 * This script verifies that your environment configuration is correct
 * for uploading attachments to Jira Cloud Assets.
 *
 * Run this before upload_attachments_to_existing_objects.js to diagnose
 * configuration issues.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// Load environment variables
require("dotenv").config({ path: path.join(__dirname, "../../../.env") });

console.log("=".repeat(70));
console.log("ATTACHMENT UPLOAD - CONFIGURATION CHECK");
console.log("=".repeat(70));

// Configuration object
const config = {
  workspaceId: process.env.WORKSPACE_ID,
  apiToken: process.env.CLOUD_API_TOKEN,
  baseUrl: process.env.CLOUD_BASE_URL,
  datacenterPath: process.env.DATACENTER_PATH,
};

// Results tracking
const results = {
  passed: [],
  failed: [],
  warnings: [],
};

/**
 * Helper function to log test results
 */
function logResult(testName, passed, message, details = "") {
  const icon = passed ? "✅" : "❌";
  console.log(`\n${icon} ${testName}`);
  console.log(`   ${message}`);
  if (details) {
    console.log(`   Details: ${details}`);
  }

  if (passed) {
    results.passed.push(testName);
  } else {
    results.failed.push(testName);
  }
}

/**
 * Helper function to log warnings
 */
function logWarning(testName, message) {
  const icon = "⚠️";
  console.log(`\n${icon} ${testName}`);
  console.log(`   ${message}`);
  results.warnings.push(testName);
}

/**
 * Test 1: Check if .env file exists
 */
function testEnvFileExists() {
  const envPath = path.join(__dirname, "../../../.env");
  const exists = fs.existsSync(envPath);

  logResult(
    ".env file exists",
    exists,
    exists ? "Found .env file at expected location" : "Missing .env file",
    envPath
  );

  return exists;
}

/**
 * Test 2: Check WORKSPACE_ID
 */
function testWorkspaceId() {
  const wsId = config.workspaceId;

  if (!wsId) {
    logResult("WORKSPACE_ID is set", false, "WORKSPACE_ID is not set in .env file");
    return false;
  }

  // Check if it's a valid UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isValidFormat = uuidRegex.test(wsId);

  if (isValidFormat) {
    logResult("WORKSPACE_ID format", true, "Valid UUID format", wsId);
    return true;
  } else {
    logResult(
      "WORKSPACE_ID format",
      false,
      "Invalid format - should be a UUID (e.g., a1b2c3d4-e5f6-7890-abcd-ef1234567890)",
      `Current value: ${wsId}`
    );
    return false;
  }
}

/**
 * Test 3: Check CLOUD_API_TOKEN
 */
function testApiToken() {
  const token = config.apiToken;

  if (!token) {
    logResult("CLOUD_API_TOKEN is set", false, "CLOUD_API_TOKEN is not set in .env file");
    return false;
  }

  // Check if it's base64 encoded (shouldn't contain special chars except +/ and padding)
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  const isValidFormat = base64Regex.test(token);

  if (isValidFormat) {
    logResult("CLOUD_API_TOKEN format", true, "Appears to be base64 encoded", `${token.substring(0, 20)}...`);
    return true;
  } else {
    logWarning(
      "CLOUD_API_TOKEN format",
      "Token doesn't appear to be base64 encoded. It should be base64(email:apiToken)"
    );
    return true; // Still pass the test, just warn
  }
}

/**
 * Test 4: Check CLOUD_BASE_URL
 */
function testBaseUrl() {
  const url = config.baseUrl;

  if (!url) {
    logResult("CLOUD_BASE_URL is set", false, "CLOUD_BASE_URL is not set in .env file");
    return false;
  }

  // Check if it's in the expected format (domain.atlassian.net)
  const isValidFormat = url.includes(".atlassian.net") || url.includes(".jira.com");

  if (isValidFormat) {
    logResult("CLOUD_BASE_URL format", true, "Valid Jira Cloud domain", url);
    return true;
  } else {
    logWarning(
      "CLOUD_BASE_URL format",
      "Doesn't appear to be a standard Jira Cloud URL. Should be like 'your-domain.atlassian.net'"
    );
    return true; // Still pass, just warn
  }
}

/**
 * Test 5: Check DATACENTER_PATH
 */
function testDatacenterPath() {
  const dcPath = config.datacenterPath || path.join(__dirname, "../../../datacenter_assets");
  const exists = fs.existsSync(dcPath);

  logResult(
    "DATACENTER_PATH is accessible",
    exists,
    exists ? "Datacenter assets directory exists" : "Datacenter assets directory not found",
    dcPath
  );

  return exists;
}

/**
 * Test 6: Check if created_objects_mapping.json exists
 */
function testMappingFileExists() {
  const mappingPath = path.join(__dirname, "../../../asset-migration-script/logs/created_objects_mapping.json");
  const exists = fs.existsSync(mappingPath);

  logResult(
    "Created objects mapping file exists",
    exists,
    exists ? "Mapping file from migration found" : "Mapping file not found - run migration first",
    exists ? mappingPath : "Expected: asset-migration-script/logs/created_objects_mapping.json"
  );

  return exists;
}

/**
 * Test 7: Verify workspace is accessible
 */
async function testWorkspaceAccess() {
  const wsId = config.workspaceId;
  const token = config.apiToken;

  console.log("\n🔍 Testing workspace access...");
  console.log(`   Checking if workspace ${wsId} is accessible...`);

  const url = `https://api.atlassian.com/jsm/assets/workspace/${wsId}/v1/objectschema/list`;

  return new Promise((resolve) => {
    const options = {
      method: "GET",
      headers: {
        Authorization: `Basic ${token}`,
        Accept: "application/json",
      },
    };

    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            const schemaCount = result.values?.length || 0;
            logResult(
              "Workspace is accessible",
              true,
              `Successfully connected to workspace`,
              `Found ${schemaCount} object schemas`
            );
            resolve(true);
          } catch (e) {
            logWarning("Workspace is accessible", "Connected but couldn't parse response");
            resolve(true);
          }
        } else if (res.statusCode === 401) {
          logResult(
            "Workspace is accessible",
            false,
            "Authentication failed - check your API token",
            `Status: ${res.statusCode} - ${res.statusMessage}`
          );
          resolve(false);
        } else if (res.statusCode === 404) {
          logResult(
            "Workspace is accessible",
            false,
            "Workspace not found - check your WORKSPACE_ID",
            `Status: ${res.statusCode} - ${res.statusMessage}`
          );
          resolve(false);
        } else {
          logWarning(
            "Workspace is accessible",
            `Unexpected status code: ${res.statusCode}`
          );
          resolve(false);
        }
      });
    });

    req.on("error", (error) => {
      logResult(
        "Workspace is accessible",
        false,
        "Network error or connection failed",
        error.message
      );
      resolve(false);
    });

    req.end();
  });
}

/**
 * Test 8: Check if attachment endpoint is accessible
 */
async function testAttachmentEndpoint() {
  const wsId = config.workspaceId;
  const token = config.apiToken;

  console.log("\n🔍 Testing attachment credentials endpoint...");
  console.log("   Checking if the attachment upload endpoint is available...");

  // Use a common object ID format to test the endpoint
  const testObjectId = "1";
  const url = `https://api.atlassian.com/jsm/assets/workspace/${wsId}/v1/attachments/object/${testObjectId}/credentials`;

  return new Promise((resolve) => {
    const options = {
      method: "GET",
      headers: {
        Authorization: `Basic ${token}`,
        Accept: "application/json",
      },
    };

    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          logResult(
            "Attachment endpoint is accessible",
            true,
            "Attachment upload credentials endpoint is available"
          );
          resolve(true);
        } else if (res.statusCode === 401) {
          logResult(
            "Attachment endpoint is accessible",
            false,
            "Authentication failed - API token may not have attachment permissions"
          );
          resolve(false);
        } else if (res.statusCode === 404) {
          logWarning(
            "Attachment endpoint is accessible",
            "Endpoint returned 404. This may mean:\n" +
            "  - The endpoint is not available for your workspace\n" +
            "  - Attachments feature is not enabled\n" +
            "  - Atlassian has changed/deprecated the endpoint"
          );
          resolve(false);
        } else {
          logWarning(
            "Attachment endpoint is accessible",
            `Unexpected status code: ${res.statusCode}`
          );
          resolve(false);
        }
      });
    });

    req.on("error", (error) => {
      logResult(
        "Attachment endpoint is accessible",
        false,
        "Network error or connection failed",
        error.message
      );
      resolve(false);
    });

    req.end();
  });
}

/**
 * Main execution
 */
async function runChecks() {
  console.log("\n📋 Running configuration checks...\n");

  // Run synchronous checks
  testEnvFileExists();
  testWorkspaceId();
  testApiToken();
  testBaseUrl();
  testDatacenterPath();
  testMappingFileExists();

  // Run async checks
  if (config.workspaceId && config.apiToken) {
    await testWorkspaceAccess();
    await testAttachmentEndpoint();
  } else {
    console.log("\n⚠️  Skipping connectivity tests - missing required credentials");
  }

  // Print summary
  console.log("\n" + "=".repeat(70));
  console.log("CHECK SUMMARY");
  console.log("=".repeat(70));
  console.log(`✅ Passed: ${results.passed.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);
  console.log(`⚠️  Warnings: ${results.warnings.length}`);

  if (results.failed.length > 0) {
    console.log("\n📝 Failed tests:");
    results.failed.forEach(test => console.log(`   - ${test}`));
  }

  if (results.warnings.length > 0) {
    console.log("\n⚠️  Warnings:");
    results.warnings.forEach(test => console.log(`   - ${test}`));
  }

  console.log("\n" + "=".repeat(70));

  if (results.failed.length === 0) {
    console.log("✅ All critical checks passed!");
    console.log("\nYou can proceed with uploading attachments using:");
    console.log("  node upload_attachments_to_existing_objects.js");
  } else {
    console.log("❌ Some checks failed. Please fix the issues above before proceeding.");
    console.log("\nCommon fixes:");
    console.log("1. WORKSPACE_ID: Should be a UUID from your Assets URL");
    console.log("2. CLOUD_API_TOKEN: Should be base64-encoded (email:apiToken)");
    console.log("3. CLOUD_BASE_URL: Should be your Jira Cloud domain");
    console.log("4. Run migration first to create the mapping file");
  }

  console.log("=".repeat(70));

  // Exit with appropriate code
  process.exit(results.failed.length > 0 ? 1 : 0);
}

// Run the checks
runChecks().catch(error => {
  console.error("\n❌ Unexpected error:", error);
  process.exit(1);
});
