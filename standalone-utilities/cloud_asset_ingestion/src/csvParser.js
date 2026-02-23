/**
 * CSV Parser Module
 *
 * Handles parsing of CSV files from the cloud_assets folder.
 * Supports both semicolon-delimited and comma-delimited CSV formats.
 */

const fs = require("fs");
const path = require("path");

class CsvParser {
  constructor() {
    this.stats = {
      filesProcessed: 0,
      totalRecords: 0,
      errors: [],
    };
  }

  /**
   * Detect the delimiter used in a CSV file
   */
  detectDelimiter(firstLine) {
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;

    // If the line starts with quotes, likely comma-delimited with quoted fields
    if (firstLine.startsWith('"')) {
      return ",";
    }

    return semicolonCount > commaCount ? ";" : ",";
  }

  /**
   * Parse a CSV line respecting quoted fields
   */
  parseCSVLine(line, delimiter) {
    const result = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          // Toggle quote mode
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }

    // Push the last field
    result.push(current.trim());

    return result;
  }

  /**
   * Parse a single CSV file
   */
  parseFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, "utf-8");
    // Normalize line endings (CRLF to LF)
    const lines = content.replace(/\r\n/g, "\n").split("\n").filter(line => line.trim());

    if (lines.length === 0) {
      return { headers: [], records: [], fileName: path.basename(filePath) };
    }

    const delimiter = this.detectDelimiter(lines[0]);
    const headers = this.parseCSVLine(lines[0], delimiter);

    const records = [];
    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i], delimiter);

      if (values.length !== headers.length) {
        // Skip malformed lines but log them
        this.stats.errors.push({
          file: filePath,
          line: i + 1,
          reason: `Column count mismatch: expected ${headers.length}, got ${values.length}`,
        });
        continue;
      }

      const record = {};
      for (let j = 0; j < headers.length; j++) {
        record[headers[j]] = values[j];
      }
      records.push(record);
    }

    this.stats.filesProcessed++;
    this.stats.totalRecords += records.length;

    return {
      headers,
      records,
      fileName: path.basename(filePath),
      delimiter,
      recordCount: records.length,
    };
  }

  /**
   * Scan a directory for CSV files
   */
  scanDirectory(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
      throw new Error(`Directory not found: ${directoryPath}`);
    }

    const files = fs.readdirSync(directoryPath);
    const csvFiles = files.filter(f => f.toLowerCase().endsWith(".csv"));

    return csvFiles.map(f => ({
      name: f,
      path: path.join(directoryPath, f),
      size: fs.statSync(path.join(directoryPath, f)).size,
    }));
  }

  /**
   * Parse all CSV files in a directory
   */
  parseDirectory(directoryPath) {
    const csvFiles = this.scanDirectory(directoryPath);
    const results = {};

    for (const file of csvFiles) {
      try {
        console.log(`  Parsing ${file.name}...`);
        const parsed = this.parseFile(file.path);

        // Derive asset type from filename (remove numbers and .csv extension)
        const assetType = file.name
          .replace(/\.csv$/i, "")
          .replace(/\s*\d+$/, "")
          .trim();

        results[assetType] = {
          ...parsed,
          assetType,
          sourcePath: file.path,
        };

        console.log(`    Found ${parsed.recordCount} records`);
      } catch (error) {
        this.stats.errors.push({
          file: file.path,
          reason: error.message,
        });
        console.error(`    Error parsing ${file.name}: ${error.message}`);
      }
    }

    return results;
  }

  /**
   * Get parser statistics
   */
  getStats() {
    return this.stats;
  }
}

module.exports = CsvParser;
