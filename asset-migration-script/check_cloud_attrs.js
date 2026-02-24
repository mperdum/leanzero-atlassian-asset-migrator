const fs = require("fs");

try {
  const cloudConfig = JSON.parse(
    fs.readFileSync("./logs/cloud_configuration.json", "utf8"),
  );

  // Find target schema - change this to match your schema name
  const TARGET_SCHEMA = process.argv[2] || "Your Schema Name";
  const targetSchema = cloudConfig.schemas.find(
    (s) => s[1] && s[1].name.toLowerCase() === TARGET_SCHEMA.toLowerCase(),
  );

  if (!targetSchema) {
    console.log(`Schema "${TARGET_SCHEMA}" not found`);
    console.log('Available schemas:', cloudConfig.schemas.map(s => s[1]?.name).filter(Boolean).join(', '));
    process.exit(1);
  }

  const schemaData = targetSchema[1];
  console.log(
    `\n=== Schema: ${schemaData.name} (${schemaData.objectSchemaKey}) ===\n`,
  );

  // Check if objectTypes exists
  if (!schemaData.objectTypes) {
    console.log("❌ No objectTypes found in schema data");
    console.log("Available properties:", Object.keys(schemaData));
    process.exit(1);
  }

  // Specify which object types to inspect - change these to match your schema
  const targetObjectTypes = process.argv.slice(3).length > 0
    ? process.argv.slice(3)
    : schemaData.objectTypes.map(ot => ot.name);

  for (const objTypeName of targetObjectTypes) {
    const objType = schemaData.objectTypes.find(
      (ot) => ot.name === objTypeName,
    );

    if (!objType) {
      console.log(`\n❌ Object Type "${objTypeName}" not found\n`);
      continue;
    }

    console.log(`\n--- Object Type: ${objType.name} ---`);
    console.log(
      `Attributes: ${objType.attributes ? objType.attributes.length : 0}`,
    );
    console.log("");

    // Display all attributes
    if (objType.attributes) {
      objType.attributes.forEach((attr) => {
        console.log(`  ID: ${attr.id.padEnd(8)} | Name: "${attr.name}"`);
      });
    }
  }

  // Now search for the specific failing field names
  console.log(`\n=== SEARCHING FOR FAILING FIELDS ===\n`);

  // Specify fields to search for - customize these with your failing field IDs/names
  // Usage: node check_cloud_attrs.js "Schema Name" "ObjectType1" "ObjectType2"
  const failingFields = [
    // Add your failing fields here, e.g.:
    // { id: 8863, name: "Name of the Item" },
    // { id: 8872, name: "Verification Open Points" },
  ];

  for (const field of failingFields) {
    console.log(
      `\n--- Searching for DC Field: ${field.id} - "${field.name}" ---\n`,
    );

    let foundInCloud = false;

    // Check all object types in the target schema
    for (const objType of schemaData.objectTypes) {
      // Search by ID
      const matchById = objType.attributes.find(
        (a) => a.id === field.id.toString(),
      );
      if (matchById) {
        console.log(
          `✅ Found in ${objType.name} by ID: "${matchById.name}" (ID: ${matchById.id})`,
        );
        foundInCloud = true;
      }

      // Search by name (exact match)
      const matchByName = objType.attributes.find((a) => a.name === field.name);
      if (matchByName) {
        console.log(
          `✅ Found in ${objType.name} by Name: "${matchByName.name}" (ID: ${matchByName.id})`,
        );
        foundInCloud = true;
      }

      // Search by name (case-insensitive)
      const matchByNameCI = objType.attributes.find(
        (a) => a.name.toLowerCase() === field.name.toLowerCase(),
      );
      if (matchByNameCI && matchByNameCI.name !== field.name) {
        console.log(
          `✅ Found in ${objType.name} by Name (case-insensitive): "${matchByNameCI.name}" (ID: ${matchByNameCI.id})`,
        );
        foundInCloud = true;
      }
    }

    if (!foundInCloud) {
      console.log(`❌ NOT FOUND in cloud configuration`);
    }
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
