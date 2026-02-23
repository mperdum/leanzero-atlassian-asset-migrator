#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

// Get log file from command line or find the latest one
let logFile = process.argv[2];

if (!logFile) {
  // Find the latest detailed log file
  const logsDir = path.join(__dirname, "../logs");

  if (!fs.existsSync(logsDir)) {
    console.error("❌ Logs directory not found:", logsDir);
    console.error(
      "   Run connect_tickets_to_existing_objects.js first to generate logs",
    );
    process.exit(1);
  }

  const files = fs
    .readdirSync(logsDir)
    .filter(
      (f) => f.startsWith("ticket_connection_detailed_") && f.endsWith(".log"),
    )
    .map((f) => ({
      name: f,
      path: path.join(logsDir, f),
      time: fs.statSync(path.join(logsDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time);

  if (files.length === 0) {
    console.error("❌ No ticket connection log files found in:", logsDir);
    console.error(
      "   Run connect_tickets_to_existing_objects.js first to generate logs",
    );
    process.exit(1);
  }

  logFile = files[0].path;
  console.log(`📂 Using latest log file: ${files[0].name}\n`);
} else {
  // If relative path provided, resolve it from current directory
  if (!path.isAbsolute(logFile)) {
    logFile = path.resolve(logFile);
  }
}

if (!fs.existsSync(logFile)) {
  console.error(`❌ Log file not found: ${logFile}`);
  process.exit(1);
}

const lines = fs.readFileSync(logFile, "utf8").split("\n");

const failures = [];
let currentDatacenter = null;
let currentCloud = null;
let currentField = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Track datacenter object being processed
  if (line.includes("Datacenter:") && line.includes("→ Cloud:")) {
    const match = line.match(
      /Datacenter: ([^\s]+) → Cloud: ([^\s]+) \(ID: (\d+)\)/,
    );
    if (match) {
      currentDatacenter = match[1];
      currentCloud = match[2];
    }
  }

  // Track which field is being updated
  if (line.includes("📋 Field customfield_")) {
    const match = line.match(/Field (customfield_\d+):/);
    if (match) {
      currentField = match[1];
    }
  }

  // Capture failures
  if (line.includes("❌ Failed to update ticket")) {
    const match = line.match(/Failed to update ticket ([A-Z]+-\d+): (.+)$/);
    if (match) {
      failures.push({
        ticket: match[1],
        error: match[2],
        field: currentField || "UNKNOWN",
        datacenterObject: currentDatacenter || "UNKNOWN",
        cloudObject: currentCloud || "UNKNOWN",
      });
    }
  }
}

// Group by field
const byField = {};
failures.forEach((f) => {
  if (!byField[f.field]) {
    byField[f.field] = {
      field: f.field,
      count: 0,
      tickets: new Set(),
      errors: {},
      datacenterObjects: new Set(),
      cloudObjects: new Set(),
    };
  }

  byField[f.field].count++;
  byField[f.field].tickets.add(f.ticket);
  byField[f.field].datacenterObjects.add(f.datacenterObject);
  byField[f.field].cloudObjects.add(f.cloudObject);

  if (!byField[f.field].errors[f.error]) {
    byField[f.field].errors[f.error] = 0;
  }
  byField[f.field].errors[f.error]++;
});

// Print report
console.log("\n" + "=".repeat(80));
console.log("TICKET CONNECTION FAILURE ANALYSIS");
console.log("=".repeat(80));
console.log(`\nTotal Failures: ${failures.length}`);

console.log("\n" + "=".repeat(80));
console.log("BREAKDOWN BY CUSTOM FIELD");
console.log("=".repeat(80));

Object.values(byField)
  .sort((a, b) => b.count - a.count)
  .forEach((fieldData) => {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`Field ID: ${fieldData.field}`);
    console.log(`Total Failures: ${fieldData.count}`);
    console.log(`Unique Tickets: ${fieldData.tickets.size}`);
    console.log(
      `Unique Datacenter Objects: ${fieldData.datacenterObjects.size}`,
    );
    console.log(`Unique Cloud Objects: ${fieldData.cloudObjects.size}`);

    console.log(`\nError Types:`);
    Object.entries(fieldData.errors)
      .sort((a, b) => b[1] - a[1])
      .forEach(([error, count]) => {
        const pct = ((count / fieldData.count) * 100).toFixed(1);
        console.log(`  • ${error}`);
        console.log(`    Count: ${count} (${pct}%)`);
      });

    console.log(`\nSample Datacenter Objects (first 10):`);
    Array.from(fieldData.datacenterObjects)
      .slice(0, 10)
      .forEach((obj) => {
        console.log(`  - ${obj}`);
      });

    console.log(`\nSample Cloud Objects (first 10):`);
    Array.from(fieldData.cloudObjects)
      .slice(0, 10)
      .forEach((obj) => {
        console.log(`  - ${obj}`);
      });

    console.log(`\nSample Failed Tickets (first 10):`);
    Array.from(fieldData.tickets)
      .slice(0, 10)
      .forEach((ticket) => {
        console.log(`  - ${ticket}`);
      });
  });

// Show first 20 detailed failures
console.log("\n" + "=".repeat(80));
console.log("DETAILED FAILURE EXAMPLES (First 20)");
console.log("=".repeat(80));

failures.slice(0, 20).forEach((f, i) => {
  console.log(`\n[${i + 1}] Ticket: ${f.ticket}`);
  console.log(`    Field: ${f.field}`);
  console.log(
    `    Datacenter Object: ${f.datacenterObject} → Cloud: ${f.cloudObject}`,
  );
  console.log(`    Error: ${f.error}`);
});

console.log("\n");
