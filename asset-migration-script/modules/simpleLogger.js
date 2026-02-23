/**
 * Simple text file logger for migration runs
 * Saves all console output to timestamped .txt files
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

class SimpleLogger {
    constructor() {
        this.logDir = path.join(__dirname, '..', 'migration_logs');
        this.currentLogFile = null;
        this.logStream = null;
        this.originalConsoleLog = console.log;
        this.originalConsoleError = console.error;
        this.originalConsoleWarn = console.warn;
    }

    initialize() {
        // Create logs directory if it doesn't exist
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        // Create timestamped log file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_');
        this.currentLogFile = path.join(this.logDir, `migration_${timestamp}.txt`);
        
        // Create write stream
        this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });

        // Override console methods to capture output
        this.setupConsoleCapture();

        // Log initialization
        this.writeToFile('================================================================================');
        this.writeToFile(`Migration Log Started: ${new Date().toISOString()}`);
        this.writeToFile('================================================================================\n');
        
        // Log the file path for user reference
        this.originalConsoleLog(`📝 Logging to: ${this.currentLogFile}`);
    }

    setupConsoleCapture() {
        const self = this;

        // Override console.log
        /**
         * AI INSTRUCTIONS: Console.log override for file logging
         * - Captures all console.log output to timestamped migration log files
         * - Maintains original console output while creating persistent logs
         * - Critical for debugging and audit trails of migration runs
         * - Creates comprehensive log history for troubleshooting
         */
        console.log = function(...args) {
            const message = self.formatMessage(args);
            self.writeToFile(`[LOG] ${message}`);
            self.originalConsoleLog.apply(console, args);
        };

        // Override console.error
        /**
         * AI INSTRUCTIONS: Console.error override for file logging
         * - Captures all error output to migration log files
         * - Ensures error information is preserved for post-migration analysis
         * - Critical for troubleshooting failed migrations
         */
        console.error = function(...args) {
            const message = self.formatMessage(args);
            self.writeToFile(`[ERROR] ${message}`);
            self.originalConsoleError.apply(console, args);
        };

        // Override console.warn
        /**
         * AI INSTRUCTIONS: Console.warn override for file logging  
         * - Captures all warning output to migration log files
         * - Preserves important warning information for review
         * - Helps identify potential issues during migration
         */
        console.warn = function(...args) {
            const message = self.formatMessage(args);
            self.writeToFile(`[WARN] ${message}`);
            self.originalConsoleWarn.apply(console, args);
        };
    }

    formatMessage(args) {
        return args.map(arg => {
            if (typeof arg === 'object') {
                return util.inspect(arg, { depth: 3, colors: false });
            }
            return String(arg);
        }).join(' ');
    }

    writeToFile(message) {
        if (this.logStream) {
            const timestamp = new Date().toISOString();
            this.logStream.write(`[${timestamp}] ${message}\n`);
        }
    }

    log(message, level = 'INFO') {
        const formattedMessage = `[${level}] ${message}`;
        this.writeToFile(formattedMessage);
        
        // Also output to console with original method
        if (level === 'ERROR') {
            this.originalConsoleError(message);
        } else if (level === 'WARN') {
            this.originalConsoleWarn(message);
        } else {
            this.originalConsoleLog(message);
        }
    }

    close() {
        // Restore original console methods
        console.log = this.originalConsoleLog;
        console.error = this.originalConsoleError;
        console.warn = this.originalConsoleWarn;

        // Write closing message
        this.writeToFile('\n================================================================================');
        this.writeToFile(`Migration Log Ended: ${new Date().toISOString()}`);
        this.writeToFile('================================================================================');

        // Close the stream
        if (this.logStream) {
            this.logStream.end();
        }

        // Notify user
        this.originalConsoleLog(`\n📄 Log saved to: ${this.currentLogFile}`);
    }

    // Get the current log file path
    getLogFilePath() {
        return this.currentLogFile;
    }
}

module.exports = SimpleLogger;
