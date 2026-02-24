# 📋 Datacenter Asset Extraction - Complete Flow Documentation

> **Note:** Ticket extraction and attachment downloads are handled by separate scripts
> (`get_datacenter_ticket_associations.sh` and `get_datacenter_attachments.sh`).
> This document covers the main asset extraction script: `get_datacenter_assets.sh`.

## 🔧 PHASE 0: Initialization

**What happens:**
1. **Configuration loaded** - Jira URL, credentials, settings from `datacenter_common.sh`
   - `FETCH_REFERENCES=true` - Enable reference extraction per object
2. **Output directory created** - `datacenter_assets/`
3. **Logging initialized** - `exec > >(tee -a "$LOG_FILE")` redirects ALL output to both terminal and log file
4. **Statistics counters initialized** - All set to 0
5. **Helper functions defined** - For tracking per-schema stats (Bash 3.2 compatible)

**Output:**
- `datacenter_assets/datacenter_assets_YYYYMMDD_HHMMSS.log` created
- Configuration printed to terminal and log

**Key Configuration Variables:**
- `FETCH_REFERENCES` - Adds reference info to each object
- `PARALLEL_WORKERS=10` - Number of parallel workers for object enhancement

---

## 📦 Ticket Extraction (Separate Script)

> Ticket association extraction is handled by `get_datacenter_ticket_associations.sh`.
> See that script for details on custom field discovery and JQL-based ticket extraction.

---

## 🗂️ PHASE 1: Fetch Object Schemas

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

## 📊 PHASE 2: Fetch Schema Attributes

**What happens:**
1. **For each schema**, fetch attributes: `/rest/assets/1.0/objectschema/{id}/attributes`
2. **Save to file**: `SchemaName/schema_attributes.json`

**Output:**
- `datacenter_assets/AAM/schema_attributes.json`
- Contains metadata about all attributes in this schema (name, type, label, etc.)

**Why this step:** Schema-level attribute definitions used for understanding data structure

---

## 🏗️ PHASE 3: Fetch Object Types

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

## 🎯 PHASE 4: Fetch Objects for Each Type

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

4. **Save objects**: `SchemaName/ObjectType/objects.json`

**Output:**
- `datacenter_assets/AAM/Application/objects.json`
- Each object contains:
  - Object attributes
  - Reference info (if `FETCH_REFERENCES=true`)
  - **NO ticket data** (tickets are extracted by the separate ticket associations script)

**Important:**
- Objects are enhanced in **parallel** (10 workers by default) for speed
- Tickets are NOT fetched per-object (handled by separate ticket associations script)

---

## 👶 PHASE 5: Fetch Child Objects

**What happens:**

For **each object type that has children**:

1. **Find child types** where `parentObjectTypeId` matches parent
2. **For each child type**, repeat Phase 4 process:
   - Fetch with AQL
   - Try 5 fallback strategies
   - Enhance with references
   - Save to: `SchemaName/ChildType/objects.json`

**Output:**
- `datacenter_assets/AAM/WebApplication/objects.json`
- `datacenter_assets/AAM/MobileApplication/objects.json`

**Why this step:** Handle hierarchical object types where parent types might be empty containers and children hold actual data

---

## 📈 PHASE 6: Statistics & Cleanup

**What happens:**
1. **Calculate totals**:
   - Schemas processed
   - Object types processed
   - Total objects extracted (parent + child)
   - References fetched

2. **Print detailed statistics**:
   - Per-schema breakdown
   - Per-object-type counts
   - Success/failure summary
   - Reference fetch statistics

3. **Cleanup temp files**:
   - Remove statistics temp files
   - Keep custom field cache
   - Keep failed attachments log (if any failures)

**Output:**
- Comprehensive statistics printed to terminal and log
- Summary of what was extracted

**Note:** Ticket associations are extracted by a separate script (`get_datacenter_ticket_associations.sh`)

---

## 📁 FINAL OUTPUT STRUCTURE

```
datacenter_assets/
├── datacenter_assets_YYYYMMDD_HHMMSS.log   # Complete execution log
├── AAM/                                     # Schema 1 (Phase 1)
│   ├── schema_attributes.json               # Schema metadata (Phase 2)
│   ├── Application/                         # Object Type (Phase 4)
│   │   └── objects.json                     # Objects with attributes and references
│   └── WebApplication/                      # Child Type (Phase 5)
│       └── objects.json
└── AAP/                                     # Schema 2
    ├── schema_attributes.json
    └── ...
```

> Ticket associations (`connectedTickets/`) and attachments are created by their
> respective separate scripts.

---

## 🔑 KEY ARCHITECTURAL DECISIONS

### ✅ **Split Script Architecture**
- Ticket associations, attachments, and comment visibility are each handled by separate scripts
- `get_datacenter_assets.sh` focuses only on schemas, types, and objects
- Each script can be run independently

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
- `FETCH_REFERENCES` - Adds reference info per object
- Can disable to reduce API calls and speed up extraction

---

## 🎛️ CONFIGURATION VARIABLES

| Variable | Default | Description |
|----------|---------|-------------|
| `FETCH_REFERENCES` | `true` | Add reference info to objects |
| `PARALLEL_WORKERS` | `10` | Number of parallel workers |
| `DEFAULT_PAGE_SIZE` | `250` | Objects per page (AQL queries) |

---

## 🚀 RUNNING THE SCRIPT

```bash
# Standard execution
./get_datacenter_assets.sh

# Adjust parallel workers (lower for server safety)
PARALLEL_WORKERS=5 ./get_datacenter_assets.sh
```

**Output:** All terminal output is automatically saved to `datacenter_assets/datacenter_assets_YYYYMMDD_HHMMSS.log`
