# Datacenter Extraction Scripts

Shell scripts to extract asset data, attachments, and ticket associations from a Jira Datacenter instance. The extracted data serves as input for the cloud migration tools.

These scripts must run on a machine with network access to your Datacenter instance (typically behind a corporate firewall). The output files are then transferred to wherever you run the cloud migration tools.

## Prerequisites

- bash, curl, jq
- Access to a Jira Datacenter instance with REST API enabled

## Configuration

Edit `main/datacenter_common.sh` with your Jira Datacenter credentials:

```bash
JIRA_URL="https://your-datacenter-instance.example.com"
USERNAME="your_username"
PASSWORD="your_password_or_api_token"
```

## Scripts

### main/get_datacenter_assets.sh

Extracts all asset object data (schemas, object types, objects, attributes) from Jira Datacenter via the Insight REST API. This is the primary extraction script and should be run first.

```bash
cd standalone-utilities/get_datacenter/main
bash get_datacenter_assets.sh
```

### main/get_datacenter_attachments.sh

Extracts attachment metadata and downloads attachment files for asset objects. Run after asset extraction.

```bash
bash get_datacenter_attachments.sh
```

### main/get_datacenter_ticket_associations.sh

Extracts ticket-to-asset association data (which Jira tickets reference which asset objects). Required if you plan to reconnect tickets after migration.

```bash
bash get_datacenter_ticket_associations.sh
```

### main/get_datacenter_comment_visibility.sh

Extracts comment visibility settings (role-restricted and group-restricted comments) from Jira tickets. Required only if you need to preserve comment visibility after migration. By default, processes only JSM (Service Desk) projects.

```bash
# Default (JSM projects only)
bash get_datacenter_comment_visibility.sh

# All projects
JSM_ONLY=false bash get_datacenter_comment_visibility.sh

# Custom JQL filter
JQL_QUERY="project = PROJ ORDER BY key ASC" bash get_datacenter_comment_visibility.sh

# Exclude specific projects
EXCLUDE_PROJECTS="OLD_PROJ,TEST_PROJ" bash get_datacenter_comment_visibility.sh
```

### main/generate_automation_mapping.sh

Generates automation rule mappings between datacenter and cloud configurations. Used by the automation-service utility for migrating Jira automation rules.

```bash
bash generate_automation_mapping.sh
```

### main/datacenter_common.sh

Shared configuration and utility functions sourced by all other scripts. Not meant to be run directly.

## Output

All extracted data is written to the `datacenter_assets/` directory at the project root, which is excluded from version control.

## Limitations

- Requires direct network access to the Datacenter REST API. Cannot work through Jira Cloud or Atlassian-hosted instances.
- Extraction speed depends on the Datacenter instance's API response time. Large instances (100k+ objects) may take several hours.
- Attachment downloads can consume significant disk space. Ensure adequate storage before running `get_datacenter_attachments.sh`.
- The scripts do not handle Datacenter API authentication via SSO/OAuth -- only basic auth (username/password or username/PAT).
