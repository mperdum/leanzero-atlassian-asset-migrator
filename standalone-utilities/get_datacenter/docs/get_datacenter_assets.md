# 📋 Datacenter Asset Extraction Script - Complete Flow Documentation

## 🔧 PHASE 0: Initialization (Lines 1-200)

**What happens:**
1. **Configuration loaded** - Jira URL, credentials, settings
   - `EXTRACT_TICKET_ASSOCIATIONS=true` - Controls whether Phase 1 & 2 execute
   - `FETCH_REFERENCES=true` - Enable reference extraction per object
   - `FETCH_ATTACHMENTS=true` - Enable attachment downloads per object
2. **Output directory created** - `datacenter_assets/`
3. **Logging initialized** - `exec > >(tee -a "$LOG_FILE")` redirects ALL output to both terminal and log file
4. **Statistics counters initialized** - All set to 0
5. **Helper functions defined** - For tracking per-schema stats (Bash 3.2 compatible)

**Output:**
- `datacenter_assets/datacenter_export_YYYYMMDD_HHMMSS.log` created
- Configuration printed to terminal and log

**Key Configuration Variables:**
- `EXTRACT_TICKET_ASSOCIATIONS` - If `false`, skips Phase 1 & 2 entirely, goes straight to Phase 3
- `FETCH_REFERENCES` - Adds reference info to each object
- `FETCH_ATTACHMENTS` - Downloads attachments for each object
- `PARALLEL_WORKERS=10` - Number of parallel workers for object enhancement

---

## 📦 PHASE 1: Fetch Custom Fields (Lines 586-650)

**Controlled by:** `EXTRACT_TICKET_ASSOCIATIONS=true`

**What happens:**
1. **Single API call** to `/rest/api/2/customFields?maxResults=600`
2. **Extracts all custom fields** from Jira (572 fields, so single request is sufficient)
3. **Filters for CMDB/Asset fields only** - keeps only fields with type containing "insight", "assets", or "cmdb"
4. **Saves filtered list** to temp file

**Output:**
- List of ~10-20 CMDB custom fields identified
- Example: `customfield_10001|Asset Reference|com.atlassian.jira.plugin.system.customfieldtypes:insight-object`

**Why this step:** To identify which custom fields are asset references that need ticket association extraction

**Skipped if:** `EXTRACT_TICKET_ASSOCIATIONS=false`

---

## 🎫 PHASE 2: Extract Ticket Associations Per Custom Field (Lines 700-815)

**Controlled by:** `EXTRACT_TICKET_ASSOCIATIONS=true`

**What happens:**

For **each CMDB custom field**:

1. **Build JQL query**: `cf[10001] is not EMPTY`
2. **Fetch tickets with pagination** (100 per page):
   - API: `/rest/api/2/search?jql=...&fields=customfield_10001,key,id`
3. **For each ticket**:
   - Extract `fieldValue` (e.g., `["Asset1 (AAM-123)", "Asset2 (AAM-456)"]`)
   - ~~Parse fieldValue with regex to extract object keys: `\((?<key>[A-Z]+-[0-9]+)\)`~~ **(Not used for grouping)**
   - Create JSON structure (one entry per ticket):
     ```json
     {
       "ticket": {
         "key": "TICKET-456",
         "id": "12345",
         "fieldValue": ["Asset1 (AAM-123)", "Asset2 (AAM-456)"]
       }
     }
     ```
4. **Save to file**: `connectedTickets/customfield_10001.json`
   - **Final structure (optimized, no duplication):**
     ```json
     {
       "fieldId": "customfield_10001",
       "fieldName": "Asset Reference",
       "tickets": [
         {"key": "TICKET-456", "id": "12345", "fieldValue": ["Asset1 (AAM-123)", "Asset2 (AAM-456)"]},
         {"key": "TICKET-789", "id": "67890", "fieldValue": ["Asset3 (AAM-999)"]}
       ]
     }
     ```

**Output:**
- `connectedTickets/` directory with ~10-20 JSON files (one per custom field)
- Each file contains all tickets that reference assets via that custom field
- Field metadata stored once at top level (no duplication per ticket)

**Why this step:** 
- Separate ticket associations from main asset extraction to avoid 7-hour runtime
- Prevents empty objects.json files
- Allows processing field-by-field instead of object-by-object

**Skipped if:** `EXTRACT_TICKET_ASSOCIATIONS=false`

