# Connect Assets Tickets

This folder contains scripts for connecting Jira tickets to Assets objects in Jira Service Management Cloud.

## Configuration

All scripts use the root `.env` file located at: `standalone-utilities/.env`

The `.env` file must contain:
- `JIRA_BASE_URL` - Your Jira Cloud instance URL
- `JIRA_EMAIL` - Email for Jira authentication
- `JIRA_API_TOKEN` - API token for authentication
- `WORKSPACE_ID` - Assets workspace ID
- `OBJECT_TYPE_ID` - Object type ID for the assets
- Custom field configuration for ticket connections

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
