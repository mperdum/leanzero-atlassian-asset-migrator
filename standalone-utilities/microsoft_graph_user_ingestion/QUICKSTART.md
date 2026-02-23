# Quick Start Guide

## Prerequisites

- Node.js v14 or higher
- Jira Cloud Assets access with API token
- Microsoft Entra ID (Azure AD) application with:
  - Application permissions: `User.Read.All` and `User.ReadBasic.All`
  - Admin consent granted

## Installation

```bash
cd microsoft_graph_user_ingestion
npm install
```

## Configuration

Create a `.env` file in the root directory:

```env
# Jira Cloud Assets
WORKSPACE_ID=your_workspace_id_here
CLOUD_API_TOKEN=base64_encoded_email:api_token
CLOUD_BASE_URL=https://api.atlassian.com

# Microsoft Graph API
MS_CLIENT_ID=your_azure_app_client_id
MS_TENANT_ID=your_azure_tenant_id
MS_CLIENT_SECRET=your_azure_app_client_secret

# Ingestion Settings
OBJECT_SCHEMA_ID=15
OBJECT_TYPE_ID=153
DEBUG=false
```

### Get your Jira Cloud API Token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Create a new API token
3. Encode it as base64: `echo -n "your_email:your_api_token" | base64`
4. Paste the result into `CLOUD_API_TOKEN`

### Get your Workspace ID

1. Go to Jira Cloud Assets
2. Check the URL for your workspace ID (e.g., `https://your-domain.atlassian.net/jira/core/projects/ASSETS/settings/assets/workspaces/YOUR_WORKSPACE_ID`)

## Running the Script

### Preview Users (No Changes)

```bash
npm run preview
```

### Dry Run (Test Without Making Changes)

```bash
npm run dry-run
```

### Full Ingestion

```bash
npm start
```

### Limit Processing (For Testing)

```bash
npm start -- --limit 10
```

### Use Custom Attribute Mapping

```bash
npm start -- --mapping mapping/example_mapping.json
```

## Common Use Cases

### 1. Initial Ingestion

```bash
npm run preview    # See what users will be imported
npm run dry-run    # Test without changes
npm start          # Perform the import
```

### 2. Update Existing Users

```bash
npm start          # Automatically detects and updates changed users
```

### 3. Test with Small Batch

```bash
npm start -- --limit 5    # Process only 5 users
```

### 4. Debug Issues

```bash
npm start -- --debug --limit 1    # Enable debug mode for single user
```

## What the Script Does

1. **Fetches Users** from Microsoft Graph API with filter `userType eq 'Member'`
2. **Queries Existing Assets** in Jira Cloud (object type ID 153)
3. **Matches Users** by:
   - displayName
   - email (mail)
   - user principal name
4. **Detects Changes** by comparing attributes
5. **Updates** existing assets if attributes have changed
6. **Creates** new assets for new users
7. **Avoids Duplicates** by matching before creation

## Default Attribute Mapping

| Microsoft Graph | Jira Cloud Assets |
|----------------|-------------------|
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

**Note:** Some Jira Cloud Assets attributes are not available from Microsoft Graph API:
- Absence, Manager, departmentNumber, lastLogon
- Software Asset Administrator, userAccountControl
- impNotInInternal, impNotInExternal, impNotInUsers
- Review, Cost centre

The script queries Cloud Assets API to get correct attribute IDs based on attribute names. Customize mapping by editing `mapping/example_mapping.json` and using it with `--mapping` flag.

## Troubleshooting

### Authentication Failed

- Verify Microsoft Graph credentials (CLIENT_ID, TENANT_ID, CLIENT_SECRET)
- Ensure admin consent is granted for application permissions
- Check that API permissions include `User.Read.All`

### Connection Failed

- Verify Jira Cloud API token is correctly base64 encoded
- Confirm workspace ID is correct
- Check your network connectivity

### No Users Found

- Verify your organization has users with `userType = 'Member'`
- Check filter criteria
- Use `--preview` to see what's returned from Graph API

### Rate Limiting

The script automatically handles rate limiting with exponential backoff. If issues persist, contact Atlassian support.

## Getting Help

```bash
npm start -- --help    # Show all command line options
```

For detailed information, see `README.md`.