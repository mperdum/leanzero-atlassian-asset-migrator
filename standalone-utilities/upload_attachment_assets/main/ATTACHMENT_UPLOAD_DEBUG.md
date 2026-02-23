GET /jsm/assets/workspace/{workspaceId}/v1/attachments/object/{objectId}/credentials
```

**TCS** likely refers to Atlassian's internal service architecture. The 404 status indicates that the request couldn't be fulfilled - either the workspace doesn't exist, the endpoint isn't available, or there's a permissions issue.

## Quick Diagnosis

### Step 1: Run the Configuration Check

```bash
cd standalone-utilities/upload_attachment_assets/main
node check_config.js
```

This script will:
- ✅ Verify your `.env` file exists
- ✅ Check if `WORKSPACE_ID` is in valid UUID format
- ✅ Validate `CLOUD_API_TOKEN` format (should be base64 encoded)
- ✅ Check `CLOUD_BASE_URL` format
- ✅ Verify datacenter path accessibility
- ✅ Check if mapping file exists
- ✅ Test workspace connectivity
- ✅ Test attachment endpoint availability

### Step 2: Run the Endpoint Test

```bash
cd standalone-utilities/upload_attachment_assets/main
node test_attachment_endpoint.js
```

This script will:
- 🧪 Test the attachment credentials endpoint directly
- 🔍 Verify if specific objects exist in Cloud
- 📊 Provide detailed error analysis with possible causes

## Common Issues and Solutions

### Issue 1: Invalid WORKSPACE_ID

**Symptoms:**
- Configuration check fails: "WORKSPACE_ID format" - Invalid format
- API test returns 404 when accessing workspace
- Error message: "Workspace not found"

**Diagnosis:**
Your `WORKSPACE_ID` in `.env` is not a valid UUID or doesn't match an existing workspace.

**Solution:**
1. Open Assets in your Jira Cloud browser
2. Look at the URL - it will contain the workspace ID
3. Example: `https://your-domain.atlassian.net/jira/jsm/assets/workspace/a1b2c3d4-e5f6-7890-abcd-ef1234567890/...`
4. Copy the UUID part (everything after `/workspace/` and before the next `/`)
5. Update your `.env` file with the correct `WORKSPACE_ID`

**Format should be:**
```
WORKSPACE_ID=a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

### Issue 2: Wrong CLOUD_BASE_URL

**Symptoms:**
- Configuration check warns about URL format
- API test fails with authentication errors
- Workspace not found even with correct WORKSPACE_ID

**Diagnosis:**
Your `CLOUD_BASE_URL` doesn't match your Jira Cloud instance.

**Solution:**
1. Check your Jira Cloud URL in the browser
2. Extract just the domain part (without `https://`)
3. Update `.env` with correct value

**Format should be:**
```
CLOUD_BASE_URL=your-domain.atlassian.net
```

### Issue 3: Invalid or Expired API Token

**Symptoms:**
- Configuration check warns about token format
- API test returns 401 (Unauthorized) or 403 (Forbidden)
- Error messages about authentication

**Diagnosis:**
Your `CLOUD_API_TOKEN` is either incorrectly formatted, expired, or doesn't have proper permissions.

**Solution:**
1. Generate a new API token in Atlassian Account settings
2. Encode it properly in base64 format: `base64(email:apiToken)`
3. On Mac/Linux: `echo -n "your.email@company.com:your-api-token" | base64`
4. Update `.env` with the base64-encoded value

**Format should be:**
```
CLOUD_API_TOKEN=eW91ci5lbWFpbEBjb21wYW55LmNvbTp5b3VyLWFwaS10b2tlbg==
```

**Permissions needed:**
- Jira Service Management (JSM) access
- Assets workspace access
- Object creation/modification permissions
- Attachment upload permissions

### Issue 4: Attachment Endpoint Not Available

**Symptoms:**
- Configuration check passes workspace access
- API test returns 404 for attachment endpoint specifically
- Error: "TCS 404" or "Failed to get upload credentials"

**Diagnosis:**
The attachment credentials endpoint is not available for your workspace. This could be because:
- Attachments feature is not enabled for your workspace
- Atlassian has changed or deprecated the endpoint
- Your plan doesn't support attachments

**Solutions:**

**Try Solution A - Check Attachments in UI:**
1. Open Assets in your Jira Cloud browser
2. Navigate to an object
3. Check if you can see/add attachments manually
4. If not, attachments may not be enabled for your workspace

**Try Solution B - Contact Atlassian Support:**
1. The attachment API is undocumented and officially unsupported
2. Submit a support request asking about:
   - Attachment upload API availability
   - Required permissions for attachment uploads
   - Known issues with attachment endpoints

**Try Solution C - Use Alternative Approach:**
1. Manually upload critical attachments through the UI
2. Consider using Jira's built-in migration tools if available
3. Wait for official API support for attachments

### Issue 5: Objects Don't Exist in Cloud

**Symptoms:**
- Configuration check passes all tests
- Endpoint test shows objects don't exist (404 for specific object IDs)
- Upload script finds mappings but can't access objects

**Diagnosis:**
The objects in your mapping file no longer exist in Cloud, or were never created.

**Solution:**
1. Run the main migration script again to recreate objects:
   ```bash
   cd asset-migration-script
   node main.js --limit <number>
   ```
2. Check if objects were deleted from Cloud
3. Verify the `created_objects_mapping.json` file is up-to-date
4. Try manually creating a test object in Cloud and verify it works

### Issue 6: Workspace and Mismatch

**Symptoms:**
- Workspace ID appears valid
- Can access workspace with API
- But attachment endpoint fails with 404

