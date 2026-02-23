const fs = require('fs');

try {
  const plan = JSON.parse(fs.readFileSync('./logs/migration_plan.json', 'utf8'));
  
  const failedObjects = plan.objects.filter(obj => obj.status === 'failed');
  
  console.log(`Found ${failedObjects.length} failed objects.`);
  
  // Group failures by error message to see patterns
  const errorPatterns = {};
  
  failedObjects.forEach(obj => {
    const error = obj.error || 'Unknown error';
    if (!errorPatterns[error]) {
      errorPatterns[error] = [];
    }
    errorPatterns[error].push(`${obj.datacenterKey} (${obj.schema}/${obj.objectType})`);
  });
  
  console.log('\n--- FAILURE SUMMARY ---\n');
  
  for (const [error, objects] of Object.entries(errorPatterns)) {
    console.log(`ERROR: ${error}`);
    console.log(`COUNT: ${objects.length}`);
    console.log(`EXAMPLE OBJECTS: ${objects.slice(0, 5).join(', ')}`);
    if (objects.length > 5) {
      console.log(`...and ${objects.length - 5} more`);
    }
    console.log('----------------------------------------');
  }
  
} catch (err) {
  console.error('Error reading or parsing plan:', err);
}
