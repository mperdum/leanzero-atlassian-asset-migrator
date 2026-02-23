# LeanZero Atlassian Asset Migrator

A comprehensive toolkit for migrating Jira Assets (formerly Insight) from Jira Datacenter to Jira Cloud. Handles object schemas, object types, attributes, references, attachments, and ticket associations.

## Architecture

```
.
├── asset-migration-script/       # Core migration engine
│   ├── main.js                   # Entry point
│   ├── modules/                  # Migration modules
│   └── .env.example              # Configuration template
│
└── standalone-utilities/         # Supporting tools
    ├── automation-service/       # Jira automation rule migrator (CLI)
    ├── cloud_asset_ingestion/    # CSV-to-Cloud Assets ingestion
    ├── connect_assets_tickets/   # Ticket-to-asset connection utility
    ├── get_datacenter/           # Datacenter data extraction (shell)
    ├── upload_attachment_assets/ # Attachment upload utility
    ├── sync_comment_visibility/  # Comment visibility sync
    └── src_misc/                 # Admin utilities (cleanup, role assignment)
```

## Quick Start

### 1. Extract data from Datacenter

```bash
cd standalone-utilities/get_datacenter
# Edit main/datacenter_common.sh with your credentials
bash main/get_datacenter_assets.sh
```

### 2. Configure Cloud credentials

```bash
cd asset-migration-script
cp .env.example .env
# Edit .env with your Jira Cloud credentials
```

### 3. Run the migration

```bash
cd asset-migration-script
npm install
node main.js
```

## Features

- **Schema-aware migration** - Preserves object type hierarchies, attributes, and cross-schema references
- **Dependency resolution** - Automatically resolves and creates referenced objects in the correct order
- **Attachment support** - Uploads datacenter attachments to migrated cloud objects
- **Ticket connections** - Links Jira tickets to their corresponding cloud assets via custom fields
- **Resumable** - Tracks progress and can resume interrupted migrations
- **Dry-run mode** - Test migrations without creating objects
- **Multi-token parallel processing** - Supports multiple API tokens for higher throughput
- **Intelligent auto-fixes** - Handles attribute type mismatches, text truncation, and reference resolution

## Configuration

See `asset-migration-script/.env.example` for all available options. Key settings:

| Variable | Description |
|----------|-------------|
| `CLOUD_BASE_URL` | Your Jira Cloud instance URL |
| `CLOUD_API_TOKEN` | Base64 encoded `email:api_token` |
| `WORKSPACE_ID` | Jira Cloud Assets workspace ID |
| `DRY_RUN` | Test without creating objects |
| `SCHEMA_FILTER` | Migrate only a specific schema |
| `UPLOAD_ATTACHMENTS` | Enable attachment migration |
| `CONNECT_TICKETS_TO_OBJECTS` | Enable ticket connections |

## Standalone Utilities

Each utility in `standalone-utilities/` has its own README with usage instructions. These tools can be used independently for specific tasks:

- **automation-service** - Migrate Jira automation rules between instances
- **cloud_asset_ingestion** - Bulk-import assets from CSV files
- **connect_assets_tickets** - Connect Jira tickets to existing cloud assets
- **get_datacenter** - Extract data from Jira Datacenter via REST API
- **upload_attachment_assets** - Upload attachments to existing cloud objects
- **sync_comment_visibility** - Sync comment visibility settings to cloud
- **src_misc** - Admin utilities (bulk role assignment, object cleanup)

## License

MIT
