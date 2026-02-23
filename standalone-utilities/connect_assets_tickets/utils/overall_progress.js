#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const planPath = path.join(__dirname, "../logs", "ticket_connection_plan.json");

if (!fs.existsSync(planPath)) {
  console.error("❌ Plan file not found:", planPath);
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));

// Original totals (never changes)
const ORIGINAL_TOTAL_OBJECTS = plan.totalObjects;
const ORIGINAL_OBJECTS_WITH_TICKETS = plan.objectsWithTickets;
const ORIGINAL_TOTAL_TICKETS = plan.totalTickets;

// Current stats
const stats = plan.stats;

console.log("\n" + "=".repeat(80));
console.log("📊 TICKET CONNECTION - OVERALL PROGRESS REPORT");
console.log("=".repeat(80));

console.log("\n📈 ORIGINAL TOTALS (Baseline)");
console.log("─".repeat(80));
console.log(
  `Total Objects in Migration:        ${ORIGINAL_TOTAL_OBJECTS.toLocaleString()}`,
);
console.log(
  `Objects with Connected Tickets:    ${ORIGINAL_OBJECTS_WITH_TICKETS.toLocaleString()}`,
);
console.log(
  `Total Tickets to Connect:          ${ORIGINAL_TOTAL_TICKETS.toLocaleString()}`,
);

console.log("\n✅ CURRENT STATUS");
console.log("─".repeat(80));

const completedPct = (
  (stats.completed / ORIGINAL_OBJECTS_WITH_TICKETS) *
  100
).toFixed(2);
const failedPct = (
  (stats.failed / ORIGINAL_OBJECTS_WITH_TICKETS) *
  100
).toFixed(2);
const pendingPct = (
  (stats.pending / ORIGINAL_OBJECTS_WITH_TICKETS) *
  100
).toFixed(2);
const skippedPct = ((stats.skipped / ORIGINAL_TOTAL_OBJECTS) * 100).toFixed(2);

console.log(
  `✅ Completed:  ${stats.completed.toLocaleString().padStart(8)} objects (${completedPct}% of objects with tickets)`,
);
console.log(
  `❌ Failed:     ${stats.failed.toLocaleString().padStart(8)} objects (${failedPct}% of objects with tickets)`,
);
console.log(
  `⏳ Pending:    ${stats.pending.toLocaleString().padStart(8)} objects (${pendingPct}% of objects with tickets)`,
);
console.log(
  `⏭️  Skipped:    ${stats.skipped.toLocaleString().padStart(8)} objects (${skippedPct}% of total - no tickets)`,
);

console.log("\n🎯 SUCCESS RATE (Of Objects With Tickets)");
console.log("─".repeat(80));

const processedObjects = stats.completed + stats.failed;
const successRate = ((stats.completed / processedObjects) * 100).toFixed(2);
const overallProgress = (
  (stats.completed / ORIGINAL_OBJECTS_WITH_TICKETS) *
  100
).toFixed(2);

console.log(
  `Objects Processed:     ${processedObjects.toLocaleString()} / ${ORIGINAL_OBJECTS_WITH_TICKETS.toLocaleString()}`,
);
console.log(`Success Rate:          ${successRate}%`);
console.log(
  `Overall Progress:      ${overallProgress}% of all objects with tickets`,
);

console.log("\n🎫 TICKET-LEVEL DETAILS");
console.log("─".repeat(80));

// Count actual ticket successes/failures from objects
let totalSuccessfulTickets = 0;
let totalFailedTickets = 0;
let totalProcessedTickets = 0;

plan.objects.forEach((obj) => {
  if (obj.status === "completed" || obj.status === "failed") {
    totalSuccessfulTickets += obj.successfulTickets || 0;
    totalFailedTickets += obj.failedTickets || 0;
    totalProcessedTickets += obj.processedTickets || 0;
  }
});

const ticketSuccessRate =
  totalProcessedTickets > 0
    ? ((totalSuccessfulTickets / totalProcessedTickets) * 100).toFixed(2)
    : "0.00";

const ticketOverallProgress = (
  (totalSuccessfulTickets / ORIGINAL_TOTAL_TICKETS) *
  100
).toFixed(2);

console.log(
  `Tickets Processed:              ${totalProcessedTickets.toLocaleString()} / ${ORIGINAL_TOTAL_TICKETS.toLocaleString()}`,
);
console.log(
  `Successfully Connected:         ${totalSuccessfulTickets.toLocaleString()} (${ticketSuccessRate}% success rate)`,
);
console.log(
  `Failed Connections:             ${totalFailedTickets.toLocaleString()}`,
);
console.log(
  `Overall Ticket Progress:        ${ticketOverallProgress}% of all tickets connected`,
);

console.log("\n📋 REMAINING WORK");
console.log("─".repeat(80));

const remainingObjects = ORIGINAL_OBJECTS_WITH_TICKETS - stats.completed;
const remainingPct = (
  (remainingObjects / ORIGINAL_OBJECTS_WITH_TICKETS) *
  100
).toFixed(2);

console.log(
  `Objects Still Needing Work:     ${remainingObjects.toLocaleString()} (${remainingPct}%)`,
);
console.log(`  • Failed (need retry):        ${stats.failed.toLocaleString()}`);
console.log(
  `  • Pending (not attempted):    ${stats.pending.toLocaleString()}`,
);

if (stats.failed > 0) {
  console.log("\n⚠️  FAILURES BREAKDOWN");
  console.log("─".repeat(80));

  // Analyze failed objects
  const failedObjects = plan.objects.filter((obj) => obj.status === "failed");
  const errorTypes = {};

  failedObjects.forEach((obj) => {
    const error = obj.error || "Unknown error";
    if (!errorTypes[error]) {
      errorTypes[error] = { count: 0, tickets: 0 };
    }
    errorTypes[error].count++;
    errorTypes[error].tickets += obj.failedTickets || 0;
  });

  Object.entries(errorTypes)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([error, data]) => {
      console.log(`\n• ${error}`);
      console.log(`  Objects: ${data.count}`);
      console.log(`  Tickets affected: ${data.tickets}`);
    });
}

console.log("\n📅 TIMELINE");
console.log("─".repeat(80));
console.log(
  `Plan Created:          ${new Date(plan.createdAt).toLocaleString()}`,
);
console.log(
  `Last Updated:          ${new Date(plan.updatedAt).toLocaleString()}`,
);

console.log("\n" + "=".repeat(80));
console.log(
  `🎉 BOTTOM LINE: ${completedPct}% complete, ${successRate}% success rate`,
);
console.log("=".repeat(80) + "\n");
