# Connect Assets Tickets

Connects Jira tickets to existing Assets objects in Jira Service Management Cloud using custom field mappings.

The core migration script has a built-in ticket connection phase (`CONNECT_TICKETS_TO_OBJECTS=true`), but this standalone utility exists for cases where you need to run ticket connections independently -- for example, after a migration has already completed, when re-linking tickets after schema changes, or when connecting tickets that were migrated separately from the assets.

## Prerequisites

- Node.js 18+
- The `asset-migration-script/` dependencies installed (`cd asset-migration-script && npm install`)

## Configuration

This utility loads its environment from `asset-migration-script/.env`. If you've already configured the core migration script, no additional setup is needed.

If you haven't yet:

```bash
cp asset-migration-script/.env.example asset-migration-script/.env
# Edit with your CLOUD_BASE_URL, CLOUD_API_TOKEN, WORKSPACE_ID
```

Required variables (in `asset-migration-script/.env`):

| Variable | Description |
|----------|-------------|
| `CLOUD_BASE_URL` | Your Jira Cloud instance URL |
| `CLOUD_API_TOKEN` | Base64 encoded `email:api_token` |
| `WORKSPACE_ID` | Assets workspace ID |

Optional (for parallel processing with multiple workers):

| Variable | Description |
|----------|-------------|
| `CLOUD_API_TOKEN_2` | Additional API token for a second parallel worker |
| `CLOUD_API_TOKEN_3` | Additional API token for a third parallel worker |

## Logs

All scripts write logs to: `connect_assets_tickets/logs/`

## Folder Structure

### main/
Contains the primary workflow scripts:

- **connect_tickets_to_existing_objects.js** - Main script that connects Jira tickets to existing Assets objects based on a mapping file. Handles batching, retries, and progress tracking.

### utils/
Contains supporting utilities for managing, analyzing, and retrying connections:

- **ticketConnectionPlanManager.js** - Manages connection state, batching, and progress tracking for the main connection script
- **reset_failed_ticket_connections.js** - Resets failed ticket connections back to pending status for retry
- **reset_failed_to_pending.js** - Alternative script to reset failed connections to pending
- **analyze_failures.js** - Analyzes failure logs to identify patterns and common error types
- **analyze_field_errors.js** - Analyzes field-specific errors from connection attempts
- **parse_failures.js** - Parses and categorizes failures from log files for easier troubleshooting
- **overall_progress.js** - Shows overall progress statistics for ticket connections

## Usage

### Running the main connection script:
```bash
cd standalone-utilities/connect_assets_tickets/main
node connect_tickets_to_existing_objects.js
```

### Analyzing failures:
```bash
cd standalone-utilities/connect_assets_tickets/utils
node analyze_failures.js
```

### Resetting failed connections:
```bash
cd standalone-utilities/connect_assets_tickets/utils
node reset_failed_ticket_connections.js
```

### Checking overall progress:
```bash
cd standalone-utilities/connect_assets_tickets/utils
node overall_progress.js
```

## Workflow

1. Prepare your ticket-to-object mapping file
2. Run `connect_tickets_to_existing_objects.js` to start connecting tickets
3. Monitor logs in `logs/` folder
4. If failures occur, use `analyze_failures.js` or `analyze_field_errors.js` to identify issues
5. Fix any configuration or data issues
6. Use `reset_failed_ticket_connections.js` to reset failed items
7. Re-run the main script to retry failed connections
8. Check progress with `overall_progress.js`

## Limitations

- Requires a pre-built ticket-to-object mapping file (produced by the datacenter extraction scripts or the core migration).
- Custom field IDs for the ticket-asset link must be configured manually in `.env` -- these differ per Jira instance.
- Uses a single API token by default. For large-scale runs (100k+ tickets), throughput is limited by Jira API rate limits. The core migration script's multi-token support is not available here.
