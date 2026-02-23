/**
 * CreatedObjectsTracker - Tracks all objects created during migration
 * Maps datacenter keys to cloud keys for proper reference resolution
 */

const fs = require("fs");
const path = require("path");

class CreatedObjectsTracker {
  constructor() {
    this.trackingFile = path.join(
      __dirname,
      "../logs/created_objects_mapping.json",
    );
    this.mapping = new Map();

    // PERFORMANCE OPTIMIZATIONS
    this.needsSave = false;
    this.batchSaveTimer = null;
    this.batchSaveInterval = 500; // Save every 500ms when changes pending
    this.lookupCache = new Map(); // Cache frequent lookups
    this.lastCacheSize = 0;

    // 🧹 MEMORY OPTIMIZATION: Reduced cache size from 1000 to 500
    this.MAX_CACHE_SIZE = 500; // Reduced from 1000 to save memory
    this.CACHE_EVICTION_SIZE = 100; // Remove 100 entries when limit hit (was 200)

    this.loadMapping();
  }

  /**
   * Load existing mapping from file
   */
  loadMapping() {
    try {
      if (fs.existsSync(this.trackingFile)) {
        const data = JSON.parse(fs.readFileSync(this.trackingFile, "utf8"));

        // Convert arrays back to Map
        if (data.mappings) {
          this.mapping = new Map(data.mappings);
        }

        console.log(
          `    📚 Loaded ${this.mapping.size} created object mappings`,
        );
      }
    } catch (error) {
      console.log(
        `    ⚠️  Could not load created objects mapping: ${error.message}`,
      );
      this.mapping = new Map();
    }
  }

  /**
   * PERFORMANCE: Mark for batched save
   */
  markForSave() {
    this.needsSave = true;

    if (this.batchSaveTimer) {
      clearTimeout(this.batchSaveTimer);
    }

    this.batchSaveTimer = setTimeout(() => {
      this.saveMapping();
    }, this.batchSaveInterval);
  }