---

## 🗂️ PHASE 3: Fetch Object Schemas (Lines 820-870)

**What happens:**
1. **Fetch all schemas** with pagination: `/rest/assets/1.0/objectschema/list`
2. **For each schema** extract:
   - Schema ID
   - Schema name
3. **Initialize statistics** for this schema

**Output:**
- List of schemas (e.g., "AAM", "AAP", "Configuration Items")
- Directories created: `datacenter_assets/SchemaName/`

**Example schemas:** AAM (Application Asset Management), AAP (Application Asset Portfolio)

---

## 📊 PHASE 4: Fetch Schema Attributes (Lines 890-920)

**What happens:**
1. **For each schema**, fetch attributes: `/rest/assets/1.0/objectschema/{id}/attributes`
2. **Save to file**: `SchemaName/schema_attributes.json`

**Output:**
- `datacenter_assets/AAM/schema_attributes.json`
- Contains metadata about all attributes in this schema (name, type, label, etc.)

**Why this step:** Schema-level attribute definitions used for understanding data structure

---

## 🏗️ PHASE 5: Fetch Object Types (Lines 930-1000)

**What happens:**
1. **For each schema**, fetch all object types: `/rest/assets/1.0/objectschema/{id}/objecttypes/flat`
2. **Extract type hierarchy**:
   - Parent types
   - Child types
   - Abstract types (containers only)
   - Concrete types (contain actual objects)

**Output:**
- Object types identified (e.g., "Application", "Server", "Database")
- Hierarchy relationships stored

**Example:**
- Schema: AAM
  - Type: Application (parent, concrete)
    - Child: Web Application (concrete)
    - Child: Mobile Application (concrete)

---

## 🎯 PHASE 6: Fetch Objects for Each Type (Lines 2600-3100)

**What happens:**

For **each concrete object type**:

1. **Build AQL query**: `objectType = "Application"`
2. **Fetch objects with pagination** using **5 fallback strategies**:

   **Strategy 1 (Preferred)**: Full attributes + extended info
   - API: `includeAttributes=true&includeAttributesDeep=2&includeExtendedInfo=true`

   **Strategy 2 (Fallback)**: No attributes in bulk, then fetch individually in parallel
   - Gets object IDs first, then fetches attributes one-by-one (parallel)

   **Strategy 3 (Fallback)**: Attributes but no extended info
   - API: `includeAttributes=true&includeExtendedInfo=false`

   **Strategy 4 (Fallback)**: Smaller page size (125 instead of 250)
   - Helps with large objects that timeout

   **Strategy 5 (Last Resort)**: Individual object fetching
   - Fetches each object separately with attributes

3. **For each object**, optionally enhance with:
   - **References** (if `FETCH_REFERENCES=true`)
     - API: `/rest/assets/1.0/object/{id}/referenceinfo`
   - **Attachments** (if `FETCH_ATTACHMENTS=true`)
     - API: `/rest/assets/1.0/attachments/object/{id}`
     - Downloads attachment files to `SchemaName/ObjectType/attachments/`
     - Adds `localFilePath` to object metadata

4. **Save objects**: `SchemaName/ObjectType/objects.json`

**Output:**
- `datacenter_assets/AAM/Application/objects.json`
- Each object contains:
  - Object attributes
  - Reference info (if `FETCH_REFERENCES=true`)
  - Attachments metadata + downloaded files (if `FETCH_ATTACHMENTS=true`)
  - **NO ticket data** (tickets are in separate `connectedTickets/` files)

**Important:** 
- Objects are enhanced in **parallel** (10 workers by default) for speed
- Tickets are NOT fetched per-object (handled in Phase 2)

---

## 👶 PHASE 7: Fetch Child Objects (Lines 3100-3950)

**What happens:**

For **each object type that has children**:

1. **Find child types** where `parentObjectTypeId` matches parent
2. **For each child type**, repeat Phase 6 process:
   - Fetch with AQL
   - Try 5 fallback strategies
   - Enhance with references/attachments
   - Save to: `SchemaName/ChildType/objects.json`

**Output:**
- `datacenter_assets/AAM/WebApplication/objects.json`
- `datacenter_assets/AAM/MobileApplication/objects.json`

**Why this step:** Handle hierarchical object types where parent types might be empty containers and children hold actual data

---

