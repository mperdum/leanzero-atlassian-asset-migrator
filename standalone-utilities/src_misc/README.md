# Miscellaneous Utilities

Standalone Jira Cloud administration scripts for one-off tasks.

## Prerequisites

- Node.js 18+
- The `asset-migration-script/` dependencies installed (`cd asset-migration-script && npm install`)
- Configured `standalone-utilities/.env` (see `standalone-utilities/.env.example`):

```bash
cp standalone-utilities/.env.example standalone-utilities/.env
# Edit with your CLOUD_BASE_URL, CLOUD_API_TOKEN, WORKSPACE_ID
```

## Scripts

### add_user_to_all_project_roles.js

Adds a specific user to all roles across all projects in a Jira Cloud instance. Useful for granting a service account or admin user access to every project.

```bash
# Set USER_ACCOUNT_ID in .env or the script, then:
node add_user_to_all_project_roles.js
```

**Required env vars:** `CLOUD_BASE_URL`, `CLOUD_API_TOKEN`, `USER_ACCOUNT_ID`

### cleanup_objects.js

Safely deletes all objects from Jira Cloud Assets object schemas while preserving schema structure (object types, attributes, etc.). Includes dry-run mode and confirmation prompts.

```bash
node cleanup_objects.js --dry-run                     # Test mode (no deletions)
node cleanup_objects.js --confirm                     # Delete with confirmation
node cleanup_objects.js --confirm --schema "MySchema" # Clean specific schema
```

**Required env vars:** `CLOUD_BASE_URL`, `CLOUD_API_TOKEN`, `WORKSPACE_ID`

**Options:**

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be deleted without making changes |
| `--confirm` | Required to actually delete objects |
| `--schema "Name"` | Limit cleanup to a specific schema |
| `--batch-size N` | Number of objects to delete per batch (default: 50) |

## Why Standalone

These are admin utilities that operate on a Jira Cloud instance directly, independent of any migration state. They don't read migration plans or mapping files. They were kept separate from the core migration script because they serve a different purpose: instance administration rather than data migration.
