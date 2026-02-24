/**
 * Test script to debug the attachment endpoint issue
 *
 * This script tests the attachment upload credentials endpoint directly
 * to help diagnose why uploads are failing with "TCS 404" errors.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../../.env") });

// Load configuration
const workspaceId = process.env.WORKSPACE_ID;
const apiToken = process.env.CLOUD_API_TOKEN;
const baseUrl = process.env.CLOUD_BASE_URL;

console.log("=".repeat(70));
console.log("ATTACHMENT ENDPOINT DEBUG TEST");
console.log("=".repeat(70));
console.log(`Workspace ID: ${workspaceId}`);
console.log(`Base URL: ${baseUrl}`);
console.log(`API Token: ${apiToken ? "SET" : "NOT SET"}`);
console.log("=".repeat(70));

if (!workspaceId) {
  console.error("❌ ERROR: WORKSPACE_ID is not set in .env file");
  console.log("Please check your .env file and ensure WORKSPACE_ID is set to a valid UUID");
  process.exit(1);
}

if (!apiToken) {
  console.error("❌ ERROR: CLOUD_API_TOKEN is not set in .env file");
  console.log("Please check your .env file and ensure CLOUD_API_TOKEN is set");
  process.exit(1);
}

// Test object IDs - replace with actual object IDs from your migration
const testObjectIds = process.env.TEST_OBJECT_IDS
  ? process.env.TEST_OBJECT_IDS.split(",")
  : ["12345", "12346"];

/**
 * Make a test API call to get upload credentials
 */
async function testCredentialsEndpoint(objectId) {
  console.log(`\n🧪 Testing object ID: ${objectId}`);
  console.log("-".repeat(70));

  const url = `https://api.atlassian.com/jsm/assets/workspace/${workspaceId}/v1/attachments/object/${objectId}/credentials`;
  console.log(`URL: ${url}`);

  return new Promise((resolve, reject) => {
    const options = {
      method: "GET",
      headers: {
        Authorization: `Basic ${apiToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };

    console.log("\nRequest Details:");
    console.log(`  Method: ${options.method}`);
    console.log(`  Authorization: Basic ${apiToken.substring(0, 20)}...`);
    console.log(`  Accept: ${options.headers.Accept}`);
    console.log(`  Content-Type: ${options.headers["Content-Type"]}`);

    const req = https.request(url, options, (res) => {
      let data = "";

      console.log("\nResponse Details:");
      console.log(`  Status Code: ${res.statusCode}`);
      console.log(`  Status Message: ${res.statusMessage}`);
      console.log(`  Headers:`, JSON.stringify(res.headers, null, 2));

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        console.log(`  Response Body: ${data}`);

        if (res.statusCode === 200) {
          try {
            const credentials = JSON.parse(data);
            console.log("\n✅ SUCCESS - Credentials retrieved:");
            console.log(`  Client ID: ${credentials.clientId}`);
            console.log(`  Media Base URL: ${credentials.mediaBaseUrl}`);
            console.log(`  JWT Token: ${credentials.mediaJwtToken ? "Present" : "Missing"}`);
            resolve(credentials);
          } catch (error) {
            console.log("\n❌ ERROR - Failed to parse response:");
            console.log(`  Error: ${error.message}`);
            reject(error);
          }
        } else {
          console.log("\n❌ ERROR - Non-200 status code");

          // Analyze the error
          if (res.statusCode === 404) {
            console.log("\n🔍 404 Error Analysis:");
            console.log("  Possible causes:");
            console.log("    1. Invalid workspace ID - check your WORKSPACE_ID in .env");
            console.log("    2. Workspace doesn't exist or was deleted");
            console.log("    3. Object ID doesn't exist in this workspace");
            console.log("    4. API endpoint has changed or been deprecated");
            console.log("    5. Insufficient permissions to access attachments endpoint");

            // Try to parse the response for more details
            try {
              const errorData = JSON.parse(data);
              console.log(`  Error details:`, errorData);
              if (errorData.errorMessage) {
                console.log(`  Error message: ${errorData.errorMessage}`);
                if (errorData.errorMessage.includes("TCS")) {
                  console.log("\n  ⚠️  'TCS 404' suggests this may be a service-level error");
                  console.log("     TCS likely refers to Atlassian's internal service architecture");
                }
              }
            } catch (e) {
              console.log(`  Raw response: ${data}`);
            }
          } else if (res.statusCode === 401) {
            console.log("\n🔍 401 Error - Authentication failed");
            console.log("  Possible causes:");
            console.log("    1. Invalid API token");
            console.log("    2. Token has expired");
            console.log("    3. Token doesn't have required permissions");
          } else if (res.statusCode === 403) {
            console.log("\n🔍 403 Error - Forbidden");
            console.log("  Possible causes:");
            console.log("    1. Insufficient permissions");
            console.log("    2. User doesn't have access to this workspace");
            console.log("    3. Attachments feature not enabled for this workspace");
          }

          reject(new Error(`HTTP ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on("error", (error) => {
      console.log("\n❌ ERROR - Request failed:");
      console.log(`  Error: ${error.message}`);
      reject(error);
    });

    req.end();
  });
}

/**
 * Test if the object exists by fetching it directly
 */
async function testObjectExists(objectId) {
  console.log(`\n🔍 Verifying object ${objectId} exists...`);

  const url = `https://api.atlassian.com/jsm/assets/workspace/${workspaceId}/v1/object/${objectId}`;
  console.log(`URL: ${url}`);

  return new Promise((resolve) => {
    const options = {
      method: "GET",
      headers: {
        Authorization: `Basic ${apiToken}`,
        Accept: "application/json",
      },
    };

    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        console.log(`  Status: ${res.statusCode}`);
        if (res.statusCode === 200) {
          try {
            const obj = JSON.parse(data);
            console.log(`  ✅ Object exists: ${obj.objectKey || obj.name || objectId}`);
            resolve(true);
          } catch (e) {
            console.log(`  ⚠️  Object exists but couldn't parse response`);
            resolve(true);
          }
        } else {
          console.log(`  ❌ Object not found or inaccessible`);
          resolve(false);
        }
      });
    });

    req.on("error", () => {
      console.log(`  ❌ Request failed`);
      resolve(false);
    });

    req.end();
  });
}

