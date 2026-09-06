# Jira Assets DC-to-Cloud Migration Toolkit

Welcome to the Jira Assets DC-to-Cloud Migration Toolkit. This is a comprehensive solution for migrating Jira Assets (formerly Insight) from Jira Datacenter to Jira Cloud. The toolkit handles object schemas, object types, attributes, references, attachments, and ticket associations with intelligent dependency resolution and resumable operations.

The system is designed to handle complex enterprise migrations while preserving data integrity, object relationships, and attachment continuity. Whether you are migrating a single schema or an entire Assets workspace, this toolkit provides the tools you need for a successful transition.

## About LeanZero

This project is part of the LeanZero ecosystem, focused on building tools that help developers work more efficiently with Jira migrations, asset management, and enterprise workflows. For more information about our work, additional resources, tutorials, and community discussions, visit [leanzero.net](https://leanzero.net). You can also join our Discord community directly from the website for conversations with other developers working on similar projects.

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

### Comment Visibility Sync

The sync_comment_visibility utility carries per-comment visibility settings from Datacenter to Cloud. It runs in two steps: a bash script extracts the visibility data from Datacenter (so it can run behind the firewall), and a Node script updates the Cloud comments using parallel workers.

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
| `asset-migration-script/.env` | Core migration, connect_assets_tickets |
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

`get_datacenter_assets.sh` is the only extract you always need — it pulls the schemas, object types, objects, attributes and references that the migration engine reads. Run the others only for the features you intend to enable:

| Script | Extracts | Needed for |
|--------|----------|------------|
| `get_datacenter_assets.sh` | Schemas, object types, objects, attributes, references | **Always** |
| `get_datacenter_attachments.sh` | Object attachments | `UPLOAD_ATTACHMENTS=true`, or `upload_attachment_assets` |
| `get_datacenter_ticket_associations.sh` | Ticket-to-object custom field values | `CONNECT_TICKETS_TO_OBJECTS=true`, or `connect_assets_tickets` |
| `get_datacenter_comment_visibility.sh` | Per-comment visibility settings | `sync_comment_visibility` |
| `generate_automation_mapping.sh` | Source data for automation rule mapping | `automation-service` |

Keep the export. Extraction is the slow part, and every dry run, retry and troubleshooting session afterwards reads it rather than Datacenter — re-extracting because the directory was deleted costs hours nobody budgets for.

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

Every setting has both a CLI flag and an environment variable, and the flag wins when both are present. See `asset-migration-script/.env.example` for the full list. Here are the key settings:

| Variable | CLI flag | Description |
|----------|----------|-------------|
| `CLOUD_BASE_URL` | — | Your Jira Cloud domain, without `https://` (e.g. `your-domain.atlassian.net`) |
| `CLOUD_API_TOKEN` | — | Base64 of `email:api_token`. Not the raw token — this is the most common setup error, and it presents as a `401` that looks like an expired token |
| `WORKSPACE_ID` | — | Jira Cloud Assets workspace UUID |
| `DRY_RUN` | `--dry-run` | Validate and report; create nothing |
| `SCHEMA_FILTER` | `--schema <name>` | Migrate one schema. Use it — a failure inside one schema is diagnosable |
| `TYPE_FILTER` | `--type <name>` | One object type within the schema |
| `LIMIT_PER_TYPE` | `--limit <n>` | Cap objects per type. The smoke-test lever |
| `UPLOAD_ATTACHMENTS` | `--upload-attachments` | Upload attachments during the run |
| `CONNECT_TICKETS_TO_OBJECTS` | `--connect-tickets` | Link tickets to objects during the run |
| `AUTO_CREATE_OBJECT_TYPES` | `--auto-create-types` | Create missing object types rather than failing (default on) |
| `AUTO_CREATE_REFERENCES` | `--auto-create-refs` | Create missing referenced objects (default on) |
| `DATACENTER_ANALYSIS` | `--analyze-dc` | Report DC-versus-Cloud configuration differences. Run this before migrating |
| `CLEANUP_OBJECTS` | `--cleanup-objects` | **Deletes all objects from the Cloud workspace before migrating.** Sandbox only |

Leave `SKIP_VALIDATION_ERRORS`, `IGNORE_MISSING_REQUIRED` and `ALLOW_PARTIAL_MIGRATION` at their defaults. Each one turns a loud failure into a quiet, half-migrated object. They exist for specific recovery situations; none of them belongs in a production `.env`.

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
| **sync_comment_visibility** | Sync per-comment visibility from Datacenter to Cloud |
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
    ├── sync_comment_visibility/  # Per-comment visibility sync
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

### Know The Recovery Scripts Before You Need Them

`asset-migration-script/` ships five helpers that turn a failed run into a diagnosable one. Migration state is checkpointed in `logs/migration_plan.json`, so a crashed run is resumed by re-running — already-created objects are skipped, and no duplicates are produced.

| Script | What it does |
|--------|--------------|
| `analyze_failures.js` | Reads the plan and reports every object with status `failed`, grouped so you can see whether it is one cause or fifty |
| `simple_analyze_failures.js` | The terse version, for a quick count |
| `reset_failed_to_pending.js` | Flips `failed` rows back to `pending` so the next run retries them. Run it **after** fixing the cause, not instead of |
| `check_cloud_attrs.js` | Dumps the Cloud attribute configuration for a schema — the fastest way to see why an attribute write was rejected |
| `fix_mapping.js` | Repairs `created_objects_mapping.json` when an object is marked created in the plan but never made it into the mapping |

Never reset failures to pending before you know why they failed. A retry against an unchanged cause produces the same failures plus wasted API budget, and the second run's log makes the first one harder to read.

### Verify In The Assets UI, Not In The Run Summary

Pick ten objects **before** the run — the deepest hierarchy, one with cross-schema references, one with attachments — and write down what each should contain. Afterwards, open them in the Assets UI and check every attribute, then click a reference and confirm it lands on the right object. Count per object type, DC against Cloud. Open a ticket that referenced an asset and confirm the custom field points at the migrated object. Download an attachment.

"20,000 objects created" is a proxy metric. It is entirely compatible with 20,000 objects whose references are empty, which is the same as no migration at all for anyone who uses the data.

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

For support, additional resources, and community discussions, visit [leanzero.net](https://leanzero.net).

## License

MIT