# Environment Variables Configuration Reference

This document lists all the environment variables used by the Microsoft Graph User Ingestion script.

## Required Environment Variables

### Microsoft Graph API Credentials

```bash
# Azure AD application credentials
GRAPH_CLIENT_ID=your-azure-app-client-id
GRAPH_TENANT_ID=your-azure-tenant-id
GRAPH_CLIENT_SECRET=your-azure-app-client-secret
```

### Jira Cloud Assets API Credentials

```bash
# Jira Cloud API token
JIRA_API_TOKEN=your-jira-api-token

# Jira Cloud instance URL (format: https://your-domain.atlassian.net)
JIRA_URL=https://your-domain.atlassian.net
```

### Schema and Object Type Configuration

```bash
# User object type configuration (default: schema 15, object type 153)
DEFAULT_SCHEMA_ID=15
DEFAULT_OBJECT_TYPE_ID=153

# Company object type configuration (default: schema 5, object type 154)
COMPANY_SCHEMA_ID=5
COMPANY_OBJECT_TYPE_ID=154

# License object type configuration (default: schema 5, object type 204)
LICENSE_SCHEMA_ID=5
LICENSE_OBJECT_TYPE_ID=204
```

## Optional Environment Variables

```bash
# Debug mode - enables verbose logging
DEBUG=false

# Dry run mode - shows what would be done without making changes
DRY_RUN=false
```

## Variable Descriptions

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPH_CLIENT_ID` | Yes | - | Azure AD application client ID |
| `GRAPH_TENANT_ID` | Yes | - | Azure AD tenant ID |
| `GRAPH_CLIENT_SECRET` | Yes | - | Azure AD application client secret |
| `JIRA_API_TOKEN` | Yes | - | Jira Cloud API token for authentication |
| `JIRA_URL` | Yes | - | Jira Cloud instance URL |
| `DEFAULT_SCHEMA_ID` | No | 15 | Jira Cloud Assets schema ID containing User object type |
| `DEFAULT_OBJECT_TYPE_ID` | No | 153 | Jira Cloud Assets User object type ID |
| `COMPANY_SCHEMA_ID` | No | 5 | Jira Cloud Assets schema ID containing Company object type |
| `COMPANY_OBJECT_TYPE_ID` | No | 154 | Jira Cloud Assets Company object type ID |
| `LICENSE_SCHEMA_ID` | No | 5 | Jira Cloud Assets schema ID containing License object type |
| `LICENSE_OBJECT_TYPE_ID` | No | 204 | Jira Cloud Assets License object type ID |
| `DEBUG` | No | false | Enable verbose debug logging |
| `DRY_RUN` | No | false | Run in preview mode without making changes |

## How to Get These Values

### Microsoft Graph API Credentials

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to **Azure Active Directory** → **App registrations**
3. Create or select your application
4. **Application (client) ID**: Copy from the application overview
5. **Directory (tenant) ID**: Copy from the application overview
6. **Client secret**: 
   - Go to **Certificates & secrets** → **New client secret**
   - Create a new secret and copy the value

### Jira Cloud Assets API Credentials

1. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Name it appropriately (e.g., "Microsoft Graph Ingestion")
4. Copy the token value

### Schema and Object Type IDs

1. Log in to your Jira Cloud instance
2. Navigate to **Assets** (formerly Insight)
3. For **User**:
   - Open your Assets schema containing User objects
   - Note the schema ID from the URL or schema settings
   - Click on the User object type and note its ID
4. For **Company**:
   - Open the Assets schema containing Company objects
   - Note the schema ID
   - Click on the Company object type and note its ID
5. For **License**:
   - Open the Assets schema containing License objects
   - Note the schema ID
   - Click on the License object type and note its ID

## Security Best Practices

- **Never commit** your `.env` file to version control
- Use strong, unique secrets for all credentials
- Rotate secrets periodically
- Store `.env` file outside of the project directory if possible
- Use a secrets management solution for production deployments

## Example .env File

```bash
# Microsoft Graph API
GRAPH_CLIENT_ID=a1b2c3d4-e5f6-7890-abcd-ef1234567890
GRAPH_TENANT_ID=12345678-1234-1234-1234-123456789012
GRAPH_CLIENT_SECRET=AbC~1XyZ.987-gHjK.mNoP-2qRsT.uVwX

# Jira Cloud Assets
JIRA_API_TOKEN=ATATT3xFfGF0AbCdEfGhIjKlMnOpQrStUvWxYz1234567890
JIRA_URL=https://your-company.atlassian.net

# Schema and Object Type Configuration
DEFAULT_SCHEMA_ID=15
DEFAULT_OBJECT_TYPE_ID=153
COMPANY_SCHEMA_ID=5
COMPANY_OBJECT_TYPE_ID=154
LICENSE_SCHEMA_ID=5
LICENSE_OBJECT_TYPE_ID=204

# Optional
DEBUG=false
DRY_RUN=false
```

## Troubleshooting

### Authentication Errors

- **"Authentication failed"**: Check that all credentials are correct and have not expired
- **"HTTP 401 Unauthorized"**: Verify your Jira API token is valid and has the necessary permissions

### Schema/Object Type Not Found

- **"Object type not found"**: Verify the schema and object type IDs are correct
- **"Department object type not found"**: The script will search for Department object type, but ensure it exists in your Assets configuration

### Missing Objects

- **"referenced object not found in Assets"**: Ensure Company and License objects exist in Jira Cloud Assets before running the ingestion
- You may need to create placeholder objects for companies and licenses referenced in Microsoft Graph users