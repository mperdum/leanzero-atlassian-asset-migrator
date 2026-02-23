#!/usr/bin/env node

/**
 * Add User to All Project Roles
 *
 * This script adds a specific user to all roles across all projects in Jira Cloud.
 *
 * Usage:
 *   node add_user_to_all_project_roles.js
 *
 * Requirements:
 *   - CLOUD_BASE_URL environment variable
 *   - CLOUD_API_TOKEN environment variable
 *   - WORKSPACE_ID environment variable (optional, used for validation)
 *
 * Based on official Atlassian Jira Cloud REST API documentation:
 * - GET /rest/api/3/project/search (Get projects paginated)
 * - GET /rest/api/3/project/{projectIdOrKey}/role (Get project roles for project)
 * - POST /rest/api/3/project/{projectIdOrKey}/role/{id} (Add actors to project role)
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// Configuration
// Set USER_ACCOUNT_ID to the Atlassian account ID of the user you want to add to all project roles.
// You can find account IDs via the Jira Cloud REST API: GET /rest/api/3/user/search?query=<email>
const USER_ACCOUNT_ID = process.env.USER_ACCOUNT_ID || "YOUR_ATLASSIAN_ACCOUNT_ID";
const BASE_URL = process.env.CLOUD_BASE_URL?.replace(/^https?:\/\//, "") || "";
const API_TOKEN = process.env.CLOUD_API_TOKEN || "";

// Validate environment
if (!BASE_URL || !API_TOKEN) {
  console.error("❌ Error: Missing required environment variables");
  console.error(
    "   Please ensure CLOUD_BASE_URL and CLOUD_API_TOKEN are set in .env",
  );
  process.exit(1);
}

// Helper function to make HTTPS requests
function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      port: 443,
      path: path,
      method: method,
      headers: {
        Authorization: `Basic ${API_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve({ statusCode: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, data: {} });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// Get all projects (paginated)
async function getAllProjects() {
  console.log("📂 Fetching all projects...");

  const allProjects = [];
  let startAt = 0;
  const maxResults = 50; // Jira's default max
  let isLast = false;

  while (!isLast) {
    try {
      const response = await makeRequest(
        "GET",
        `/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const { values, isLast: lastPage } = response.data;

      if (values && values.length > 0) {
        allProjects.push(...values);
        console.log(`   📊 Fetched ${allProjects.length} projects so far...`);
      }

      isLast = lastPage || !values || values.length === 0;
      startAt += maxResults;
    } catch (error) {
      console.error(`❌ Error fetching projects: ${error.message}`);
      throw error;
    }
  }

  console.log(`✅ Total projects found: ${allProjects.length}`);
  return allProjects;
}

// Get all roles for a specific project
async function getProjectRoles(projectKeyOrId) {
  try {
    const response = await makeRequest(
      "GET",
      `/rest/api/3/project/${projectKeyOrId}/role`,
    );
    return response.data;
  } catch (error) {
    console.error(
      `   ❌ Error fetching roles for project ${projectKeyOrId}: ${error.message}`,
    );
    return {};
  }
}

// Add user to a specific role in a project
async function addUserToProjectRole(projectKeyOrId, roleId, userAccountId) {
  try {
    const body = {
      user: [userAccountId],
    };

    const response = await makeRequest(
      "POST",
      `/rest/api/3/project/${projectKeyOrId}/role/${roleId}`,
      body,
    );
    return { success: true, data: response.data };
  } catch (error) {
    // Check if user is already in the role (this is not an error)
    if (error.message.includes("400") || error.message.includes("already")) {
      return { success: true, alreadyExists: true };
    }
    return { success: false, error: error.message };
  }
}

// Extract role ID from role URL
function extractRoleId(roleUrl) {
  const match = roleUrl.match(/\/role\/(\d+)$/);
  return match ? match[1] : null;
}

// Main execution
async function main() {
  console.log("🚀 ADD USER TO ALL PROJECT ROLES");
  console.log("=====================================");
  console.log(`👤 User Account ID: ${USER_ACCOUNT_ID}`);
  console.log(`🌐 Jira Instance: ${BASE_URL}`);
  console.log("");

  const stats = {
    totalProjects: 0,
    processedProjects: 0,
    totalRoles: 0,
    successfulAdds: 0,
    alreadyExists: 0,
    failures: 0,
    errors: [],
  };

  try {
    // Step 1: Get all projects
    const projects = await getAllProjects();
    stats.totalProjects = projects.length;

    if (projects.length === 0) {
      console.log("⚠️  No projects found.");
      return;
    }

    console.log("");
    console.log("🔧 Processing projects and roles...");
    console.log("");

    // Step 2: For each project, get roles and add user
    for (const project of projects) {
      console.log(`📦 Project: ${project.key} (${project.name})`);

      // Get roles for this project
      const roles = await getProjectRoles(project.key);
      const roleEntries = Object.entries(roles);

      if (roleEntries.length === 0) {
        console.log(`   ⚠️  No roles found for this project`);
        stats.processedProjects++;
        continue;
      }

      console.log(`   📋 Found ${roleEntries.length} roles`);

      // Add user to each role
      for (const [roleName, roleUrl] of roleEntries) {
        const roleId = extractRoleId(roleUrl);

        if (!roleId) {
          console.log(`   ⚠️  Could not extract role ID from ${roleName}`);
          continue;
        }

        stats.totalRoles++;

        const result = await addUserToProjectRole(
          project.key,
          roleId,
          USER_ACCOUNT_ID,
        );

        if (result.success) {
          if (result.alreadyExists) {
            console.log(`   ✓ ${roleName} (already exists)`);
            stats.alreadyExists++;
          } else {
            console.log(`   ✅ ${roleName} (added)`);
            stats.successfulAdds++;
          }
        } else {
          console.log(`   ❌ ${roleName} (failed: ${result.error})`);
          stats.failures++;
          stats.errors.push({
            project: project.key,
            role: roleName,
            error: result.error,
          });
        }
      }

      stats.processedProjects++;
      console.log("");
    }

    // Step 3: Print summary
    console.log("");
    console.log("📊 SUMMARY");
    console.log("=====================================");
    console.log(`Total Projects: ${stats.totalProjects}`);
    console.log(`Processed Projects: ${stats.processedProjects}`);
    console.log(`Total Roles Processed: ${stats.totalRoles}`);
    console.log(`Successfully Added: ${stats.successfulAdds}`);
    console.log(`Already Exists: ${stats.alreadyExists}`);
    console.log(`Failures: ${stats.failures}`);
    console.log("");

    if (stats.errors.length > 0) {
      console.log("❌ ERRORS:");
      for (const error of stats.errors.slice(0, 10)) {
        console.log(`   ${error.project} / ${error.role}: ${error.error}`);
      }
      if (stats.errors.length > 10) {
        console.log(`   ... and ${stats.errors.length - 10} more errors`);
      }
    }

    console.log("");
    console.log("✅ Script completed successfully!");
  } catch (error) {
    console.error("");
    console.error("❌ FATAL ERROR:");
    console.error(error);
    process.exit(1);
  }
}

// Run the script
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
