# Jira Assets DC-to-Cloud Migration Toolkit

Welcome to the Jira Assets DC-to-Cloud Migration Toolkit. This is a comprehensive solution for migrating Jira Assets (formerly Insight) from Jira Datacenter to Jira Cloud. The toolkit handles object schemas, object types, attributes, references, attachments, and ticket associations with intelligent dependency resolution and resumable operations.

The system is designed to handle complex enterprise migrations while preserving data integrity, object relationships, and attachment continuity. Whether you are migrating a single schema or an entire Assets workspace, this toolkit provides the tools you need for a successful transition.

## About LeanZero

This project is part of the LeanZero ecosystem, focused on building tools that help developers work more efficiently with Jira migrations, asset management, and enterprise workflows. For more information about our work, additional resources, tutorials, and community discussions, visit [leanzero.atlascrafted.com](https://leanzero.atlascrafted.com). You can also join our Discord community directly from the website for conversations with other developers working on similar projects.

## What This Project Can Do For You

Think of this toolkit as your migration companion that handles the heavy lifting of moving your Assets data from Datacenter to Cloud. Here is what it handles:

### Core Migration Engine

The asset-migration-script is the heart of the toolkit. It handles the complete migration workflow from reading exported Datacenter data to creating objects in your Cloud instance. The engine processes object schemas, object types, attributes, and references while maintaining all relationships between objects.

The migration is schema-aware, meaning it understands the hierarchies and dependencies in your Assets structure. It automatically resolves references and creates objects in the correct order to satisfy dependencies. If a migration is interrupted, it can resume from where it left off without duplicating work.

### Attachment Migration

The system can upload attachments from your Datacenter instance to the migrated Cloud objects. This preserves document history, images, and other files that are associated with your assets. The attachment utility handles file uploads with proper error handling and retry logic.

### Ticket-to-Asset Connections

If your Jira tickets have custom fields that reference Assets objects, the connect_assets_tickets utility can re-establish these connections in Cloud. It reads the ticket data from Datacenter and updates the corresponding custom fields in Cloud to point to the newly migrated objects.

### Automation Rule Migration

The automation-service utility helps migrate Jira automation rules between instances. This is useful when your Assets-related automations need to be recreated in Cloud with updated references to the new object IDs.

### Datacenter Data Extraction

The get_datacenter utility provides shell scripts for extracting Assets data from your Datacenter instance via REST API. These scripts export schemas, object types, objects, attributes, and references to JSON files that the migration engine can process.

### CSV-Based Bulk Ingestion

If you prefer to import assets from CSV files rather than from Datacenter exports, the cloud_asset_ingestion utility can bulk-create objects from spreadsheet data. This is useful for initial data loading or for importing data from external systems.

### Admin Utilities

The src_misc directory contains various admin utilities for tasks like bulk role assignment and object cleanup. These are helper scripts for common administrative operations that may be needed during or after migration.

## Getting Started With The System

Getting the migration toolkit running on your machine is straightforward. You will need Node.js installed, and then you can set up the environment to work with your Jira instances.

### Prerequisites

Before you begin, make sure you have the following:

- **Node.js 18+** installed (`node --version` to check)
- **Jira Cloud** instance with Assets (formerly Insight) enabled
- **Jira Datacenter** instance with REST API access (for extraction scripts)
- **bash, curl, jq** for datacenter extraction shell scripts (macOS/Linux/WSL)

### Installing The Dependencies

First, clone the repository and install the required packages. Open your terminal or command prompt and navigate to the project directory:

```bash
cd asset-migration-script
npm install
```

This will install all the libraries that handle API communication, file processing, and the various utilities that the system uses.

### Setting Up Credentials

#### Create an Atlassian API Token

Go to [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) and create a new API token. Then base64-encode it with your email:

```bash
echo -n "your-email@example.com:your-api-token" | base64
```

Use the output as the value for `CLOUD_API_TOKEN` in your `.env` files.

#### Find Your Assets Workspace ID

Open your browser's developer tools and navigate to:

```
https://your-domain.atlassian.net/rest/servicedeskapi/assets/workspace
```

The `workspaceId` field in the JSON response is the UUID you need for `WORKSPACE_ID`.

#### Configure Environment Files

This project uses two `.env` files in different locations:

| `.env` File Location | Used By |
|----------------------|---------|
| `asset-migration-script/.env` | Core migration, cloud_asset_ingestion, connect_assets_tickets |
| `standalone-utilities/.env` | src_misc, upload_attachment_assets |

Most users should start by creating the core `.env`:

```bash
cp asset-migration-script/.env.example asset-migration-script/.env
# Edit with your CLOUD_BASE_URL, CLOUD_API_TOKEN, and WORKSPACE_ID
```

### Quick Start Migration

#### Step 1: Extract Data from Datacenter

```bash
cd standalone-utilities/get_datacenter
# Edit main/datacenter_common.sh with your DC credentials
bash main/get_datacenter_assets.sh
```

This creates a `datacenter_assets/` directory at the project root with the exported data.

#### Step 2: Configure Cloud Credentials

```bash
cd asset-migration-script
cp .env.example .env
# Edit .env -- at minimum set CLOUD_BASE_URL, CLOUD_API_TOKEN, WORKSPACE_ID
```

#### Step 3: Run the Migration

```bash
cd asset-migration-script
npm install
node main.js --dry-run    # Test first without creating objects
node main.js              # Production run
```

## Configuration Options

See `asset-migration-script/.env.example` for all available options. Here are the key settings:

| Variable | Description |
|----------|-------------|
| `CLOUD_BASE_URL` | Your Jira Cloud instance URL (e.g. `your-domain.atlassian.net`) |
| `CLOUD_API_TOKEN` | Base64 encoded `email:api_token` |
| `WORKSPACE_ID` | Jira Cloud Assets workspace ID (UUID) |
| `DRY_RUN` | Test without creating objects (`true`/`false`) |
| `SCHEMA_FILTER` | Migrate only a specific schema by name |
| `UPLOAD_ATTACHMENTS` | Enable attachment migration (`true`/`false`) |
| `CONNECT_TICKETS_TO_OBJECTS` | Enable ticket connections (`true`/`false`) |

### Advanced Options

For larger migrations, you can configure parallel processing:

- `MAX_CONCURRENT_REQUESTS`: Control API concurrency (default: 5)
- `MULTI_TOKEN_MODE`: Enable multi-token parallel processing
- `TOKEN_1` through `TOKEN_5`: Additional API tokens for higher throughput

## Standalone Utilities

Each utility in `standalone-utilities/` has its own README with detailed usage instructions. These tools can be used independently for specific tasks:

| Utility | Purpose |
|---------|---------|
| **automation-service** | Migrate Jira automation rules between instances (CLI-based) |
| **cloud_asset_ingestion** | Bulk-import assets from CSV files |
| **connect_assets_tickets** | Connect Jira tickets to existing cloud assets |
| **get_datacenter** | Extract data from Jira Datacenter via REST API |
| **upload_attachment_assets** | Upload attachments to existing cloud objects |
| **src_misc** | Admin utilities (bulk role assignment, object cleanup) |

### Utility Configuration Notes

Utilities with separate configuration:
- **automation-service** uses CLI arguments, no `.env` file needed
- **get_datacenter** requires editing `main/datacenter_common.sh` directly

## Key Features

### Schema-Aware Migration

The toolkit preserves object type hierarchies, attributes, and cross-schema references. It understands the structure of your Assets data and maintains integrity throughout the migration.

### Dependency Resolution

Referenced objects are automatically resolved and created in the correct order. The system analyzes dependencies and ensures that objects referenced by other objects exist before creating the dependent objects.

### Resumable Operations

Migration progress is tracked and can resume interrupted migrations. If a migration fails or is stopped, you can restart it without duplicating already-created objects.

### Dry-Run Mode

Test migrations without creating objects. The dry-run mode validates your configuration and shows what would be created, helping you catch issues before the actual migration.

### Multi-Token Parallel Processing

For higher throughput, the system supports multiple API tokens. This allows parallel API calls while respecting rate limits, significantly speeding up large migrations.

### Intelligent Auto-Fixes

The system handles common issues automatically:
- Attribute type mismatches are converted where possible
- Text fields are truncated to maximum lengths
- Reference resolution errors are logged with suggestions

### Attachment Support

Upload Datacenter attachments to migrated Cloud objects. The system handles file uploads with proper error handling and maintains the association between objects and their attachments.

## Project Architecture

The project is organized with clear separation of concerns:

```
.
├── asset-migration-script/       # Core migration engine
│   ├── main.js                   # Entry point
│   ├── modules/                  # Migration modules
│   └── .env.example              # Configuration template
│
└── standalone-utilities/         # Supporting tools
    ├── automation-service/       # Jira automation rule migrator
    ├── cloud_asset_ingestion/    # CSV-to-Cloud ingestion
    ├── connect_assets_tickets/   # Ticket-to-asset connections
    ├── get_datacenter/           # Datacenter extraction (shell)
    ├── upload_attachment_assets/ # Attachment upload utility
    └── src_misc/                 # Admin utilities
```

### How The Migration Engine Works

The migration engine follows a systematic process:

1. **Schema Discovery**: Reads exported Datacenter schemas and analyzes their structure
2. **Type Mapping**: Maps Datacenter object types to Cloud-compatible formats
3. **Dependency Analysis**: Identifies object dependencies and determines creation order
4. **Object Creation**: Creates objects in Cloud with proper attribute values
5. **Reference Resolution**: Updates references between objects after creation
6. **Attachment Upload**: Uploads associated attachments to created objects
7. **Ticket Connection**: Links Jira tickets to migrated objects via custom fields

## Best Practices For Using The System

Here are recommendations based on successful migrations:

### Always Start with Dry-Run

Before running a production migration, always use `--dry-run` mode. This validates your configuration and shows what will be created without actually making changes.

### Migrate in Batches

For large datasets, consider using `SCHEMA_FILTER` to migrate one schema at a time. This makes it easier to identify and fix issues without affecting the entire migration.

### Verify Credentials Early

Make sure your API token has the necessary permissions before starting. The token needs access to Assets and the ability to create objects in the target workspace.

### Keep Datacenter Exports

Save your Datacenter exports in case you need to re-run the migration. The export process can take time, and having the data available makes troubleshooting easier.

### Monitor Rate Limits

Jira Cloud has API rate limits. If you encounter rate limit errors, reduce `MAX_CONCURRENT_REQUESTS` or enable multi-token mode with additional tokens.

### Test with a Small Dataset First

Before migrating your entire Assets workspace, test with a single schema or a small subset of objects. This helps you validate your configuration and estimate migration time.

### Review Logs Carefully

The migration logs contain detailed information about each operation. Review them after dry-runs to understand what will happen and after production runs to verify success.

## Troubleshooting Common Issues

### Authentication Errors

If you see 401 or 403 errors, verify that:
- Your API token is valid and not expired
- The base64 encoding includes both email and token with a colon separator
- Your user has Assets admin permissions in the Cloud instance

### Object Creation Failures

If objects fail to create:
- Check that all required attributes have values
- Verify that referenced objects exist or will be created first
- Look for attribute type mismatches in the logs

### Rate Limit Errors

If you encounter rate limits:
- Reduce `MAX_CONCURRENT_REQUESTS` in your `.env` file
- Wait a few minutes before retrying
- Consider using multi-token mode for higher limits

### Missing References

If references are not resolved:
- Ensure the referenced objects were successfully created
- Check that reference attributes are configured correctly
- Verify that the reference object type exists in Cloud

### Attachment Upload Failures

If attachments fail to upload:
- Check that the attachment files exist in the expected location
- Verify file size limits for Assets attachments
- Ensure the target object was created successfully

## Current Capabilities And Limitations

### What The System Does Well

The migration engine handles most common Assets data structures effectively. Object type hierarchies with complex attribute configurations migrate correctly. References between objects in the same schema or across schemas are preserved. The resumable operation feature makes it reliable for large migrations.

### Known Limitations

Some Datacenter-specific features may not have Cloud equivalents. User references may need manual adjustment if users have different account IDs in Cloud. Complex automation rules with Assets triggers may require manual recreation. Historical data and audit logs are not migrated.

### Potential Future Enhancements

There are opportunities to extend the toolkit further. A web-based UI could provide visual migration progress. Pre-migration validation could identify issues before any changes are made. Automated rollback capabilities could help recover from failed migrations.

## Conclusion

The Jira Assets DC-to-Cloud Migration Toolkit provides a comprehensive solution for migrating your Assets data from Datacenter to Cloud. With intelligent dependency resolution, resumable operations, and comprehensive logging, it handles the complexity of enterprise migrations while giving you control over the process. Whether you are migrating a single schema or an entire workspace, this toolkit gives you the tools to do it effectively.

For support, additional resources, and community discussions, visit [leanzero.atlascrafted.com](https://leanzero.atlascrafted.com).

## License

MIT