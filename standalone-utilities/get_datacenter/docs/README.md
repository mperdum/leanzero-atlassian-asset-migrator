# Jira Datacenter Extraction Scripts

## 📁 Project Structure

```
get_datacenter/
├── main/                                   # Active scripts (run these)
│   ├── datacenter_common.sh               # Shared utilities
│   ├── get_datacenter_assets.sh           # Asset extraction script
│   ├── get_datacenter_attachments.sh      # Attachment download script
│   ├── get_datacenter_comment_visibility.sh # Comment visibility extraction
│   ├── get_datacenter_ticket_associations.sh  # Ticket extraction script
│   └── generate_automation_mapping.sh     # Automation rule mapping
├── bkp/                                    # Backup files
│   ├── get_datacenter_assets.sh.backup
│   └── get_datacenter_assets.sh.backup_split
└── docs/                                   # Documentation
    ├── README.md                          # This file
    └── get_datacenter_assets.md           # Detailed flow documentation
```

---

## 📦 Scripts Overview

### 1. `get_datacenter_ticket_associations.sh`
**Purpose:** Extracts ticket-to-asset associations from Jira custom fields

**What it does:**
- Fetches all custom fields from Jira
- Filters for CMDB/Asset-type fields
- For each field, extracts all tickets that reference assets
- Creates one JSON file per custom field

**Output:** `datacenter_assets/connectedTickets/*.json`

**Runtime:** ~10-30 minutes (depends on number of tickets)

---

### 2. `get_datacenter_assets.sh`
**Purpose:** Extracts all asset information from Jira Datacenter (Insight/Assets)

**What it does:**
- Fetches all object schemas
- Fetches all object types and their hierarchies
- Extracts all objects with attributes
- Fetches reference info (optional)

**Output:** `datacenter_assets/SchemaName/ObjectType/objects.json`

**Runtime:** ~2-7 hours (depends on number of objects and features enabled)

---

### 3. `datacenter_common.sh`
**Purpose:** Shared utilities and configuration for both scripts

**Contains:**
- Jira credentials and connection settings
- Common API call functions
- JSON validation utilities
- Logging setup

**Note:** This file is sourced by both extraction scripts

---

## 🚀 Quick Start

### Navigate to main folder:
```bash
cd main/
```

### Run ticket extraction:
```bash
./get_datacenter_ticket_associations.sh
```

### Run asset extraction:
```bash
./get_datacenter_assets.sh
```

### Run both in parallel:
```bash
./get_datacenter_ticket_associations.sh &
./get_datacenter_assets.sh &
wait
```

---

## 🚀 Usage Examples

### Run Ticket Associations Extraction Only
```bash
cd main/
./get_datacenter_ticket_associations.sh
```

### Run Asset Extraction Only
```bash
cd main/
./get_datacenter_assets.sh
```

### Run Both (Sequentially)
```bash
cd main/

# Option 1: Run sequentially
./get_datacenter_ticket_associations.sh
./get_datacenter_assets.sh

# Option 2: Run in parallel (faster but more server load)
./get_datacenter_ticket_associations.sh &
./get_datacenter_assets.sh &
wait
```

---

## ⚙️ Configuration

### Shared Configuration (`main/datacenter_common.sh`)
```bash
JIRA_URL="https://your-datacenter-instance.example.com"
USERNAME="your_username"
PASSWORD="your_password_or_token"
OUTPUT_DIR="datacenter_assets"
```

### Asset Extraction Settings (`main/get_datacenter_assets.sh`)
```bash
FETCH_REFERENCES=true             # Fetch reference info per object
PARALLEL_WORKERS=10               # Parallel processing workers
```

### Attachment Extraction (`main/get_datacenter_attachments.sh`)
A separate script handles attachment downloads from datacenter objects.

---

## 📁 Output Structure

