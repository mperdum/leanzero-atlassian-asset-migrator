/**
 * Test Script for Microsoft Graph User Ingestion
 *
 * This script tests:
 * 1. Microsoft Graph API authentication with provided credentials
 * 2. Fetching users with filter "userType eq 'Member'"
 * 3. Simulating user matching logic without writing to cloud
 *
 * This is a READ-ONLY test script - does not write to any cloud instance.
 */

require("dotenv").config();
const MicrosoftGraphApiClient = require("../src/microsoftGraphApiClient");

// Credentials loaded from environment variables
const TEST_CREDENTIALS = {
  clientId: process.env.MS_CLIENT_ID || "YOUR_CLIENT_ID",
  tenantId: process.env.MS_TENANT_ID || "YOUR_TENANT_ID",
  clientSecret: process.env.MS_CLIENT_SECRET || "YOUR_CLIENT_SECRET"
};

// Attributes we're mapping (from your requirement)
const ATTRIBUTE_MAPPING = {
  displayName: "Name",
  givenName: "Given name",
  surname: "Surname",
  userPrincipalName: "sAMAccountName",
  jobTitle: "Title",
  mail: "E-Mail",
  officeLocation: "Location",
  companyName: "Company",
  department: "Department",
  businessPhones: "Phone",
  mobilePhone: "Mobile",
  accountEnabled: "Status",
  id: "objectGUID",
  employeeId: "employeeID"
};

// Simulated existing users in Jira Cloud (for testing matching logic)
const SIMULATED_EXISTING_USERS = [
  {
    label: "John Smith",
    attributes: [
      { objectTypeAttribute: { name: "Name" }, objectAttributeValues: [{ value: "John Smith" }] },
      { objectTypeAttribute: { name: "E-Mail" }, objectAttributeValues: [{ value: "john.smith@example.com" }] },
      { objectTypeAttribute: { name: "sAMAccountName" }, objectAttributeValues: [{ value: "john.smith@domain.com" }] },
      { objectTypeAttribute: { name: "Title" }, objectAttributeValues: [{ value: "Software Engineer" }] },
      { objectTypeAttribute: { name: "Department" }, objectAttributeValues: [{ value: "Engineering" }] },
      { objectTypeAttribute: { name: "Location" }, objectAttributeValues: [{ value: "New York" }] },
      { objectTypeAttribute: { name: "Phone" }, objectAttributeValues: [{ value: "+1-555-0101" }] },
      { objectTypeAttribute: { name: "Mobile" }, objectAttributeValues: [{ value: "+1-555-0102" }] },
      { objectTypeAttribute: { name: "Status" }, objectAttributeValues: [{ value: "true" }] },
      { objectTypeAttribute: { name: "objectGUID" }, objectAttributeValues: [{ value: "guid-12345" }] },
      { objectTypeAttribute: { name: "employeeID" }, objectAttributeValues: [{ value: "EMP001" }] }
    ]
  },
  {
    label: "Jane Doe",
    attributes: [
      { objectTypeAttribute: { name: "Name" }, objectAttributeValues: [{ value: "Jane Doe" }] },
      { objectTypeAttribute: { name: "E-Mail" }, objectAttributeValues: [{ value: "jane.doe@example.com" }] },
      { objectTypeAttribute: { name: "sAMAccountName" }, objectAttributeValues: [{ value: "jane.doe@domain.com" }] },
      { objectTypeAttribute: { name: "Title" }, objectAttributeValues: [{ value: "Project Manager" }] },
      { objectTypeAttribute: { name: "Department" }, objectAttributeValues: [{ value: "Product" }] },
      { objectTypeAttribute: { name: "Location" }, objectAttributeValues: [{ value: "San Francisco" }] }
    ]
  }
];

class MicrosoftGraphTester {
  constructor() {
    console.log("=".repeat(80));
    console.log("Microsoft Graph User Ingestion - Credential & Logic Test");
    console.log("=".repeat(80));
    console.log();
    console.log("This script will:");
    console.log("  1. Test Microsoft Graph API authentication");
    console.log("  2. Fetch users with filter: userType eq 'Member'");
    console.log("  3. Simulate user matching logic");
    console.log("  4. Show what would happen (without writing to cloud)");
    console.log();
    console.log("⚠️  READ-ONLY TEST - No data will be written to any cloud instance");
    console.log();
  }