  /**
   * 🧹 MEMORY OPTIMIZATION: Stream JSON write to avoid massive string in memory
   * SYNCHRONOUS version - writes mapping entries in chunks using fs.openSync/writeSync
   * CRITICAL: Must be synchronous because saveMapping() is called synchronously
   */
  saveMapping() {
    try {
      // Skip save if no changes
      if (!this.needsSave) return;

      const saveStart = Date.now();
      const tempFile = this.trackingFile + ".tmp";
      let fd = null;

      try {
        // Open file descriptor for synchronous writes
        fd = fs.openSync(tempFile, "w");

        // Write opening structure
        fs.writeSync(fd, "{\n");
        fs.writeSync(
          fd,
          `  "lastUpdated": ${JSON.stringify(new Date().toISOString())},\n`,
        );
        fs.writeSync(fd, `  "totalMappings": ${this.mapping.size},\n`);
        fs.writeSync(fd, '  "mappings": [\n');

        // Write mappings array in chunks
        const entries = Array.from(this.mapping.entries());
        const CHUNK_SIZE = 100; // Process 100 entries at a time

        for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
          const end = Math.min(i + CHUNK_SIZE, entries.length);

          for (let j = i; j < end; j++) {
            const entryStr = JSON.stringify(entries[j]);
            const isLast = j === entries.length - 1;
            fs.writeSync(fd, `    ${entryStr}${isLast ? "" : ","}\n`);
          }
        }

        fs.writeSync(fd, "  ]\n");
        fs.writeSync(fd, "}\n");

        // Close file descriptor
        fs.closeSync(fd);
        fd = null;

        // Atomic rename after successful write
        fs.renameSync(tempFile, this.trackingFile);

        this.needsSave = false;
        const saveTime = Date.now() - saveStart;

        if (saveTime > 50) {
          // Log slow saves
          console.log(
            `    ⚡ Mapping saved in ${saveTime}ms (${this.mapping.size} entries)`,
          );
        }

        // Clear lookup cache if mapping size changed significantly
        if (Math.abs(this.mapping.size - this.lastCacheSize) > 100) {
          this.lookupCache.clear();
          this.lastCacheSize = this.mapping.size;
        }
      } catch (writeError) {
        // Cleanup on write error
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch (e) {}
        }
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
        throw writeError;
      }
    } catch (error) {
      console.log(
        `    ⚠️  Could not save created objects mapping: ${error.message}`,
      );
    }
  }

  /**
   * Track a newly created object in the authoritative mapping
   *
   * @param {string} datacenterKey - Original datacenter key (e.g., IAM-66306)
   * @param {string} cloudKey - New cloud key (e.g., IAM-123)
   * @param {Object} metadata - Object metadata (cloudId, name, schema, objectType)
   *
   * AI INSTRUCTIONS:
   * - This is the CORE method for maintaining datacenter→cloud object mapping
   * - Every successful object creation MUST call this method immediately
   * - Creates authoritative mapping entry with comprehensive metadata
   * - Enables all future reference resolution via mapping lookup
   * - Uses batched saves for performance (markForSave() pattern)
   * - Critical for plan-driven approach - mapping IS the truth
   */
  trackCreatedObject(datacenterKey, cloudKey, metadata = {}) {
    const entry = {
      datacenterKey,
      cloudKey,
      cloudId: metadata.cloudId,
      name: metadata.name,
      schema: metadata.schema,
      objectType: metadata.objectType,
      createdAt: new Date().toISOString(),
      isStandalone: metadata.isStandalone || false,
      isParent: metadata.isParent || false,
      isChild: metadata.isChild || false,
      parentKey: metadata.parentKey || null,
      childrenKeys: metadata.childrenKeys || [],
    };

    this.mapping.set(datacenterKey, entry);

    // Also map by name if available (for name-based lookups)
    if (metadata.name) {
      const nameKey = `name:${metadata.schema}:${metadata.objectType}:${metadata.name}`;
      this.mapping.set(nameKey, entry);
    }

    // PERFORMANCE: Use batched save instead of immediate save
    this.markForSave();

    console.log(
      `    📝 Tracked: ${datacenterKey} → ${cloudKey} (${metadata.name || "unnamed"})`,
    );
  }

  /**
   * Get cloud key for a datacenter key
   * PLAN-DRIVEN: This mapping IS the authoritative source - no verification needed
   * @param {string} datacenterKey - The datacenter key to look up
   * @returns {string|null} - The cloud key if found
   */
  getCloudKey(datacenterKey) {
    const entry = this.mapping.get(datacenterKey);
    return entry ? entry.cloudKey : null;
  }

  /**
   * Get cloud ID for a datacenter key
   * PLAN-DRIVEN: This mapping IS the authoritative source - no verification needed
   * @param {string} datacenterKey - The datacenter key to look up
   * @returns {string|null} - The cloud ID if found
   */
  getCloudId(datacenterKey) {
    // PERFORMANCE: Use lookup cache for frequently accessed keys
    if (this.lookupCache.has(datacenterKey)) {
      const cachedValue = this.lookupCache.get(datacenterKey);
      // 🧹 TRUE LRU: Move to end by deleting and re-inserting
      this.lookupCache.delete(datacenterKey);
      this.lookupCache.set(datacenterKey, cachedValue);
      return cachedValue;
    }

    const entry = this.mapping.get(datacenterKey);
    const cloudId = entry ? entry.cloudId : null;

    // Cache the result
    this.lookupCache.set(datacenterKey, cloudId);

    // 🧹 MEMORY OPTIMIZATION: Limit cache size with LRU eviction
    if (this.lookupCache.size > this.MAX_CACHE_SIZE) {
      // Remove oldest entries (Map iteration order = insertion order)
      // By deleting first entries, we keep most recently accessed
      const entriesToRemove = Array.from(this.lookupCache.keys()).slice(
        0,
        this.CACHE_EVICTION_SIZE,
      );
      for (const key of entriesToRemove) {
        this.lookupCache.delete(key);
      }
    }

    return cloudId;
  }

  /**
   * Force immediate save for critical operations
   */
  forceSave() {
    if (this.batchSaveTimer) {
      clearTimeout(this.batchSaveTimer);
      this.batchSaveTimer = null;
    }
    this.needsSave = true;
    this.saveMapping();
  }

  /**
   * Get full entry for a datacenter key
   * PLAN-DRIVEN: This mapping IS the authoritative source - no verification needed
   * @param {string} datacenterKey - The datacenter key to look up
   * @returns {object|null} - The full mapping entry if found
   */
  getEntry(datacenterKey) {
    return this.mapping.get(datacenterKey) || null;
  }

  /**
   * Check if object exists in authoritative mapping
   *
   * @param {string} datacenterKey - Datacenter key to check
   * @returns {boolean} - true if object was created and tracked
   *
   * AI INSTRUCTIONS:
   * - Primary method for dependency existence checking in plan-driven approach
   * - Used by objectMigrator.checkDependenciesInMapping() for dependency verification
   * - Replaces all cloud queries for existence checking (performance improvement)
   * - Authoritative - if not in mapping, object doesn't exist in cloud
   * - Critical for dependency resolution without expensive cloud API calls
   */
  hasCreated(datacenterKey) {
    return this.mapping.has(datacenterKey);
  }

  /**
   * Find object by name with schema/type context
   *
   * @param {string} name - Object name to search for
   * @param {string} schema - Schema name for context
   * @param {string} objectType - Object type name for context
   * @returns {Object|null} - Mapping entry if found, null otherwise
   *
   * AI INSTRUCTIONS:
   * - Alternative lookup method when only object name is available
   * - Uses composite key format: "name:schema:objectType:name"
   * - Less reliable than datacenter key lookup (names may not be unique)
   * - Used as fallback when datacenter key is not available
   * - Helps resolve legacy references that only contain object names
   */
  findByName(name, schema, objectType) {
    const nameKey = `name:${schema}:${objectType}:${name}`;
    return this.mapping.get(nameKey) || null;
  }

  /**
   * Get all standalone objects (no dependencies)
   */
  getStandaloneObjects() {
    return Array.from(this.mapping.values()).filter((e) => e.isStandalone);
  }

  /**
   * Get all parent objects (have children but no parents)
   */
  getParentObjects() {
    return Array.from(this.mapping.values()).filter((e) => e.isParent);
  }

  /**
   * Get all child objects (have parents)
   */
  getChildObjects() {
    return Array.from(this.mapping.values()).filter((e) => e.isChild);
  }

  /**
   * Get statistics
   */
  getStatistics() {
    const entries = Array.from(this.mapping.values()).filter(
      (e) => e.datacenterKey,
    ); // Filter out name-only entries

    return {
      total: entries.length,
      standalone: entries.filter((e) => e.isStandalone).length,
      parents: entries.filter((e) => e.isParent).length,
      children: entries.filter((e) => e.isChild).length,
      bySchema: entries.reduce((acc, e) => {
        acc[e.schema] = (acc[e.schema] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  /**
   * Clear all mappings
   */
  clear() {
    this.mapping.clear();
    this.saveMapping();
    console.log("    🗑️  Cleared all created object mappings");
  }
}

module.exports = CreatedObjectsTracker;