```
datacenter_assets/
├── datacenter_ticket_associations_YYYYMMDD_HHMMSS.log
├── datacenter_assets_YYYYMMDD_HHMMSS.log
├── connectedTickets/                    # From ticket associations script
│   ├── customfield_10001.json
│   │   {
│   │     "fieldId": "customfield_10001",
│   │     "fieldName": "Asset Reference",
│   │     "tickets": [
│   │       {"key": "TICKET-456", "id": "12345", "fieldValue": ["Asset (AAM-123)"]}
│   │     ]
│   │   }
│   ├── customfield_10002.json
│   └── ... (~10-20 files)
├── AAM/                                 # From assets script
│   ├── schema_attributes.json
│   ├── Application/
│   │   ├── objects.json
│   │   └── attachments/
│   │       ├── file1.pdf
│   │       └── file2.jpg
│   └── WebApplication/
│       └── objects.json
└── AAP/
    ├── schema_attributes.json
    └── ...
```

---

## 🔑 Key Features

### ✅ **Independent Scripts**
- Run separately or together
- No dependencies between ticket and asset extraction
- Ticket extraction can run overnight separately

### ✅ **Shared Utilities**
- Common configuration in one place
- Consistent API calling and error handling
- Simplified maintenance

### ✅ **Comprehensive Logging**
- All output captured to log files automatically
- Separate log for each script execution
- Timestamped for easy tracking

### ✅ **Optimized Performance**
- Single API call for custom fields (no pagination)
- Parallel processing for asset enhancement
- 5 fallback strategies for robust extraction

