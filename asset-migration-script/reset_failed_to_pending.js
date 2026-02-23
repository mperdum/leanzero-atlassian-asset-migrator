#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const PLAN_FILE = path.join(__dirname, 'logs', 'migration_plan.json');

console.log('🔄 Reset Failed Objects to Pending\n');

try {
  // Read the migration plan
  if (!fs.existsSync(PLAN_FILE)) {
    console.error('❌ Migration plan file not found:', PLAN_FILE);
    process.exit(1);
  }

  console.log('📖 Loading migration plan...');
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));

  // Find and reset failed objects
  let resetCount = 0;
  const failedObjects = [];

  plan.objects.forEach(obj => {
    if (obj.status === 'failed') {
      obj.status = 'pending';
      obj.error = null;
      obj.cloudId = null;
      obj.createdAt = null;
      obj.updatedAt = null;
      failedObjects.push({
        key: obj.datacenterKey,
        name: obj.name,
        schema: obj.schema,
        objectType: obj.objectType
      });
      resetCount++;
    }
  });

  // Update plan stats
  const currentStats = plan.stats;
  const newStats = {
    total: plan.objects.length,
    created: plan.objects.filter(o => o.status === 'created').length,
    failed: plan.objects.filter(o => o.status === 'failed').length,
    pending: plan.objects.filter(o => o.status === 'pending').length,
  };

  plan.stats = newStats;
  plan.lastModified = new Date().toISOString();

  // Write back the updated plan
  console.log('💾 Saving updated migration plan...');
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));

  // Print summary
  console.log('\n✅ Successfully reset failed objects!\n');
  console.log('📊 Statistics:');
  console.log(`   Objects reset:     ${resetCount}`);
  console.log(`\n📈 Updated Plan Stats:`);
  console.log(`   Total:            ${newStats.total}`);
  console.log(`   Created:          ${newStats.created} (unchanged)`);
  console.log(`   Pending:          ${newStats.pending} (was ${currentStats.pending})`);
  console.log(`   Failed:           ${newStats.failed} (was ${currentStats.failed})`);

  if (resetCount > 0) {
    console.log(`\n📋 Reset Objects (first 10):`);
    failedObjects.slice(0, 10).forEach(obj => {
      console.log(`   • ${obj.key}: ${obj.name} (${obj.objectType})`);
    });
    if (failedObjects.length > 10) {
      console.log(`   ... and ${failedObjects.length - 10} more`);
    }
  }

  console.log('\n✨ Ready to re-run migration!\n');

} catch (error) {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
}