/**
 * Test workspace access by listing schemas
 */
async function testWorkspaceAccess() {
  console.log(`\n🔍 Testing workspace access...`);

  const url = `https://api.atlassian.com/jsm/assets/workspace/${workspaceId}/v1/objectschema/list`;
  console.log(`URL: ${url}`);

  return new Promise((resolve) => {
    const options = {
      method: "GET",
      headers: {
        Authorization: `Basic ${apiToken}`,
        Accept: "application/json",
      },
    };

    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        console.log(`  Status: ${res.statusCode}`);
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            console.log(`  ✅ Workspace accessible - found ${result.values?.length || 0} schemas`);
            resolve(true);
          } catch (e) {
            console.log(`  ⚠️  Workspace accessible but couldn't parse response`);
            resolve(true);
          }
        } else if (res.statusCode === 404) {
          console.log(`  ❌ Workspace not found - check WORKSPACE_ID`);
          resolve(false);
        } else {
          console.log(`  ❌ Workspace inaccessible (status ${res.statusCode})`);
          resolve(false);
        }
      });
    });

    req.on("error", () => {
      console.log(`  ❌ Request failed`);
      resolve(false);
    });

    req.end();
  });
}

/**
 * Main test execution
 */
async function runTests() {
  try {
    // Test 1: Can we access the workspace at all?
    const workspaceAccessible = await testWorkspaceAccess();

    if (!workspaceAccessible) {
      console.log("\n" + "=".repeat(70));
      console.log("CONCLUSION: Workspace access failed");
      console.log("=".repeat(70));
      console.log("\n🔧 Recommended Actions:");
      console.log("1. Verify WORKSPACE_ID in your .env file");
      console.log("2. Check that the workspace exists in your Jira Cloud instance");
      console.log("3. Ensure WORKSPACE_ID matches the workspace from CLOUD_BASE_URL");
      console.log("4. Try extracting the workspace ID from your Assets URL in the browser");
      return;
    }

    // Test 2: Check if the objects exist
    for (const objectId of testObjectIds) {
      await testObjectExists(objectId);
    }

    // Test 3: Try to get upload credentials
    console.log("\n" + "=".repeat(70));
    console.log("TESTING ATTACHMENT CREDENTIALS ENDPOINT");
    console.log("=".repeat(70));

    for (const objectId of testObjectIds) {
      try {
        await testCredentialsEndpoint(objectId);
      } catch (error) {
        console.log(`\n❌ Test failed for object ${objectId}`);
        console.log(`Error: ${error.message}`);
      }
    }

    console.log("\n" + "=".repeat(70));
    console.log("TEST SUMMARY");
    console.log("=".repeat(70));
    console.log("\nIf all credential requests failed with 404:");
    console.log("  → The attachment endpoint may be unavailable for this workspace");
    console.log("  → Atlassian may have changed/deprecated the endpoint");
    console.log("  → Your workspace may not have the attachments feature enabled");
    console.log("\nIf workspace access worked but objects don't exist:");
    console.log("  → Check the created_objects_mapping.json for correct object IDs");
    console.log("  → The objects may have been deleted from Cloud");
    console.log("\nIf authentication failed (401/403):");
    console.log("  → Verify your API token is correct and not expired");
    console.log("  → Ensure the token has Assets permissions");
    console.log("  → Check that attachments are enabled for your workspace");

  } catch (error) {
    console.error("\n❌ Unexpected error:", error.message);
  }
}

// Run the tests
runTests();
