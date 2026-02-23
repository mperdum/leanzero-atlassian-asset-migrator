#!/usr/bin/env node

/**
 * Analyze Enhanced Ticket Connection Error Logs
 *
 * This script parses the detailed ticket connection logs and generates a report
 * showing EXACTLY which custom field IDs are causing errors, grouped by:
 * - Custom field ID and name
 * - Error type
 * - Asset objects affected
 *
 * Usage: node analyze_field_errors.js [log_file]
 * Default: Uses the most recent ticket_connection_detailed_*.log
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

class FieldErrorAnalyzer {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    this.stats = {
      totalLines: 0,
      totalFailures: 0,
      errorsByField: new Map(), // fieldId -> { fieldName, errors: Map(errorMsg -> count), tickets: Set, assets: Set }
      errorsByType: new Map(),  // error message -> count
      workspaceErrors: [],      // Detailed workspace mismatch errors
    };
  }

  /**
   * Parse a single log line
   */
  parseLine(line) {
    this.stats.totalLines++;

    try {
      const entry = JSON.parse(line);

      // Only process failed entries
      if (entry.success === true) return;

      this.stats.totalFailures++;

      const errorMsg = entry.error || 'Unknown error';
      const ticketKey = entry.ticketKey;
      const cloudObjectKey = entry.cloudObjectKey;
      const customFields = entry.customFields || [];

      // Track error by type
      if (!this.stats.errorsByType.has(errorMsg)) {
        this.stats.errorsByType.set(errorMsg, 0);
      }
      this.stats.errorsByType.set(errorMsg, this.stats.errorsByType.get(errorMsg) + 1);

      // Track errors by custom field
      if (customFields.length > 0) {
        for (const field of customFields) {
          const fieldId = field.cloudFieldId;
          const fieldName = field.datacenterFieldName;

          if (!this.stats.errorsByField.has(fieldId)) {
            this.stats.errorsByField.set(fieldId, {
              fieldId,
              fieldName,
              errors: new Map(),
              tickets: new Set(),
              assets: new Set(),
            });
          }

          const fieldStats = this.stats.errorsByField.get(fieldId);

          // Track error for this field
          if (!fieldStats.errors.has(errorMsg)) {
            fieldStats.errors.set(errorMsg, 0);
          }
          fieldStats.errors.set(errorMsg, fieldStats.errors.get(errorMsg) + 1);

          // Track tickets and assets
          fieldStats.tickets.add(ticketKey);
          if (cloudObjectKey) {
            fieldStats.assets.add(cloudObjectKey);
          }

          // If it's a workspace error, save detailed info
          if (errorMsg.toLowerCase().includes('workspace') ||
              errorMsg.toLowerCase().includes('tenant')) {
            this.stats.workspaceErrors.push({
              ticketKey,
              fieldId,
              fieldName,
              cloudObjectKey,
              error: errorMsg,
              assetIds: field.assetIds || [],
            });
          }
        }
      } else {
        // Error with no field context (field resolution failed)
        const unknownFieldId = 'UNKNOWN_FIELD';
        if (!this.stats.errorsByField.has(unknownFieldId)) {
          this.stats.errorsByField.set(unknownFieldId, {
            fieldId: unknownFieldId,
            fieldName: 'Field resolution failed',
            errors: new Map(),
            tickets: new Set(),
            assets: new Set(),
          });
        }

        const fieldStats = this.stats.errorsByField.get(unknownFieldId);
        if (!fieldStats.errors.has(errorMsg)) {
          fieldStats.errors.set(errorMsg, 0);
        }
        fieldStats.errors.set(errorMsg, fieldStats.errors.get(errorMsg) + 1);
        fieldStats.tickets.add(ticketKey);
      }
    } catch (error) {
      // Skip non-JSON lines (console output)
      if (!line.startsWith('[') && !line.startsWith('{')) return;
      console.error(`Failed to parse line: ${error.message}`);
    }
  }

  /**
   * Process the log file
   */
  async analyze() {
    console.log(`\n📊 Analyzing Enhanced Error Logs: ${path.basename(this.logFilePath)}`);
    console.log('='.repeat(80));

    const fileStream = fs.createReadStream(this.logFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      this.parseLine(line);

      if (this.stats.totalLines % 10000 === 0) {
        process.stdout.write(`\r   Processed ${this.stats.totalLines} lines...`);
      }
    }

    console.log(`\n   ✅ Processed ${this.stats.totalLines} lines, found ${this.stats.totalFailures} failures\n`);
  }

  /**
   * Generate report
   */
  generateReport() {
    console.log('='.repeat(80));
    console.log('📋 CUSTOM FIELD ERROR ANALYSIS');
    console.log('='.repeat(80));

    // Sort fields by error count (descending)
    const sortedFields = Array.from(this.stats.errorsByField.entries())
      .map(([fieldId, data]) => ({
        fieldId,
        ...data,
        totalErrors: Array.from(data.errors.values()).reduce((sum, count) => sum + count, 0),
        ticketCount: data.tickets.size,
        assetCount: data.assets.size,
      }))
      .sort((a, b) => b.totalErrors - a.totalErrors);

    console.log(`\nFound ${sortedFields.length} unique custom fields with errors:\n`);

    for (const field of sortedFields) {
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`Field ID: ${field.fieldId}`);
      console.log(`Field Name: ${field.fieldName}`);
      console.log(`Total Errors: ${field.totalErrors}`);
      console.log(`Affected Tickets: ${field.ticketCount}`);
      console.log(`Affected Assets: ${field.assetCount}`);
      console.log(`\nError Breakdown:`);

      // Sort errors by count
      const sortedErrors = Array.from(field.errors.entries())
        .sort((a, b) => b[1] - a[1]);

      for (const [errorMsg, count] of sortedErrors) {
        const percentage = ((count / field.totalErrors) * 100).toFixed(1);
        console.log(`  • ${errorMsg}`);
        console.log(`    Count: ${count} (${percentage}%)`);
      }
    }

    // Error type summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 ERROR TYPE SUMMARY');
    console.log('='.repeat(80));

    const sortedErrorTypes = Array.from(this.stats.errorsByType.entries())
      .sort((a, b) => b[1] - a[1]);

    for (const [errorMsg, count] of sortedErrorTypes) {
      const percentage = ((count / this.stats.totalFailures) * 100).toFixed(1);
      console.log(`\n${errorMsg}`);
      console.log(`  Count: ${count} (${percentage}%)`);
    }

    // Workspace errors detail
    if (this.stats.workspaceErrors.length > 0) {
      console.log('\n' + '='.repeat(80));
      console.log('🔍 WORKSPACE MISMATCH ERRORS - DETAILED VIEW');
      console.log('='.repeat(80));
      console.log(`\nTotal workspace errors: ${this.stats.workspaceErrors.length}`);
      console.log(`\nShowing first 20 examples:\n`);

      const examples = this.stats.workspaceErrors.slice(0, 20);
      for (const err of examples) {
        console.log(`Ticket: ${err.ticketKey}`);
        console.log(`  Field: ${err.fieldId} ("${err.fieldName}")`);
        console.log(`  Asset: ${err.cloudObjectKey}`);
        console.log(`  Asset IDs: [${err.assetIds.join(', ')}]`);
        console.log(`  Error: ${err.error}`);
        console.log('');
      }
    }

    // Save detailed report to file
    const reportPath = path.join(path.dirname(this.logFilePath), 'field_error_report.json');
    const report = {
      generated: new Date().toISOString(),
      logFile: this.logFilePath,
      summary: {
        totalLines: this.stats.totalLines,
        totalFailures: this.stats.totalFailures,
        uniqueFields: sortedFields.length,
        uniqueErrorTypes: sortedErrorTypes.length,
      },
      fieldErrors: sortedFields.map(f => ({
        fieldId: f.fieldId,
        fieldName: f.fieldName,
        totalErrors: f.totalErrors,
        affectedTickets: f.ticketCount,
        affectedAssets: f.assetCount,
        errors: Array.from(f.errors.entries()).map(([msg, count]) => ({ message: msg, count })),
        sampleTickets: Array.from(f.tickets).slice(0, 10),
        sampleAssets: Array.from(f.assets).slice(0, 10),
      })),
      errorTypes: sortedErrorTypes.map(([msg, count]) => ({ message: msg, count })),
      workspaceErrors: this.stats.workspaceErrors.slice(0, 100), // First 100
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Detailed report saved to: ${reportPath}\n`);
  }
}

// Main execution
async function main() {
  const logDir = path.join(__dirname, '../logs');
  let logFilePath = process.argv[2];

  // If no file specified, find the most recent detailed log
  if (!logFilePath) {
    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('ticket_connection_detailed_') && f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: path.join(logDir, f),
        mtime: fs.statSync(path.join(logDir, f)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      console.error('❌ No ticket connection logs found in logs/ directory');
      process.exit(1);
    }

    logFilePath = files[0].path;
    console.log(`📂 Using most recent log: ${files[0].name}`);
  }

  if (!fs.existsSync(logFilePath)) {
    console.error(`❌ Log file not found: ${logFilePath}`);
    process.exit(1);
  }

  const analyzer = new FieldErrorAnalyzer(logFilePath);
  await analyzer.analyze();
  analyzer.generateReport();

  console.log('✅ Analysis complete!\n');
}

main().catch(error => {
  console.error('❌ Fatal error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
