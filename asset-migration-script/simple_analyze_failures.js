const fs = require('fs');

try {
  const plan = JSON.parse(fs.readFileSync('./logs/migration_plan.json', 'utf8'));
  const failedObjects = plan.objects.filter(obj => obj.status === 'failed');

  console.log(`Found ${failedObjects.length} failed objects.\n`);

  // Group by error pattern (remove specific object IDs)
  const errorGroups = {};

  failedObjects.forEach(obj => {
    const error = obj.error || 'Unknown error';
    // Extract the pattern (everything before the object ID)
    const pattern = error.replace(/\(Object: [^)]*\)/g, '').trim();

    if (!errorGroups[pattern]) {
      errorGroups[pattern] = 0;
    }
    errorGroups[pattern]++;
  });

  console.log('--- FAILURE SUMMARY ---\n');

  for (const [error, count] of Object.entries(errorGroups)) {
    const match = error.match(/\[Field (\d+) - ([^\]]+)\]/);
    const fieldId = match ? match[1] : 'Unknown';
    const fieldName = match ? match[2] : 'Unknown';
    const typeMatch = error.match(/\(Type: ([^)]+)\)/);
    const type = typeMatch ? typeMatch[1] : 'Unknown';

    console.log(`Field ${fieldId} - ${fieldName}`);
    console.log(`Type: ${type}`);
    console.log(`Count: ${count}`);
    console.log('');
  }

} catch (err) {
  console.error('Error reading or parsing plan:', err);
}
