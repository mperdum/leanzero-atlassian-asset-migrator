const fs = require("fs");

try {
  const cloudConfig = JSON.parse(
    fs.readFileSync("./logs/cloud_configuration.json", "utf8"),
  );

  // Find dico_auto_inventory_tracking schema
  const dicoSchema = cloudConfig.schemas.find(
    (s) => s[1] && s[1].name === "dico auto inventory tracking",
  );

  if (!dicoSchema) {
    console.log('Schema "dico auto inventory tracking" not found');
    process.exit(1);
  }

  const schemaData = dicoSchema[1];
  console.log(
    `\n=== Schema: ${schemaData.name} (${schemaData.objectSchemaKey}) ===\n`,
  );

  // Check if objectTypes exists
  if (!schemaData.objectTypes) {
    console.log("❌ No objectTypes found in schema data");
    console.log("Available properties:", Object.keys(schemaData));
    process.exit(1);
  }

  // Find DAP___Assets and DAW___Assets/ECU object types
  const targetObjectTypes = ["DAP___Assets", "DAW___Assets/ECU"];

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

  const failingFields = [
    { id: 8863, name: "Name of the Item" },
    { id: 8872, name: "Verification Open Points" },
  ];

  for (const field of failingFields) {
    console.log(
      `\n--- Searching for DC Field: ${field.id} - "${field.name}" ---\n`,
    );

    let foundInCloud = false;

    // Check all object types in dico_auto_inventory_tracking
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
