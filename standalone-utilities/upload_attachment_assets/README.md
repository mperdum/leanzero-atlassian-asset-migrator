# Upload Attachment Assets

This folder contains scripts for uploading attachments to existing Assets objects in Jira Service Management Cloud.

## Configuration

All scripts use the root `.env` file located at: `standalone-utilities/.env`

The `.env` file must contain:
- `JIRA_BASE_URL` - Your Jira Cloud instance URL
- `JIRA_EMAIL` - Email for Jira authentication
- `JIRA_API_TOKEN` - API token for authentication
- `WORKSPACE_ID` - Assets workspace ID
- `OBJECT_TYPE_ID` - Object type ID for the assets
- Attachment field configuration

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
