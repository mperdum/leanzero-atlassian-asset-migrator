# Sync Comment Visibility

Synchronizes comment visibility settings from Jira Datacenter to Jira Cloud.

## Architecture

This uses a two-step process:

1. **Bash script** (runs behind firewall) - Extracts comment visibility data from Datacenter
2. **Node.js script** (runs anywhere) - Updates Cloud comments using parallel workers

## Step 1: Extract from Datacenter

Run this on a machine with access to Datacenter:

```bash
cd standalone-utilities/get_datacenter/main
bash get_datacenter_comment_visibility.sh
```

### Options

```bash
# Custom JQL filter
JQL_QUERY="project = PROJ ORDER BY key ASC" bash get_datacenter_comment_visibility.sh

# Adjust parallel workers (default: 10)
PARALLEL_WORKERS=20 bash get_datacenter_comment_visibility.sh

# Adjust batch size (default: 1000)
DC_MAX_RESULTS=500 bash get_datacenter_comment_visibility.sh

# Process all projects (default: JSM/service_desk projects only)
JSM_ONLY=false bash get_datacenter_comment_visibility.sh

# Exclude specific projects (comma-separated)
EXCLUDE_PROJECTS="PROJ1,PROJ2,OLDPROJECT" bash get_datacenter_comment_visibility.sh
```

### Project Filtering

By default, the script only processes **JSM (Jira Service Management)** projects since comment visibility is primarily a JSM feature. The script:

1. Fetches all projects from `/rest/api/2/project`
2. Filters for `projectTypeKey == "service_desk"`
3. Builds a JQL query targeting only those projects

**Note:** Archived projects are automatically excluded by the Jira API (they are not returned by the `/rest/api/2/project` endpoint).

To manually exclude additional projects (e.g., inactive projects that aren't formally archived):

```bash
EXCLUDE_PROJECTS="OLD_PROJECT,TEST_PROJECT" bash get_datacenter_comment_visibility.sh
```

### Output

Creates JSON file in `datacenter_assets/comment_visibility/`:

```json
{
  "extractedAt": "2024-01-15T10:30:00Z",
  "totalIssues": 220000,
  "totalComments": 500000,
  "commentsWithVisibility": 50000,
  "commentsPublic": 450000,
  "commentsByType": {
    "role": 30000,
    "group": 15000,
    "sdInternal": 5000
  },
  "comments": [
    {
      "issueKey": "PROJ-123",
      "commentId": "10001",
      "created": "2024-01-01T10:00:00.000+0000",
      "visibility": {"type": "role", "value": "Administrators"}
    }
  ]
}
```

## Step 2: Sync to Cloud

Transfer the JSON file to a machine with Cloud access, then run:

```bash
cd standalone-utilities/sync_comment_visibility/main
node sync_comment_visibility_to_cloud.js --input /path/to/dc_comment_visibility.json
```

### Options

```bash
# Dry run (preview changes)
node sync_comment_visibility_to_cloud.js --input data.json --dry-run

# More parallel workers (default: 10)
node sync_comment_visibility_to_cloud.js --input data.json --workers 20

# Limit for testing
node sync_comment_visibility_to_cloud.js --input data.json --limit 100

# Filter by visibility type
node sync_comment_visibility_to_cloud.js --input data.json --filter-type role
```

### Multi-API-Key Support

For higher throughput, add multiple API keys to `.env`:

```bash
CLOUD_API_TOKEN=base64_encoded_email:token
CLOUD_API_TOKEN_2=base64_encoded_email2:token2
CLOUD_API_TOKEN_3=base64_encoded_email3:token3
```

Each worker rotates through available API keys. When one hits rate limits, others continue.

### Output

Logs are written to `sync_comment_visibility/logs/`:
- `sync_visibility_<timestamp>.log` - Full execution log
- `sync_results_<timestamp>.json` - Results with updated/failed comments

## Visibility Types

| DC Type | Cloud Mapping |
|---------|---------------|
| `role` | Maps directly with `identifier` field |
| `group` | Maps directly with `identifier` field |
| `sd.internal` | **Skipped** - see note below |
| `null` | Public comment (no visibility restriction) |

### JSM Internal Comments

JSM internal comments (`sd.internal` type) use a different mechanism than standard visibility:

- **DC**: Uses `sd.public.comment` property with `{"internal": true}`
- **Cloud**: Uses JSM Service Desk API with `public: false` parameter

These comments **cannot be synced** via the standard Jira visibility API. Internal vs public comment status should be preserved during the initial Jira DC→Cloud migration, not via this sync tool.

If you have internal comments that were incorrectly migrated as public, you would need to use the JSM Service Desk API (`/rest/servicedeskapi/request/{issueKey}/comment`) to recreate them.

## Requirements

### Bash Script (Datacenter)
- bash 3.2+
- curl
- jq
- Network access to Datacenter

### Node.js Script (Cloud)
- Node.js 14+
- Network access to Cloud
- `.env` file with `CLOUD_API_TOKEN` and `CLOUD_BASE_URL`

## Performance

With 10 parallel workers:
- ~100-200 comments/second (depends on API rate limits)
- 220k issues with 500k comments: ~1-2 hours

Tips for large instances:
- Use multiple API keys for higher throughput
- Run DC extraction overnight (it's I/O bound)
- Start with `--dry-run` to verify matches
