# Upload Attachment Assets

Uploads file attachments to existing Assets objects in Jira Service Management Cloud.

The core migration script has a built-in attachment upload phase (`UPLOAD_ATTACHMENTS=true`), but this standalone utility exists for cases where attachments need to be uploaded independently -- for example, when the migration ran without attachments enabled, when re-uploading after a schema reset, or when attaching files from a different source than the original datacenter export.

## Prerequisites

- Node.js 18+
- The `asset-migration-script/` dependencies installed (`cd asset-migration-script && npm install`)

## Configuration

This utility loads its environment from `standalone-utilities/.env`.

If you haven't created it yet:

```bash
cp standalone-utilities/.env.example standalone-utilities/.env
# Edit with your CLOUD_BASE_URL, CLOUD_API_TOKEN, WORKSPACE_ID
```

Required variables (in `standalone-utilities/.env`):

| Variable | Description |
|----------|-------------|
| `CLOUD_BASE_URL` | Your Jira Cloud instance URL |
| `CLOUD_API_TOKEN` | Base64 encoded `email:api_token` |
| `WORKSPACE_ID` | Assets workspace ID |

## Logs

All scripts write logs to: `upload_attachment_assets/logs/`

## Folder Structure

### main/
Contains the scripts for attachment upload workflow:

- **upload_attachments_to_existing_objects.js** - Main script that uploads attachments to existing Assets objects. Handles file reading, upload batching, retries, and progress tracking.

- **find_valid_attachments.sh** - Shell script to find and validate attachment files in the file system. Useful for diagnosing missing or invalid attachment paths before running the upload script.

## Usage

### Finding valid attachments:
```bash
cd standalone-utilities/upload_attachment_assets/main
./find_valid_attachments.sh /path/to/attachments/directory
```

### Running the main upload script:
```bash
cd standalone-utilities/upload_attachment_assets/main
node upload_attachments_to_existing_objects.js
```

## Workflow

1. Ensure all attachment files are accessible in your file system
2. Optionally run `find_valid_attachments.sh` to verify attachment paths
3. Prepare your object-to-attachment mapping file
4. Run `upload_attachments_to_existing_objects.js` to start uploading
5. Monitor logs in `logs/` folder for progress and errors
6. If failures occur, check the logs for specific file or permission issues
7. Re-run the script to retry failed uploads (the script tracks completion state)

## Notes

- Attachment files must be accessible from the machine running the script
- The script handles large files and implements retry logic for network failures
- Progress is tracked to allow resuming interrupted upload sessions

## Limitations

- Attachment files must be on the local filesystem (no remote URL support).
- No file type or size validation -- any file the Jira API accepts will be uploaded. Jira Cloud has a per-file size limit (typically 10 MB for free plans, higher for paid).
- Uses a single API token. No multi-token rotation for rate limit mitigation.
- No built-in deduplication -- re-running may create duplicate attachments if the progress state was lost.