**Diagnosis:**
Your `WORKSPACE_ID` and `CLOUD_BASE_URL` might be from different Jira Cloud instances or workspaces.

**Solution:**
1. Verify both are from the same Jira Cloud site
2. In the browser, open Assets and copy the full URL
3. Extract both the domain and workspace ID from the same URL
4. Example: `https://your-domain.atlassian.net/jira/jsm/assets/workspace/a1b2c3d4-e5f6-7890-abcd-ef1234567890/...`
   - `CLOUD_BASE_URL`: `your-domain.atlassian.net`
   - `WORKSPACE_ID`: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`

## Advanced Debugging

### Manually Test the API

You can test the attachment endpoint using curl:

```bash
# Get upload credentials for an object
curl -X GET \
  "https://api.atlassian.com/jsm/assets/workspace/YOUR_WORKSPACE_ID/v1/attachments/object/YOUR_OBJECT_ID/credentials" \
  -H "Authorization: Basic YOUR_BASE64_TOKEN" \
  -H "Accept: application/json"
```

Expected successful response:
```json
{
  "clientId": "your-client-id",
  "mediaBaseUrl": "https://media-service.atlassian.com",
  "mediaJwtToken": "your-jwt-token"
}
```

Expected failure responses:

**404 - Not Found:**
```json
{
  "errorMessage": "TCS 404"
}
```

**401 - Unauthorized:**
```json
{
  "errorMessage": "Unauthorized"
}
```

**403 - Forbidden:**
```json
{
  "errorMessage": "Forbidden"
}
```

### Check API Token Permissions

Test if your API token has proper permissions:

```bash
# Test workspace access
curl -X GET \
  "https://api.atlassian.com/jsm/assets/workspace/YOUR_WORKSPACE_ID/v1/objectschema/list" \
  -H "Authorization: Basic YOUR_BASE64_TOKEN" \
  -H "Accept: application/json"
```

If this succeeds but the attachment endpoint fails, you have basic workspace access but not attachment permissions.

### Verify Object Exists

Check if a specific object exists:

```bash
curl -X GET \
  "https://api.atlassian.com/jsm/assets/workspace/YOUR_WORKSPACE_ID/v1/object/YOUR_OBJECT_ID" \
  -H "Authorization: Basic YOUR_BASE64_TOKEN" \
  -H "Accept: application/json"
```

## Frequently Asked Questions

### Q: Why do I get "TCS 404" when I know my workspace exists?

**A:** The "TCS 404" is from the attachment-specific endpoint, not the general workspace endpoint. This means while your workspace exists and is accessible, the attachment upload functionality may not be available or enabled. This is an undocumented API, so it's possible Atlassian has changed or restricted access to it.

### Q: Can I still migrate my attachments?

**A:** If the attachment API is unavailable, you have these options:
1. Manually upload critical attachments through the Jira Cloud UI
2. Contact Atlassian support to request attachment API access
3. Use the main migration script's `--upload-attachments` flag (if it works during object creation)
4. Wait for Atlassian to provide official attachment upload API support

### Q: Why is the attachment API undocumented?

**A:** Atlassian officially states that attachments can only be added to Assets objects through the UI. The API endpoint used by this toolkit was reverse-engineered by observing how the web UI uploads attachments. This is why it's considered "exotic" and may be subject to changes or restrictions by Atlassian.

### Q: My configuration passes all checks but uploads still fail. What now?

**A:** If all configuration checks pass but you still get "TCS 404" errors:
1. The attachment endpoint may be temporarily unavailable
2. Atlassian may have restricted access for your workspace/plan
3. There may be a service-wide issue
4. Try again later after some time
5. Contact Atlassian support for assistance

### Q: Can I retry failed uploads later?

**A:** Yes! The upload script is designed to be idempotent:
- It checks if attachments already exist before uploading
- You can safely re-run the script
- Only failed uploads will be attempted again
- Successful uploads will be skipped

## Getting Help

If you've tried all the solutions above and still can't upload attachments:

1. **Check the logs:**
   ```bash
   cd standalone-utilities/upload_attachment_assets/logs
   # Review the latest log files
   ```

2. **Run the diagnostic scripts and save output:**
   ```bash
   cd standalone-utilities/upload_attachment_assets/main
   node check_config.js > diagnostic_output.txt 2>&1
   node test_attachment_endpoint.js >> diagnostic_output.txt 2>&1
   ```

3. **Contact Atlassian Support:**
   - Reference the "TCS 404" error
   - Mention you're trying to upload attachments via API to Assets
   - Ask about attachment endpoint availability and requirements
   - Include your workspace ID and any diagnostic information

4. **Check Atlassian Community:**
   - Search for similar issues
   - Post in the Jira Service Management community
   - Reference feature request JSDCLOUD-10454 (Assets attachment API)

## Summary Checklist

Before running the upload script, verify:

- [ ] `.env` file exists and is properly configured
- [ ] `WORKSPACE_ID` is a valid UUID from your Assets URL
- [ ] `CLOUD_API_TOKEN` is base64-encoded (email:apiToken)
- [ ] `CLOUD_BASE_URL` matches your Jira Cloud domain
- [ ] Both WORKSPACE_ID and CLOUD_BASE_URL are from the same instance
- [ ] API token has Assets permissions
- [ ] Workspace is accessible via API
- [ ] Attachment endpoint returns something other than 404
- [ ] Main migration has been completed (mapping file exists)
- [ ] Datacenter assets directory contains attachment files

If all checks pass and you still get "TCS 404" errors, the attachment endpoint may not be available for your workspace, and you should contact Atlassian support.