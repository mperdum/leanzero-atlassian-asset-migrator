# Microsoft Graph User Ingestion to Jira Cloud Assets

This script ingests users from Microsoft Graph API (Azure AD) into Jira Cloud Assets as assets. It supports:
- Fetching users with filter `userType eq 'Member'`
- Matching existing users by name and attributes
- Updating existing users when they are modified
- Creating new users as new assets
- Avoiding duplicates

## Prerequisites

- Node.js (v14 or higher)
- Jira Cloud Assets with an appropriate workspace
- Microsoft Entra ID (Azure AD) application with the required permissions
- Environment variables properly configured

## Installation

1. Clone or navigate to this directory
2. Install dependencies:

```bash
npm install
```

## Configuration

### Environment Variables

Create a `.env` file in the root directory (see `.env.example` for reference):

```bash
# Jira Cloud Assets Configuration
WORKSPACE_ID=your_workspace_id
CLOUD_API_TOKEN=your_basic_auth_token  # Base64 encoded email:api_token
CLOUD_BASE_URL=https://api.atlassian.com

# Microsoft Graph API Configuration
MS_CLIENT_ID=your_azure_app_client_id
MS_TENANT_ID=your_azure_tenant_id
MS_CLIENT_SECRET=your_azure_app_client_secret

# Ingestion Configuration
OBJECT_SCHEMA_ID=15
OBJECT_TYPE_ID=153

# Optional
DEBUG=false
```

### Microsoft Graph API Permissions

Your Microsoft Entra ID application must have the following Application permissions:
- `User.Read.All`
- `User.ReadBasic.All`

To add permissions:
1. Go to Azure Portal > App Registrations > Your App
2. Navigate to "API permissions"
3. Click "Add a permission" > "Microsoft Graph" > "Application permissions"
4. Search and add `User.Read.All` and `User.ReadBasic.All`
5. Click "Grant admin consent" for your organization

### Jira Cloud Assets Setup

Ensure your object type (ID 153 in schema ID 15) has the appropriate attributes to store user information. Common attributes include:
- Name/DisplayName
- Email/Mail
- User Principal Name
- Department
- Job Title
- Office Location
- Phone Number

## Usage

### Run the ingestion script

```bash
npm start
```

### Dry run mode (no changes made)

```bash
npm run dry-run
```

### Preview mode (show what would be processed)

```bash
npm run preview
```

### Command line options

```bash
node main/ingest_ms_graph_users.js [options]

Options:
  --dry-run           Process without creating/updating assets
  --preview           Preview users from Microsoft Graph without processing
  --limit <number>    Limit number of users to process (for testing)
  --debug             Enable debug logging
  --mapping <file>    Use custom attribute mapping file
```

## How It Works

1. **Authentication**: Authenticates with Microsoft Graph API using client credentials
2. **Fetch Users**: Retrieves users with filter `userType eq 'Member'`
3. **Query Existing Assets**: Queries Jira Cloud Assets for existing users using AQL
4. **Match Users**: Matches users by name and attributes (displayName, mail, userPrincipalName)
5. **Compare Attributes**: Compares Graph API user data with existing assets to detect changes
6. **Update or Create**: 
   - Updates existing assets if attributes have changed
   - Creates new assets for new users
7. **Avoid Duplicates**: Ensures no duplicate users are created

## User Matching Logic

The script matches users using the following criteria (in order):
1. Exact match by displayName
2. Exact match by mail (email address)
3. Exact match by userPrincipalName
4. Fuzzy match by normalized displayName

If a user is matched, the script compares the attributes and only updates if changes are detected.

## Attribute Mapping

The script automatically maps Microsoft Graph user attributes to Jira Cloud Assets object type attributes by name. The script queries the Cloud Assets API to get the correct attribute IDs based on the attribute names.

### Default Mapping

| Microsoft Graph Attribute | Jira Cloud Assets Attribute |
|-------------------------|----------------------------|
| displayName | Name |
| givenName | Given name |
| surname | Surname |
| userPrincipalName | sAMAccountName |
| jobTitle | Title |
| mail | E-Mail |
| officeLocation | Location |
| companyName | Company |
| department | Department |
| businessPhones | Phone |
| mobilePhone | Mobile |
| accountEnabled | Status |
| id | objectGUID |
| employeeId | employeeID |

**Note:** The following Jira Cloud Assets attributes are not available from Microsoft Graph API and will remain empty:
- Absence
- Manager
- departmentNumber
- lastLogon
- Software Asset Administrator
- userAccountControl
- impNotInInternal
- impNotInExternal
- impNotInUsers
- Review
- Cost centre

### Custom Mapping

You can provide a custom mapping file using the `--mapping` option. The script will use the exact attribute names provided to look up the corresponding IDs from your Jira Cloud Assets object type:

```json
{
  "displayName": "Name",
  "givenName": "Given name",
  "surname": "Surname",
  "userPrincipalName": "sAMAccountName",
  "jobTitle": "Title",
  "mail": "E-Mail"
}
```

