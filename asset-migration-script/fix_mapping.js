#!/usr/bin/env node

/**
 * Fix created_objects_mapping.json by adding 3 missing objects
 * These objects were marked as "created" in the plan but never added to the mapping
 */

const fs = require("fs");
const path = require("path");

const mappingFile = path.join(
  __dirname,
  "logs",
  "created_objects_mapping.json",
);
const mapping = JSON.parse(fs.readFileSync(mappingFile, "utf8"));

// Missing objects from the plan - customize these with your actual values
// Find objects that are marked as "created" in the plan but missing from the mapping
const missingObjects = [
  // Example entries - replace with your actual missing objects:
  // {
  //   datacenterKey: "UD-xxxxx",
  //   cloudKey: "UD-xxxxxx",
  //   cloudId: "xxxxxx",
  //   name: "User Name",
  //   schema: "User_Directory",
  //   objectType: "User",
  //   createdAt: "2025-10-24T14:49:27.546Z"
  // },
];

console.log("🔧 Fixing created_objects_mapping.json...");
console.log(`   Current mappings: ${mapping.totalMappings}`);

let added = 0;

for (const obj of missingObjects) {
  // Check if already exists
  const exists = mapping.mappings.some(([key]) => key === obj.datacenterKey);

  if (exists) {
    console.log(`   ⏭️  ${obj.datacenterKey} already exists in mapping`);
    continue;
  }

  // Add primary mapping by datacenter key
  mapping.mappings.push([
    obj.datacenterKey,
    {
      datacenterKey: obj.datacenterKey,
      cloudKey: obj.cloudKey,
      cloudId: obj.cloudId,
      name: obj.name,
      schema: obj.schema,
      objectType: obj.objectType,
      createdAt: obj.createdAt,
      isStandalone: false,
      isParent: false,
      isChild: false,
      parentKey: null,
      childrenKeys: [],
    },
  ]);

  // Add secondary mapping by name
  const nameKey = `name:${obj.schema}:${obj.objectType}:${obj.name}`;
  mapping.mappings.push([
    nameKey,
    {
      datacenterKey: obj.datacenterKey,
      cloudKey: obj.cloudKey,
      cloudId: obj.cloudId,
      name: obj.name,
      schema: obj.schema,
      objectType: obj.objectType,
      createdAt: obj.createdAt,
      isStandalone: false,
      isParent: false,
      isChild: false,
      parentKey: null,
      childrenKeys: [],
    },
  ]);

  added++;
  console.log(`   ✅ Added ${obj.datacenterKey} → ${obj.cloudKey}`);
}

// Update metadata
mapping.totalMappings = mapping.mappings.length;
mapping.lastUpdated = new Date().toISOString();

// Save with backup
const backupFile = mappingFile + ".backup";
fs.copyFileSync(mappingFile, backupFile);
console.log(`   💾 Backup saved to: ${path.basename(backupFile)}`);

fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), "utf8");

console.log(`   ✅ Fixed mapping file!`);
console.log(`   New total mappings: ${mapping.totalMappings}`);
console.log(`   Added ${added} missing object(s)`);
console.log(
  "\n🎉 Done! You can now re-run the migration to process the 25 pending objects.",
);
