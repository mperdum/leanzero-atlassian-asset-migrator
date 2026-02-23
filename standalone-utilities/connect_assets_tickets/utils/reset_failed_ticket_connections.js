#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const TicketConnectionPlanManager = require("./ticketConnectionPlanManager");

/**
 * Reset Failed Ticket Connections - Standalone Utility
 *
 * This utility modifies the ticket_connection_plan.json to:
 * 1. Read permanent_failures.csv to identify objects with failed tickets
 * 2. Find the source objects that own those tickets
 * 3. Reset those objects back to "pending" so failed tickets can be retried
 */

class ResetFailedTicketConnections {
  constructor() {
    this.planManager = new TicketConnectionPlanManager();
    this.stats = {
      totalObjects: 0,
      failedTickets: 0,
      objectsReset: 0,
      objectsNotFound: 0,
    };
  }

  async run() {
    console.log("🔄 Reset Failed Ticket Connections Utility");
    console.log("=".repeat(50));
    console.log();

    try {
      // Load existing plan
      console.log("📂 Loading ticket connection plan...");
      const plan = this.planManager.loadOrCreatePlan();

      if (!plan || !plan.objects) {
        console.log(
          "❌ No ticket connection plan found. Run the ticket connector first.",
        );
        process.exit(1);
      }

      this.stats.totalObjects = plan.objects.length;

      // Show current status
      console.log("📊 Current Status:");
      const summary = this.planManager.getPlanSummary();
      console.log(`   Total objects: ${summary.totalObjects}`);
      console.log(`   Objects with tickets: ${summary.objectsWithTickets}`);
      console.log(`   Total tickets: ${summary.totalTickets}`);
      console.log(`   Pending: ${summary.stats.pending}`);
      console.log(`   Completed: ${summary.stats.completed}`);
      console.log(`   Failed: ${summary.stats.failed}`);
      console.log(`   Skipped: ${summary.stats.skipped}`);
      console.log();

      // Count objects with failed tickets directly from plan
      let objectsWithFailures = 0;
      let totalFailedTickets = 0;
      for (const obj of plan.objects) {
        if (obj.failedTickets > 0) {
          objectsWithFailures++;
          totalFailedTickets += obj.failedTickets;
        }
      }

      console.log("📊 Failure Analysis:");
      console.log(`   Objects with failed tickets: ${objectsWithFailures}`);
      console.log(`   Total failed tickets: ${totalFailedTickets}`);
      console.log();

      if (objectsWithFailures === 0) {
        console.log("✅ No failed ticket connections to reset.");
        process.exit(0);
      }

      // Reset objects that have any failed tickets
      console.log(
        `🔄 Resetting ${objectsWithFailures} objects with failed tickets to pending...`,
      );
      let resetCount = 0;

      for (const obj of plan.objects) {
        if (obj.failedTickets > 0 && obj.status !== "pending") {
          this.planManager.updateObjectStatus(obj.datacenterKey, "pending", {
            processedTickets: 0,
            successfulTickets: 0,
            failedTickets: 0,
            error: null,
          });
          resetCount++;
        }
      }

      // Save the plan after all updates
      this.planManager.savePlan();

      this.stats.objectsReset = resetCount;
      this.stats.unchanged = this.stats.totalObjects - resetCount;

      // Show results
      console.log();
      console.log("✅ Reset Complete!");
      console.log("=".repeat(50));
      console.log(`Total objects in plan: ${this.stats.totalObjects}`);
      console.log(`Objects reset to pending: ${this.stats.objectsReset}`);
      console.log(`Unchanged objects: ${this.stats.unchanged}`);

      // Show new status
      const newSummary = this.planManager.getPlanSummary();
      console.log();
      console.log("📊 New Status:");
      console.log(
        `   Pending: ${newSummary.stats.pending} (+${this.stats.objectsReset})`,
      );
      console.log(`   Completed: ${newSummary.stats.completed}`);
      console.log(`   Failed: ${newSummary.stats.failed}`);
      console.log(`   Skipped: ${newSummary.stats.skipped}`);

      if (newSummary.stats.pending > 0) {
        console.log();
        console.log(
          `🚀 Ready to retry ${newSummary.stats.pending} pending ticket connections!`,
        );
        console.log(
          `Run: node connect_tickets_to_existing_objects.js --mode start-from-pending`,
        );
      }
    } catch (error) {
      console.error("❌ Error during reset:", error.message);
      console.error(error.stack);
      process.exit(1);
    }
  }

  showHelp() {
    console.log(`
Reset Failed Ticket Connections Utility

Resets all failed ticket connections back to pending status so they can be retried.

Usage:
  node reset_failed_ticket_connections.js

This utility will:
- Load the existing ticket_connection_plan.json
- Change all "failed" status back to "pending"
- Reset error information and processing counts
- Save the updated plan

After running this utility, you can retry failed connections with:
  node connect_tickets_to_existing_objects.js --mode start-from-pending
        `);
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    const resetUtil = new ResetFailedTicketConnections();
    resetUtil.showHelp();
    process.exit(0);
  }
}

// Main execution
async function main() {
  try {
    parseArgs();
    const resetUtil = new ResetFailedTicketConnections();
    await resetUtil.run();
    process.exit(0);
  } catch (error) {
    console.error("❌ Fatal error:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = ResetFailedTicketConnections;