Usage:
```bash
npm start -- --mapping mapping/example_mapping.json
```

## Example Output

```
============================================================
Microsoft Graph User Ingestion to Jira Cloud Assets
============================================================

============================================================
Testing connections...
------------------------------------------------------------
  Testing Microsoft Graph connection...
  Connected! Successfully fetched 1 user(s).

  Testing cloud connection...
  Connected! Found X schemas.

  Verifying object type...
  ✓ Found: Users (ID: 153)
============================================================

Loading attribute mapping...
  ✓ Loaded 20 object type attributes
  ✓ Loaded mapping from: mapping/example_mapping.json
  ✓ Mapped 14 Graph attributes to Assets attributes
  ⚠ Unmapped attributes: absence -> Absence, manager -> Manager, ...

============================================================
Starting User Ingestion
------------------------------------------------------------
Target: Schema ID 15, Object Type ID 153
Filter: userType eq 'Member'
Limit: 0 users

Loading attribute mapping...
  ✓ Loaded 20 object type attributes
  ✓ Mapped 14 Graph attributes to Assets attributes

Fetching users from Microsoft Graph...
✓ Fetched 150 users from Microsoft Graph

Querying existing users from Cloud Assets...
  ✓ Found 85 existing users
  ✓ Built lookup index for 170 identifiers

Processing Users...
------------------------------------------------------------

[1/150] Processing: John Doe
  Email: john.doe@example.com
  UPN: john.doe@domain.com
  → MATCHED: 2 change(s) detected
     - Title: "Software Engineer" → "Senior Software Engineer"
     - Department: "Engineering" → "Product Development"
  ✓ Updated successfully (USER-123)

[2/150] Processing: Jane Smith
  Email: jane.smith@example.com
  UPN: jane.smith@domain.com
  → MATCHED: No changes detected

[3/150] Processing: Bob Johnson
  Email: bob.johnson@example.com
  UPN: bob.johnson@domain.com
  → NEW: Creating as new asset
  ✓ Created successfully (USER-124)

============================================================
Ingestion Summary
============================================================
Duration: 2m 34s

Users:
  Total users fetched: 150
  Existing users matched: 85
  New users created: 65
  Existing users updated: 18
  Users skipped (dry-run/no changes): 0
  Users failed: 0

API Statistics:
  Microsoft Graph API: 5 requests, 0 errors (0.00%)
  Jira Cloud Assets API: 218 requests, 0 errors (0.00%)

Report saved to: /path/to/logs/ingestion-report-2024-01-15T10-30-45-123Z.json
============================================================

Querying existing assets in Jira Cloud...
✓ Found 85 existing users in object type ID 153

Processing users...
----------------------------------------
[1/150] MATCHED: John Doe (john.doe@example.com)
  - Updating attributes: jobTitle, department
  - ✓ Updated successfully

[2/150] NEW: Jane Smith (jane.smith@example.com)
  - Creating asset with 8 attributes
  - ✓ Created successfully (ASSET-123)

[3/150] MATCHED: Bob Johnson (bob.johnson@example.com)
  - No changes detected
  - Skipped

...

Summary:
--------
Total users from Graph API: 150
New assets created: 65
Assets updated: 18
Assets skipped (no changes): 2
Failed: 0

Duration: 2m 34s
API Requests: 218
```

## Troubleshooting

### Authentication Issues

If you get authentication errors:
- Verify your Microsoft Graph credentials (CLIENT_ID, TENANT_ID, CLIENT_SECRET)
- Ensure admin consent has been granted for the application permissions
- Check that the application is not disabled

### Permission Errors

If you get permission errors:
- Verify your Jira Cloud API token has the necessary permissions
- Ensure the workspace ID is correct
- Check that the API token is properly base64 encoded (email:api_token)

### Rate Limiting

The script includes rate limiting and retry logic. If you encounter rate limits:
- The script will automatically retry with exponential backoff
- Increase delays between operations if needed
- Contact Atlassian support if limits are exceeded

### No Users Found

If no users are found:
- Verify the `userType eq 'Member'` filter is correct for your organization
- Check if users have the necessary attributes
- Enable debug mode with `--debug` for more details

## Architecture

The script consists of the following components:

- **MicrosoftGraphApiClient**: Handles authentication and user fetching from Microsoft Graph API
- **CloudApiClient**: Manages interactions with Jira Cloud Assets API (reused from cloud_asset_ingestion)
- **AttributeMapper**: Maps Graph API attributes to Jira Assets attributes (reused from cloud_asset_ingestion)
- **UserMatcher**: Matches users between Graph API and existing assets based on name and attributes
- **IngestionService**: Orchestrates the entire ingestion workflow

## Contributing

When modifying or extending this script:
- Follow the existing code patterns and structure
- Add proper error handling and logging
- Test thoroughly in dry-run mode before production use
- Document any new configuration options or features

## License

ISC