  async run() {
    try {
      // Step 1: Test authentication
      await this.testAuthentication();

      // Step 2: Initialize client and fetch users
      const client = new MicrosoftGraphApiClient(
        TEST_CREDENTIALS.clientId,
        TEST_CREDENTIALS.tenantId,
        TEST_CREDENTIALS.clientSecret
      );

      console.log("\n" + "=".repeat(80));
      console.log("Step 2: Fetching Users from Microsoft Graph");
      console.log("=".repeat(80));
      console.log();

      const users = await client.fetchUsers({
        filter: "userType eq 'Member'",
        select: Object.keys(ATTRIBUTE_MAPPING).join(","),
        maxResults: 10 // Limit to 10 for testing
      });

      console.log(`\n✓ Successfully fetched ${users.length} users from Microsoft Graph`);
      console.log();

      // Step 3: Display users
      this.displayUsers(users);

      // Step 4: Simulate matching logic
      console.log("\n" + "=".repeat(80));
      console.log("Step 3: Simulating User Matching Logic");
      console.log("=".repeat(80));
      console.log();
      console.log("Testing matching against simulated existing users in Jira Cloud Assets...");
      console.log();

      const matchResults = this.simulateMatching(users, SIMULATED_EXISTING_USERS);

      this.displayMatchResults(matchResults);

      // Step 5: Summary
      this.displaySummary(users, matchResults);

    } catch (error) {
      console.error("\n❌ Test Failed:");
      console.error(`Error: ${error.message}`);
      if (error.statusCode) {
        console.error(`Status Code: ${error.statusCode}`);
        if (error.response) {
          console.error(`Response: ${error.response}`);
        }
      }
      console.error();
      this.displayTroubleshooting(error);
      process.exit(1);
    }
  }

  async testAuthentication() {
    console.log("=".repeat(80));
    console.log("Step 1: Testing Microsoft Graph API Authentication");
    console.log("=".repeat(80));
    console.log();
    console.log("Credentials:");
    console.log(`  Client ID: ${TEST_CREDENTIALS.clientId}`);
    console.log(`  Tenant ID: ${TEST_CREDENTIALS.tenantId}`);
    console.log(`  Client Secret: ${TEST_CREDENTIALS.clientSecret.substring(0, 10)}...`);
    console.log();
    console.log("Testing authentication...");

    const client = new MicrosoftGraphApiClient(
      TEST_CREDENTIALS.clientId,
      TEST_CREDENTIALS.tenantId,
      TEST_CREDENTIALS.clientSecret
    );

    const connected = await client.testConnection();

    if (!connected) {
      throw new Error("Failed to authenticate with Microsoft Graph API");
    }

    console.log("✓ Authentication successful!");
    console.log();
  }

  displayUsers(users) {
    console.log("Users Fetched from Microsoft Graph:");
    console.log("-".repeat(80));
    console.log();

    if (users.length === 0) {
      console.log("No users found matching the filter.");
      return;
    }

    const tableHeaders = ["#", "Name", "Email", "Title", "Dept", "Location", "Enabled"];
    const columnWidths = [4, 30, 35, 20, 20, 20, 8];

    // Print header
    console.log(tableHeaders.map((h, i) => h.padEnd(columnWidths[i])).join(" "));
    console.log("-".repeat(80));

    // Print rows
    users.forEach((user, index) => {
      const row = [
        (index + 1).toString().padEnd(columnWidths[0]),
        (user.displayName || "").substring(0, 29).padEnd(columnWidths[1]),
        (user.mail || "").substring(0, 34).padEnd(columnWidths[2]),
        (user.jobTitle || "").substring(0, 19).padEnd(columnWidths[3]),
        (user.department || "").substring(0, 19).padEnd(columnWidths[4]),
        (user.officeLocation || "").substring(0, 19).padEnd(columnWidths[5]),
        (user.accountEnabled ? "Yes" : "No").padEnd(columnWidths[6])
      ];
      console.log(row.join(" "));
    });

    console.log();
  }

  simulateMatching(graphUsers, existingAssets) {
    const results = {
      matched: [],
      newUsers: [],
      total: graphUsers.length
    };

    for (const graphUser of graphUsers) {
      const match = this.findMatchingAsset(graphUser, existingAssets);

      if (match) {
        const changes = this.detectChanges(graphUser, match);
        results.matched.push({
          graphUser,
          existingAsset: match,
          changes
        });
      } else {
        results.newUsers.push({
          graphUser
        });
      }
    }

    return results;
  }

  findMatchingAsset(user, existingAssets) {
    const displayName = user.displayName;
    const mail = user.mail;
    const upn = user.userPrincipalName;

    // Try exact match by displayName (Name)
    if (displayName) {
      const byName = existingAssets.find(asset => {
        const nameAttr = asset.attributes.find(a => a.objectTypeAttribute?.name === "Name");
        return nameAttr && nameAttr.objectAttributeValues[0]?.value === displayName;
      });
      if (byName) return byName;
    }

    // Try exact match by email (E-Mail)
    if (mail) {
      const byEmail = existingAssets.find(asset => {
        const emailAttr = asset.attributes.find(a => a.objectTypeAttribute?.name === "E-Mail");
        return emailAttr && emailAttr.objectAttributeValues[0]?.value === mail;
      });
      if (byEmail) return byEmail;
    }

    // Try exact match by sAMAccountName
    if (upn) {
      const byUpn = existingAssets.find(asset => {
        const upnAttr = asset.attributes.find(a => a.objectTypeAttribute?.name === "sAMAccountName");
        return upnAttr && upnAttr.objectAttributeValues[0]?.value === upn;
      });
      if (byUpn) return byUpn;
    }

    return null;
  }