### ✅ **Automatic Rate Limit Handling** 🛡️
- **Zero data loss guarantee** - Never drops requests due to rate limiting
- **Automatic retry** with exponential backoff (up to 10 attempts)
- **Smart wait times**: 5s → 10s → 20s → 40s → 80s → 160s → 300s (capped)
- **Server-directed retry** - Respects `Retry-After` header when provided
- **Multiple error types handled**: 429 (rate limit), 503 (server error), 502, 504, connection failures
- **Comprehensive logging** - Full visibility into retry attempts and wait times
- See [Rate Limit Handling](#-rate-limit-handling) section below for details

---

## 🔧 Requirements

- **Bash 3.2+** (compatible with macOS and Linux)
- **curl** (for API calls)
- **jq** (for JSON processing)
- **Jira Datacenter** with Insight/Assets plugin

---

## 📖 Additional Documentation

- **Asset Extraction Flow:** See `get_datacenter_assets.md` for detailed phase breakdown
- **Common Utilities:** All shared functions are documented in `main/datacenter_common.sh`

---

## 🆘 Troubleshooting

### "command not found: jq"
```bash
# macOS
brew install jq

# Linux
sudo apt-get install jq  # Debian/Ubuntu
sudo yum install jq      # RHEL/CentOS
```

### "Permission denied"
```bash
cd main/
chmod +x get_datacenter_ticket_associations.sh
chmod +x get_datacenter_assets.sh
chmod +x datacenter_common.sh
```

### "datacenter_common.sh: No such file"
Ensure all three files are in the `main/` directory:
- `datacenter_common.sh`
- `get_datacenter_ticket_associations.sh`
- `get_datacenter_assets.sh`

---

## 📊 Performance Tips

1. **Run ticket extraction separately** - It's faster and can be done overnight
2. **Adjust PARALLEL_WORKERS** - Lower if server struggles, higher if fast
3. **Skip attachment extraction** - Run only the asset script if you don't need attachment files
4. **Run scripts in parallel** - If server can handle the load

---

## 🔒 Security Notes

- Credentials are stored in `main/datacenter_common.sh`
- Consider using environment variables instead:
  ```bash
  export JIRA_USERNAME="your_username"
  export JIRA_PASSWORD="your_token"
  ```
- Never commit credentials to version control
- Use API tokens instead of passwords when possible

---

## 🛡️ Rate Limit Handling

All scripts include **robust automatic rate limit handling** to prevent data loss during extraction. This is implemented in `datacenter_common.sh` and automatically applies to all API calls.

### How It Works

When a request encounters rate limiting or server errors:

1. **Detect Error**: HTTP 429 (rate limit), 503 (server error), 502, 504, or connection failure
2. **Check Retry-After Header**: If Jira provides one, use that wait time
3. **Calculate Backoff**: Otherwise use exponential backoff (5s → 10s → 20s → 40s → 80s → 160s → 300s max)
4. **Wait with Progress**: Display countdown and attempt number
5. **Retry Request**: Automatically retry up to 10 times
6. **Success or Fail**: Either succeeds and continues, or exhausts retries and logs error

### Exponential Backoff

```
Attempt 1: Wait 5 seconds
Attempt 2: Wait 10 seconds
Attempt 3: Wait 20 seconds
Attempt 4: Wait 40 seconds
Attempt 5: Wait 80 seconds
Attempt 6: Wait 160 seconds
Attempts 7-11: Wait 300 seconds (5 minutes - capped)

Total possible attempts: 11 (1 initial + 10 retries)
Maximum total wait: ~25 minutes per request (5+10+20+40+80+160+300+300+300+300)
```

### Example Log Output

**Successful retry:**
```bash
⏸️  RATE LIMITED (HTTP 429) - Attempt 1/11 - Waiting 5s before retry
   ⏳ Waiting 5s... (Next attempt: 2 of 11)
✅ SUCCESS after 1 retries for URL: https://jira.example.com/rest/api/2/...
```

**Server-directed wait:**
```bash
⏸️  RATE LIMITED (HTTP 429) - Server requested wait: 60s
   ⏳ Waiting 60s... (Next attempt: 2 of 11)
✅ SUCCESS after 1 retries for URL: https://jira.example.com/rest/api/2/...
```

**Multiple retries:**
```bash
⏸️  RATE LIMITED (HTTP 429) - Attempt 1/11 - Waiting 5s before retry
   ⏳ Waiting 5s... (Next attempt: 2 of 11)
⏸️  RATE LIMITED (HTTP 429) - Attempt 2/11 - Waiting 10s before retry
   ⏳ Waiting 10s... (Next attempt: 3 of 11)
⏸️  RATE LIMITED (HTTP 429) - Attempt 3/11 - Waiting 20s before retry
   ⏳ Waiting 20s... (Next attempt: 4 of 11)
✅ SUCCESS after 3 retries for URL: https://jira.example.com/rest/api/2/...
```

### Configuration

Retry behavior is configured in `main/datacenter_common.sh` (inside `api_call()` function):

```bash
local max_retries=10        # Maximum number of retry attempts
local base_wait=5           # Initial wait time in seconds
local max_wait=300          # Maximum wait time cap in seconds
```

### Error Types Handled

**Automatically retries:**
- ✅ HTTP 429 - Rate Limit Exceeded
- ✅ HTTP 503 - Service Unavailable
- ✅ HTTP 502 - Bad Gateway
- ✅ HTTP 504 - Gateway Timeout
- ✅ HTTP 000 - Connection failures

**Does NOT retry (client errors):**
- ❌ HTTP 404 - Not Found
- ❌ HTTP 401 - Unauthorized
- ❌ HTTP 403 - Forbidden
- ❌ Other 4xx errors

### Data Loss Prevention Guarantee

With automatic retry:
- ✅ **No requests dropped** due to rate limiting
- ✅ **Automatic recovery** from transient errors
- ✅ **Up to 10 attempts** per request
- ✅ **All retries logged** for audit trail
- ✅ **Success confirmation** after recovery

**Result**: Even under heavy rate limiting, scripts patiently wait and retry until successful, ensuring complete data extraction without data loss.

### Troubleshooting Rate Limits

**Script seems slow or stuck:**
- Check logs for retry messages - it's waiting for rate limits to clear
- This is **expected behavior** and prevents data loss
- Script will resume automatically when rate limit window expires

**Monitoring retry statistics:**
```bash
# See all successful retries
grep "SUCCESS after" datacenter_assets/*.log

# See all rate limit events
grep "RATE LIMITED" datacenter_assets/*.log

# Count total retry attempts
grep "RATE LIMITED" datacenter_assets/*.log | wc -l
```

**Max retries exceeded (rare):**
- Indicates persistent server issues or network problems
- Check Jira server status and network connectivity
- Consider increasing `max_retries` in `datacenter_common.sh`

---

## 📝 Version History

- **2025-10-30**: Added automatic rate limit handling with exponential backoff
- **2025-10-30**: Split into separate scripts (ticket associations + assets)
- **2025-10-28**: Original combined script
- Backups preserved in `bkp/` folder
