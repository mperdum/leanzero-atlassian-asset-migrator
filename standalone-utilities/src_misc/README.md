# Miscellaneous Utilities

Standalone Jira Cloud administration scripts for one-off tasks.

## Prerequisites

- Node.js 18+
- Configured `standalone-utilities/.env` (see `standalone-utilities/.env.example`)

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