## 📈 PHASE 8: Statistics & Cleanup (Lines 4000-4160)

**What happens:**
1. **Calculate totals**:
   - Schemas processed
   - Object types processed
   - Total objects extracted (parent + child)
   - Attachments downloaded
   - Ticket files created (from Phase 2)

2. **Print detailed statistics**:
   - Per-schema breakdown
   - Per-object-type counts
   - Success/failure summary
   - Attachment download statistics

3. **Cleanup temp files**:
   - Remove statistics temp files
   - Keep custom field cache
   - Keep failed attachments log (if any failures)

**Output:**
- Comprehensive statistics printed to terminal and log
- Summary of what was extracted

**Note:** Ticket association statistics are shown inline during Phase 2, not in final summary

---

## 📁 FINAL OUTPUT STRUCTURE

```
datacenter_assets/
├── datacenter_export_20251030_143022.log    # Complete execution log
├── connectedTickets/                        # Ticket associations (Phase 2)
│   ├── customfield_10001.json               # Per custom field
│   │   {
│   │     "fieldId": "customfield_10001",
│   │     "fieldName": "Asset Reference",
│   │     "tickets": [
│   │       {"key": "TICKET-456", "id": "12345", "fieldValue": ["Asset (AAM-123)"]}
│   │     ]
│   │   }
│   ├── customfield_10002.json
│   └── ... (~10-20 files total)
├── AAM/                                     # Schema 1 (Phase 3)
│   ├── schema_attributes.json               # Schema metadata (Phase 4)
│   ├── Application/                         # Object Type (Phase 6)
│   │   ├── objects.json                     # Objects (NO tickets inside)
│   │   └── attachments/                     # Downloaded files
│   │       ├── file1.pdf
│   │       └── file2.jpg
│   └── WebApplication/                      # Child Type (Phase 7)
│       └── objects.json
└── AAP/                                     # Schema 2
    ├── schema_attributes.json
    └── ...
```

---

## 🔑 KEY ARCHITECTURAL DECISIONS

### ✅ **Ticket Associations Are Separate**
- Stored in `connectedTickets/` per custom field
- **NOT** injected into `objects.json`
- Prevents 7-hour runtimes and empty object files
- Field metadata (ID/name) stored once at top level

### ✅ **Automatic Comprehensive Logging**
- `exec > >(tee -a "$LOG_FILE")` captures everything
- No manual log function calls needed
- All stdout/stderr automatically logged

### ✅ **Parallel Processing**
- 10 workers by default for object enhancement
- Configurable via `PARALLEL_WORKERS`
- Significantly speeds up attachment/reference fetching

### ✅ **5 Fallback Strategies**
- Ensures data extraction even when server struggles
- Progressively degrades gracefully
- Handles large objects, timeouts, rate limits

### ✅ **Optional Enhancement**
- `EXTRACT_TICKET_ASSOCIATIONS` - Controls Phase 1 & 2
- `FETCH_REFERENCES` - Adds reference info per object
- `FETCH_ATTACHMENTS` - Downloads attachment files per object
- Can disable any feature to reduce load

---

## 🎛️ CONFIGURATION VARIABLES

| Variable | Default | Description |
|----------|---------|-------------|
| `EXTRACT_TICKET_ASSOCIATIONS` | `true` | Enable Phase 1 & 2 (ticket extraction) |
| `FETCH_REFERENCES` | `true` | Add reference info to objects |
| `FETCH_ATTACHMENTS` | `true` | Download attachments for objects |
| `PARALLEL_WORKERS` | `10` | Number of parallel workers |
| `MAX_ATTACHMENT_SIZE_MB` | `45` | Max attachment size to download |
| `ATTACHMENTS_PER_OBJECT` | `10` | Max attachments per object |
| `DEFAULT_PAGE_SIZE` | `250` | Objects per page (AQL queries) |

---

## 🚀 RUNNING THE SCRIPT

```bash
# Standard execution
./get_datacenter_assets.sh

# Skip ticket extraction (faster, only extract assets)
EXTRACT_TICKET_ASSOCIATIONS=false ./get_datacenter_assets.sh

# Adjust parallel workers (lower for server safety)
PARALLEL_WORKERS=5 ./get_datacenter_assets.sh
```

**Output:** All terminal output is automatically saved to `datacenter_assets/datacenter_export_YYYYMMDD_HHMMSS.log`