  detectChanges(graphUser, existingAsset) {
    const changes = [];

    for (const [graphAttr, assetsAttrName] of Object.entries(ATTRIBUTE_MAPPING)) {
      const graphValue = graphUser[graphAttr];
      const assetAttr = existingAsset.attributes.find(a => a.objectTypeAttribute?.name === assetsAttrName);
      const assetValue = assetAttr ? assetAttr.objectAttributeValues[0]?.value : null;

      if (this.normalizeValue(graphValue) !== this.normalizeValue(assetValue)) {
        changes.push({
          attribute: assetsAttrName,
          oldValue: assetValue || "",
          newValue: graphValue || ""
        });
      }
    }

    return changes;
  }

  normalizeValue(value) {
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value).trim();
  }

  displayMatchResults(results) {
    console.log(`Matched Users: ${results.matched.length}`);
    console.log("New Users: ${results.newUsers.length}");
    console.log();

    // Display matched users
    if (results.matched.length > 0) {
      console.log("Matched Users (would update if changed):");
      console.log("-".repeat(80));

      results.matched.forEach((result, index) => {
        const user = result.graphUser;
        const asset = result.existingAsset;
        const changes = result.changes;

        console.log(`\n${index + 1}. ${user.displayName || 'Unknown'} (${user.mail || user.userPrincipalName})`);

        if (changes.length > 0) {
          console.log(`   Changes detected (${changes.length}):`);
          changes.forEach(change => {
            console.log(`   - ${change.attribute}:`);
            console.log(`     "${change.oldValue}" → "${change.newValue}"`);
          });
        } else {
          console.log(`   No changes detected - would skip`);
        }
      });
      console.log();
    }

    // Display new users
    if (results.newUsers.length > 0) {
      console.log("\nNew Users (would create as assets):");
      console.log("-".repeat(80));

      results.newUsers.forEach((result, index) => {
        const user = result.graphUser;
        console.log(`\n${index + 1}. ${user.displayName || 'Unknown'} (${user.mail || user.userPrincipalName})`);
        console.log(`   Would create with ${Object.keys(ATTRIBUTE_MAPPING).length} attributes`);
      });
      console.log();
    }
  }

  displaySummary(users, matchResults) {
    const stats = {
      totalUsers: users.length,
      matched: matchResults.matched.length,
      newUsers: matchResults.newUsers.length,
      withChanges: matchResults.matched.filter(r => r.changes.length > 0).length,
      noChanges: matchResults.matched.filter(r => r.changes.length === 0).length
    };

    console.log("\n" + "=".repeat(80));
    console.log("Test Summary");
    console.log("=".repeat(80));
    console.log();
    console.log(`✓ Successfully authenticated with Microsoft Graph API`);
    console.log(`✓ Successfully fetched ${stats.totalUsers} users with filter "userType eq 'Member'"`);
    console.log(`✓ Matching logic tested against ${SIMULATED_EXISTING_USERS.length} simulated existing users`);
    console.log();
    console.log("Results:");
    console.log(`  Total users fetched: ${stats.totalUsers}`);
    console.log(`  Matched existing users: ${stats.matched}`);
    console.log(`  - Would update: ${stats.withChanges} (have changes)`);
    console.log(`  - Would skip: ${stats.noChanges} (no changes)`);
    console.log(`  New users to create: ${stats.newUsers}`);
    console.log();
    console.log("Next Steps:");
    console.log("  1. Create .env file with your Jira Cloud Assets credentials");
    console.log("  2. Update OBJECT_SCHEMA_ID and OBJECT_TYPE_ID if different from default");
    console.log("  3. Run: npm run dry-run (to test without making changes)");
    console.log("  4. Run: npm start (to perform actual ingestion)");
    console.log();
    console.log("=".repeat(80));
  }

  displayTroubleshooting(error) {
    console.log("Troubleshooting:");
    console.log("-".repeat(80));

    if (error.statusCode === 401 || error.statusCode === 403) {
      console.log("\nAuthentication Error:");
      console.log("  • Verify Client ID is correct");
      console.log("  • Verify Tenant ID is correct");
      console.log("  • Verify Client Secret is correct");
      console.log("  • Ensure admin consent has been granted for User.Read.All permission");
      console.log("  • Check that the application is not disabled");
    } else if (error.statusCode === 429) {
      console.log("\nRate Limiting:");
      console.log("  • Too many requests to Microsoft Graph API");
      console.log("  • Wait a few minutes and try again");
    } else if (error.message.includes("ENOTFOUND") || error.message.includes("getaddrinfo")) {
      console.log("\nNetwork Error:");
      console.log("  • Check your internet connection");
      console.log("  • Verify you can reach login.microsoftonline.com");
    } else {
      console.log("\nError Details:");
      console.log(`  ${error.message}`);
    }

    console.log();
    console.log("For more help, see:");
    console.log("  • README.md - Complete documentation");
    console.log("  • QUICKSTART.md - Quick start guide");
    console.log();
  }
}

// Run the test
const tester = new MicrosoftGraphTester();
tester.run().catch(error => {
  console.error("\n❌ Fatal Error:");
  console.error(error);
  process.exit(1);
});
