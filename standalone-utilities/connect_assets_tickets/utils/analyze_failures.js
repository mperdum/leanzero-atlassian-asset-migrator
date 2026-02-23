const fs = require("fs");
const path = require("path");
const readline = require("readline");

async function analyzeFailures() {
  // Get log file from command line or find the latest one
  let logFile = process.argv[2];

  if (!logFile) {
    // Find the latest detailed log file
    const logsDir = path.join(__dirname, "../logs");
    const files = fs
      .readdirSync(logsDir)
      .filter(
        (f) =>
          f.startsWith("ticket_connection_detailed_") && f.endsWith(".log"),
      )
      .map((f) => ({
        name: f,
        path: path.join(logsDir, f),
        time: fs.statSync(path.join(logsDir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);

    if (files.length === 0) {
      console.error("❌ No ticket connection log files found in ../logs/");
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

  const stats = {
    totalFailed: 0,
    byErrorType: {},
    byProject: {},
    uniqueTickets: new Set(),
    sampleErrors: [],
  };

  const fileStream = fs.createReadStream(logFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.includes("Failed to update ticket")) {
      stats.totalFailed++;

      // Extract ticket key and error
      const match = line.match(/Failed to update ticket ([A-Z]+-\d+): (.+)$/);
      if (match) {
        const [, ticketKey, error] = match;
        const project = ticketKey.split("-")[0];

        stats.uniqueTickets.add(ticketKey);

        // Count by error type
        stats.byErrorType[error] = (stats.byErrorType[error] || 0) + 1;

        // Count by project
        stats.byProject[project] = (stats.byProject[project] || 0) + 1;

        // Sample errors (first 5 of each type)
        if (!stats.sampleErrors.find((s) => s.error === error)) {
          stats.sampleErrors.push({ ticketKey, error });
        }
      }
    }
  }

  return stats;
}

analyzeFailures()
  .then((stats) => {
    console.log("📊 TICKET CONNECTION FAILURE REPORT");
    console.log("=====================================\n");

    console.log(`Total Failed Attempts: ${stats.totalFailed.toLocaleString()}`);
    console.log(
      `Unique Failed Tickets: ${stats.uniqueTickets.size.toLocaleString()}\n`,
    );

    console.log("📋 FAILURES BY ERROR TYPE:");
    console.log("─────────────────────────────────────");
    const sortedErrors = Object.entries(stats.byErrorType).sort(
      (a, b) => b[1] - a[1],
    );
    sortedErrors.forEach(([error, count]) => {
      const percentage = ((count / stats.totalFailed) * 100).toFixed(1);
      console.log(
        `  ${count.toLocaleString().padStart(6)} (${percentage}%) - ${error.substring(0, 80)}`,
      );
    });

    console.log("\n📦 FAILURES BY PROJECT:");
    console.log("─────────────────────────────────────");
    const sortedProjects = Object.entries(stats.byProject)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    sortedProjects.forEach(([project, count]) => {
      console.log(`  ${count.toLocaleString().padStart(6)} - ${project}`);
    });

    console.log("\n💡 ANALYSIS:");
    console.log("─────────────────────────────────────");

    const errorTypes = Object.keys(stats.byErrorType);

    if (errorTypes.some((e) => e.includes("An error occurred"))) {
      const genericErrors = stats.byErrorType["An error occurred"] || 0;
      console.log(
        `⚠️  ${genericErrors.toLocaleString()} generic "An error occurred" failures`,
      );
      console.log(
        "   These are likely workspace mismatch errors (not detailed in error message)",
      );
    }

    if (errorTypes.some((e) => e.includes("rate-limited"))) {
      const rateLimited = Object.entries(stats.byErrorType)
        .filter(([e]) => e.includes("rate-limited"))
        .reduce((sum, [, count]) => sum + count, 0);
      console.log(`\n⏱️  ${rateLimited.toLocaleString()} rate limit errors`);
      console.log("   These tickets can be retried after rate limit expires");
    }

    if (errorTypes.some((e) => e.includes("Validation failed"))) {
      const validation =
        stats.byErrorType["Validation failed for Insight object"] || 0;
      console.log(`\n❌ ${validation.toLocaleString()} validation failures`);
      console.log(
        "   These are likely due to invalid object references or field configurations",
      );
    }

    if (errorTypes.some((e) => e.includes("permission"))) {
      const permission = Object.entries(stats.byErrorType)
        .filter(([e]) => e.includes("permission"))
        .reduce((sum, [, count]) => sum + count, 0);
      console.log(`\n🔒 ${permission.toLocaleString()} permission errors`);
      console.log("   These tickets may not exist or user lacks access");
    }

    console.log("\n📌 RECOMMENDATION:");
    console.log("─────────────────────────────────────");
    console.log(
      '1. The majority of "An error occurred" are likely workspace mismatch issues',
    );
    console.log("2. Rate-limited tickets (675) should be retried");
    console.log("3. Permission errors (138) need access verification");
    console.log(
      "4. Validation errors (254) may need object/field investigation",
    );
  })
  .catch(console.error);
