# Datacenter Extraction Scripts

Shell scripts to extract asset data, attachments, and ticket associations from a Jira Datacenter instance. The extracted data serves as input for the cloud migration tools.

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
Extracts all asset object data from Jira Datacenter.

### main/get_datacenter_attachments.sh
Extracts attachment metadata and files for asset objects.

### main/get_datacenter_ticket_associations.sh
Extracts ticket-to-asset association data.

### main/generate_automation_mapping.sh
Generates automation rule mappings between datacenter and cloud configurations.

### main/datacenter_common.sh
Shared configuration and utility functions sourced by all other scripts.

## Output

All extracted data is written to the `datacenter_assets/` directory, which is excluded from version control.

## Documentation

See `docs/` for detailed documentation on each extraction script.
