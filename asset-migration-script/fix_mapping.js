#!/usr/bin/env node

/**
 * Fix created_objects_mapping.json by adding 3 missing objects
 * These objects were marked as "created" in the plan but never added to the mapping
 */

const fs = require('fs');
const path = require('path');

const mappingFile = path.join(__dirname, 'logs', 'created_objects_mapping.json');
const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));

// 3 missing objects from the plan
const missingObjects = [
  {
    datacenterKey: "UD-11766",
    cloudKey: "UD-9468",
    cloudId: "9468",
    name: "Oliver Matuschin",
    schema: "User_Directory",
    objectType: "User",
    createdAt: "2025-10-24T14:49:27.546Z"
  },
  {
    datacenterKey: "UD-55558",
    cloudKey: "UD-9806",
    cloudId: "9806",
    name: "Shruti Rana",
    schema: "User_Directory",
    objectType: "User",
    createdAt: "2025-10-24T14:49:27.551Z"
  },
  {
    datacenterKey: "AM-43106",
    cloudKey: "AM-11641",
    cloudId: "11641",
    name: "dds-x1e-101",
    schema: "Asset_Management",
    objectType: "Asset/Laptop",
    createdAt: "2025-10-24T14:49:27.555Z"
  }
];

console.log('🔧 Fixing created_objects_mapping.json...');
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
      childrenKeys: []
    }
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
      childrenKeys: []
    }
  ]);

  added++;
  console.log(`   ✅ Added ${obj.datacenterKey} → ${obj.cloudKey}`);
}

// Update metadata
mapping.totalMappings = mapping.mappings.length;
mapping.lastUpdated = new Date().toISOString();

// Save with backup
const backupFile = mappingFile + '.backup';
fs.copyFileSync(mappingFile, backupFile);
console.log(`   💾 Backup saved to: ${path.basename(backupFile)}`);

fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), 'utf8');

console.log(`   ✅ Fixed mapping file!`);
console.log(`   New total mappings: ${mapping.totalMappings}`);
console.log(`   Added ${added} missing object(s)`);
console.log('\n🎉 Done! You can now re-run the migration to process the 25 pending objects.');
