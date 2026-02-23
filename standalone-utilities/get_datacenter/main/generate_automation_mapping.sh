#!/bin/bash

# =============================================================================
# Datacenter to Cloud Automation Mapping Generator
# =============================================================================
# This script analyzes automation.json from datacenter and creates a mapping
# file that maps datacenter IDs to their cloud equivalents for:
# - Projects (projectId)
# - Custom Fields (customfield_*)
# - Issue Types (issuetype IDs)
# - Statuses (status IDs)
# - Users (authorAccountId, actorAccountId, and user values)
# =============================================================================

# Don't exit on errors - we want to collect all data and show summary at end
# set -e  # REMOVED - allow script to continue on API failures

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Expected location of automation.json (same directory as script)
AUTOMATION_JSON="$SCRIPT_DIR/automation.json"

# Output mapping file
MAPPING_FILE="$SCRIPT_DIR/datacenter_cloud_mapping.json"
TEMP_DIR="$(mktemp -d)"

# Error tracking (after TEMP_DIR is created)
ERROR_LOG="$TEMP_DIR/errors.log"
touch "$ERROR_LOG"

# Source the common datacenter utilities (same directory)
DATACENTER_COMMON="$SCRIPT_DIR/datacenter_common.sh"

if [ ! -f "$DATACENTER_COMMON" ]; then
    echo "ERROR: Cannot find datacenter_common.sh at: $DATACENTER_COMMON"
    echo "This script requires the datacenter API utilities."
    exit 1
fi

source "$DATACENTER_COMMON"

# =============================================================================
# Configuration
# =============================================================================

echo "=========================================="
echo "Datacenter to Cloud Mapping Generator"
echo "=========================================="
echo "Script Directory: $SCRIPT_DIR"
echo "Automation JSON: $AUTOMATION_JSON"
echo "Output Mapping: $MAPPING_FILE"
echo "Temp Directory: $TEMP_DIR"
echo ""
echo "Datacenter URL: $JIRA_URL"
echo "=========================================="
echo ""

# Check if automation.json exists
if [ ! -f "$AUTOMATION_JSON" ]; then
    echo "ERROR: automation.json not found at: $AUTOMATION_JSON"
    echo "Please place automation.json in the same directory as this script."
    exit 1
fi

# Validate JSON
if ! jq empty "$AUTOMATION_JSON" 2>/dev/null; then
    echo "ERROR: automation.json is not valid JSON"
    exit 1
fi

echo "✓ Found valid automation.json"
echo ""

# =============================================================================
# Phase 1: Extract Unique IDs from automation.json
# =============================================================================

echo "=========================================="
echo "Phase 1: Extracting IDs from automation.json"
echo "=========================================="
echo ""

# Extract unique project IDs
echo "Extracting project IDs..."
grep -o '"projectId":"[^"]*"' "$AUTOMATION_JSON" | \
    sed 's/"projectId":"//g' | sed 's/"//g' | \
    sort -u > "$TEMP_DIR/project_ids.txt"
PROJECT_COUNT=$(wc -l < "$TEMP_DIR/project_ids.txt" | tr -d ' ')
echo "  Found $PROJECT_COUNT unique project IDs"

# Extract unique custom field IDs
echo "Extracting custom field IDs..."
grep -o '"customfield_[0-9]*"' "$AUTOMATION_JSON" | \
    sed 's/"//g' | \
    sort -u > "$TEMP_DIR/customfield_ids.txt"
CUSTOMFIELD_COUNT=$(wc -l < "$TEMP_DIR/customfield_ids.txt" | tr -d ' ')
echo "  Found $CUSTOMFIELD_COUNT unique custom field IDs"

# Extract unique issue type IDs from conditions and actions
echo "Extracting issue type IDs..."
grep -o '"issuetype"[^}]*"value":"[0-9]*"' "$AUTOMATION_JSON" | \
    grep -o '"value":"[0-9]*"' | \
    sed 's/"value":"//g' | sed 's/"//g' | \
    sort -u > "$TEMP_DIR/issuetype_ids.txt"
ISSUETYPE_COUNT=$(wc -l < "$TEMP_DIR/issuetype_ids.txt" | tr -d ' ')
echo "  Found $ISSUETYPE_COUNT unique issue type IDs"

# Extract unique status IDs from transitions
echo "Extracting status IDs..."
grep -o '"toStatus":\[{"type":"ID","value":"[0-9]*"}' "$AUTOMATION_JSON" | \
    grep -o '"value":"[0-9]*"' | \
    sed 's/"value":"//g' | sed 's/"//g' > "$TEMP_DIR/status_ids_temp.txt"
grep -o '"fromStatus":\[{"type":"ID","value":"[0-9]*"}' "$AUTOMATION_JSON" | \
    grep -o '"value":"[0-9]*"' | \
    sed 's/"value":"//g' | sed 's/"//g' >> "$TEMP_DIR/status_ids_temp.txt"
sort -u "$TEMP_DIR/status_ids_temp.txt" > "$TEMP_DIR/status_ids.txt"
STATUS_COUNT=$(wc -l < "$TEMP_DIR/status_ids.txt" | tr -d ' ')
echo "  Found $STATUS_COUNT unique status IDs"

# Extract unique user account IDs (authors and actors)
# NOTE: We only extract actual datacenter usernames, NOT smart values like {{initiator}}
echo "Extracting user account IDs..."
grep -o '"authorAccountId":"[^"]*"' "$AUTOMATION_JSON" | \
    sed 's/"authorAccountId":"//g' | sed 's/"//g' > "$TEMP_DIR/user_ids_temp.txt"
grep -o '"actorAccountId":"[^"]*"' "$AUTOMATION_JSON" | \
    sed 's/"actorAccountId":"//g' | sed 's/"//g' >> "$TEMP_DIR/user_ids_temp.txt"

# Also extract user IDs from assignee/watcher values, but EXCLUDE smart values
grep -o '"assignee"[^}]*"value":"[^"]*"' "$AUTOMATION_JSON" | \
    grep -o '"value":"[^"]*"' | \
    sed 's/"value":"//g' | sed 's/"//g' | \
    grep -v "^trigger$" | grep -v "^current$" | \
    grep -v "{{" >> "$TEMP_DIR/user_ids_temp.txt" || true

grep -o '"watchers":\[{"type":"ID","value":"[^"]*"}' "$AUTOMATION_JSON" | \
    grep -o '"value":"[^"]*"' | \
    sed 's/"value":"//g' | sed 's/"//g' | \
    grep -v "{{" >> "$TEMP_DIR/user_ids_temp.txt" || true

# Additional user value extraction from type:"SMART" with smartValue field
# These are dynamic values, so we skip them
# grep -o '"smartValue":"[^"]*"' would find {{initiator}}, {{creator}}, etc.

# Filter out any remaining smart values and special keywords
grep -v "{{" "$TEMP_DIR/user_ids_temp.txt" | \
    grep -v "^initiator$" | \
    grep -v "^creator$" | \
    grep -v "^reporter$" | \
    grep -v "^assignee$" | \
    grep -v "^accountid$" | \
    sort -u > "$TEMP_DIR/user_ids.txt"

USER_COUNT=$(wc -l < "$TEMP_DIR/user_ids.txt" | tr -d ' ')
echo "  Found $USER_COUNT unique user IDs (smart values excluded)"

echo ""
echo "Summary of extracted IDs:"
echo "  - Projects: $PROJECT_COUNT"
echo "  - Custom Fields: $CUSTOMFIELD_COUNT"
echo "  - Issue Types: $ISSUETYPE_COUNT"
echo "  - Statuses: $STATUS_COUNT"
echo "  - Users: $USER_COUNT"
echo ""

# =============================================================================
# Phase 2: Fetch Datacenter Details via API
# =============================================================================

echo "=========================================="
echo "Phase 2: Fetching Datacenter Entity Details"
echo "=========================================="
echo ""

# Initialize JSON arrays
echo "[]" > "$TEMP_DIR/projects_mapping.json"
echo "[]" > "$TEMP_DIR/customfields_mapping.json"
echo "[]" > "$TEMP_DIR/issuetypes_mapping.json"
echo "[]" > "$TEMP_DIR/statuses_mapping.json"
echo "[]" > "$TEMP_DIR/users_mapping.json"

# -----------------------------------------------------------------------------
# 2.1: Fetch Project Details
# -----------------------------------------------------------------------------
echo "Fetching project details..."
PROJECT_NUM=0
while IFS= read -r project_id; do
    if [ -z "$project_id" ]; then
        continue
    fi

    PROJECT_NUM=$((PROJECT_NUM + 1))
    echo "  [$PROJECT_NUM/$PROJECT_COUNT] Fetching project ID: $project_id"

    # Call API to get project details
    PROJECT_API_URL="$BASE_API_URL/api/2/project/$project_id"
    PROJECT_RESPONSE_FILE=$(api_call "$PROJECT_API_URL")
    PROJECT_STATUS=$(get_response_status "$PROJECT_RESPONSE_FILE")
    PROJECT_BODY=$(get_response_body "$PROJECT_RESPONSE_FILE")

    if [ "$PROJECT_STATUS" = "200" ]; then
        # Extract key and name
        PROJECT_KEY=$(echo "$PROJECT_BODY" | jq -r '.key // "UNKNOWN"')
        PROJECT_NAME=$(echo "$PROJECT_BODY" | jq -r '.name // "UNKNOWN"')
        PROJECT_TYPE=$(echo "$PROJECT_BODY" | jq -r '.projectTypeKey // "unknown"')

        # Create mapping entry
        MAPPING_ENTRY=$(jq -n \
            --arg dc_id "$project_id" \
            --arg key "$PROJECT_KEY" \
            --arg name "$PROJECT_NAME" \
            --arg type "$PROJECT_TYPE" \
            '{
                datacenter_id: $dc_id,
                key: $key,
                name: $name,
                project_type: $type,
                cloud_id: null
            }')

        # Append to array
        CURRENT=$(cat "$TEMP_DIR/projects_mapping.json")
        echo "$CURRENT" | jq --argjson entry "$MAPPING_ENTRY" '. + [$entry]' > "$TEMP_DIR/projects_mapping.json"

        echo "    ✓ $PROJECT_KEY - $PROJECT_NAME"
    else
        echo "    ✗ Failed (HTTP $PROJECT_STATUS)"
        echo "PROJECT|$project_id|HTTP $PROJECT_STATUS|Failed to fetch project details" >> "$ERROR_LOG"
    fi

    rm -f "$PROJECT_RESPONSE_FILE"
done < "$TEMP_DIR/project_ids.txt"

echo ""

# -----------------------------------------------------------------------------
# 2.2: Fetch Custom Field Details
# -----------------------------------------------------------------------------
echo "Fetching custom field details..."

# First, get all custom fields in one call
CUSTOMFIELD_API_URL="$BASE_API_URL/api/2/field"
CUSTOMFIELD_RESPONSE_FILE=$(api_call "$CUSTOMFIELD_API_URL")
CUSTOMFIELD_STATUS=$(get_response_status "$CUSTOMFIELD_RESPONSE_FILE")
CUSTOMFIELD_BODY=$(get_response_body "$CUSTOMFIELD_RESPONSE_FILE")

if [ "$CUSTOMFIELD_STATUS" = "200" ]; then
    # Create a temp file with all custom fields
    echo "$CUSTOMFIELD_BODY" | jq '[.[] | select(.custom == true)]' > "$TEMP_DIR/all_customfields.json"

    CUSTOMFIELD_NUM=0
    while IFS= read -r customfield_id; do
        if [ -z "$customfield_id" ]; then
            continue
        fi

        CUSTOMFIELD_NUM=$((CUSTOMFIELD_NUM + 1))
        echo "  [$CUSTOMFIELD_NUM/$CUSTOMFIELD_COUNT] Processing: $customfield_id"

        # Extract details from the full list
        FIELD_DETAILS=$(jq --arg id "$customfield_id" '.[] | select(.id == $id)' "$TEMP_DIR/all_customfields.json")

        if [ -n "$FIELD_DETAILS" ] && [ "$FIELD_DETAILS" != "null" ]; then
            FIELD_NAME=$(echo "$FIELD_DETAILS" | jq -r '.name // "UNKNOWN"')
            FIELD_TYPE=$(echo "$FIELD_DETAILS" | jq -r '.schema.custom // "unknown"')

            # Create mapping entry
            MAPPING_ENTRY=$(jq -n \
                --arg dc_id "$customfield_id" \
                --arg name "$FIELD_NAME" \
                --arg type "$FIELD_TYPE" \
                '{
                    datacenter_id: $dc_id,
                    name: $name,
                    field_type: $type,
                    cloud_id: null
                }')

            # Append to array
            CURRENT=$(cat "$TEMP_DIR/customfields_mapping.json")
            echo "$CURRENT" | jq --argjson entry "$MAPPING_ENTRY" '. + [$entry]' > "$TEMP_DIR/customfields_mapping.json"

            echo "    ✓ $FIELD_NAME ($FIELD_TYPE)"
        else
            echo "    ✗ Not found in field list"
            echo "CUSTOMFIELD|$customfield_id|NOT_FOUND|Custom field not found in Datacenter field list" >> "$ERROR_LOG"
        fi
    done < "$TEMP_DIR/customfield_ids.txt"
else
    echo "  ✗ Failed to fetch custom fields (HTTP $CUSTOMFIELD_STATUS)"
    echo "CUSTOMFIELD|ALL|HTTP $CUSTOMFIELD_STATUS|Failed to fetch custom fields list" >> "$ERROR_LOG"
fi

rm -f "$CUSTOMFIELD_RESPONSE_FILE"
echo ""

# -----------------------------------------------------------------------------
# 2.3: Fetch Issue Type Details
# -----------------------------------------------------------------------------
echo "Fetching issue type details..."

# Get all issue types
ISSUETYPE_API_URL="$BASE_API_URL/api/2/issuetype"
ISSUETYPE_RESPONSE_FILE=$(api_call "$ISSUETYPE_API_URL")
ISSUETYPE_STATUS=$(get_response_status "$ISSUETYPE_RESPONSE_FILE")
ISSUETYPE_BODY=$(get_response_body "$ISSUETYPE_RESPONSE_FILE")

if [ "$ISSUETYPE_STATUS" = "200" ]; then
    echo "$ISSUETYPE_BODY" > "$TEMP_DIR/all_issuetypes.json"

    ISSUETYPE_NUM=0
    while IFS= read -r issuetype_id; do
        if [ -z "$issuetype_id" ]; then
            continue
        fi

        ISSUETYPE_NUM=$((ISSUETYPE_NUM + 1))
        echo "  [$ISSUETYPE_NUM/$ISSUETYPE_COUNT] Processing issue type ID: $issuetype_id"

        # Extract details from the full list
        TYPE_DETAILS=$(jq --arg id "$issuetype_id" '.[] | select(.id == $id)' "$TEMP_DIR/all_issuetypes.json")

        if [ -n "$TYPE_DETAILS" ] && [ "$TYPE_DETAILS" != "null" ]; then
            TYPE_NAME=$(echo "$TYPE_DETAILS" | jq -r '.name // "UNKNOWN"')
            TYPE_DESCRIPTION=$(echo "$TYPE_DETAILS" | jq -r '.description // ""')

            # Create mapping entry
            MAPPING_ENTRY=$(jq -n \
                --arg dc_id "$issuetype_id" \
                --arg name "$TYPE_NAME" \
                --arg desc "$TYPE_DESCRIPTION" \
                '{
                    datacenter_id: $dc_id,
                    name: $name,
                    description: $desc,
                    cloud_id: null
                }')

            # Append to array
            CURRENT=$(cat "$TEMP_DIR/issuetypes_mapping.json")
            echo "$CURRENT" | jq --argjson entry "$MAPPING_ENTRY" '. + [$entry]' > "$TEMP_DIR/issuetypes_mapping.json"

            echo "    ✓ $TYPE_NAME"
        else
            echo "    ✗ Not found in issue type list"
            echo "ISSUETYPE|$issuetype_id|NOT_FOUND|Issue type not found in Datacenter" >> "$ERROR_LOG"
        fi
    done < "$TEMP_DIR/issuetype_ids.txt"
else
    echo "  ✗ Failed to fetch issue types (HTTP $ISSUETYPE_STATUS)"
    echo "ISSUETYPE|ALL|HTTP $ISSUETYPE_STATUS|Failed to fetch issue types list" >> "$ERROR_LOG"
fi

rm -f "$ISSUETYPE_RESPONSE_FILE"
echo ""

# -----------------------------------------------------------------------------
# 2.4: Fetch Status Details
# -----------------------------------------------------------------------------
echo "Fetching status details..."

# Get all statuses
STATUS_API_URL="$BASE_API_URL/api/2/status"
STATUS_RESPONSE_FILE=$(api_call "$STATUS_API_URL")
STATUS_STATUS=$(get_response_status "$STATUS_RESPONSE_FILE")
STATUS_BODY=$(get_response_body "$STATUS_RESPONSE_FILE")

if [ "$STATUS_STATUS" = "200" ]; then
    echo "$STATUS_BODY" > "$TEMP_DIR/all_statuses.json"

    STATUS_NUM=0
    while IFS= read -r status_id; do
        if [ -z "$status_id" ]; then
            continue
        fi

        STATUS_NUM=$((STATUS_NUM + 1))
        echo "  [$STATUS_NUM/$STATUS_COUNT] Processing status ID: $status_id"

        # Extract details from the full list
        STATUS_DETAILS=$(jq --arg id "$status_id" '.[] | select(.id == $id)' "$TEMP_DIR/all_statuses.json")

        if [ -n "$STATUS_DETAILS" ] && [ "$STATUS_DETAILS" != "null" ]; then
            STATUS_NAME=$(echo "$STATUS_DETAILS" | jq -r '.name // "UNKNOWN"')
            STATUS_CATEGORY=$(echo "$STATUS_DETAILS" | jq -r '.statusCategory.name // "unknown"')

            # Create mapping entry
            MAPPING_ENTRY=$(jq -n \
                --arg dc_id "$status_id" \
                --arg name "$STATUS_NAME" \
                --arg category "$STATUS_CATEGORY" \
                '{
                    datacenter_id: $dc_id,
                    name: $name,
                    category: $category,
                    cloud_id: null
                }')

            # Append to array
            CURRENT=$(cat "$TEMP_DIR/statuses_mapping.json")
            echo "$CURRENT" | jq --argjson entry "$MAPPING_ENTRY" '. + [$entry]' > "$TEMP_DIR/statuses_mapping.json"

            echo "    ✓ $STATUS_NAME ($STATUS_CATEGORY)"
        else
            echo "    ✗ Not found in status list"
            echo "STATUS|$status_id|NOT_FOUND|Status not found in Datacenter" >> "$ERROR_LOG"
        fi
    done < "$TEMP_DIR/status_ids.txt"
else
    echo "  ✗ Failed to fetch statuses (HTTP $STATUS_STATUS)"
    echo "STATUS|ALL|HTTP $STATUS_STATUS|Failed to fetch statuses list" >> "$ERROR_LOG"
fi

rm -f "$STATUS_RESPONSE_FILE"
echo ""

# -----------------------------------------------------------------------------
# 2.5: Fetch User Details
# -----------------------------------------------------------------------------
echo "Fetching user details..."

USER_NUM=0
while IFS= read -r user_id; do
    if [ -z "$user_id" ]; then
        continue
    fi

    USER_NUM=$((USER_NUM + 1))
    echo "  [$USER_NUM/$USER_COUNT] Fetching user: $user_id"

    # Call API to get user details
    # Jira Datacenter uses "key" parameter (not "username")
    # The "key" is the original username the user was created with (immutable)
    USER_API_URL="$BASE_API_URL/api/2/user?key=$user_id"
    USER_RESPONSE_FILE=$(api_call "$USER_API_URL")
    USER_STATUS=$(get_response_status "$USER_RESPONSE_FILE")
    USER_BODY=$(get_response_body "$USER_RESPONSE_FILE")

    if [ "$USER_STATUS" = "200" ]; then
        # Extract user details
        USER_NAME=$(echo "$USER_BODY" | jq -r '.name // .key // "UNKNOWN"')
        DISPLAY_NAME=$(echo "$USER_BODY" | jq -r '.displayName // "UNKNOWN"')
        EMAIL=$(echo "$USER_BODY" | jq -r '.emailAddress // ""')
        ACTIVE=$(echo "$USER_BODY" | jq -r '.active // true')

        # Create mapping entry
        MAPPING_ENTRY=$(jq -n \
            --arg dc_username "$user_id" \
            --arg username "$USER_NAME" \
            --arg display "$DISPLAY_NAME" \
            --arg email "$EMAIL" \
            --argjson active "$ACTIVE" \
            '{
                datacenter_username: $dc_username,
                username: $username,
                display_name: $display,
                email: $email,
                active: $active,
                cloud_account_id: null
            }')

        # Append to array
        CURRENT=$(cat "$TEMP_DIR/users_mapping.json")
        echo "$CURRENT" | jq --argjson entry "$MAPPING_ENTRY" '. + [$entry]' > "$TEMP_DIR/users_mapping.json"

        echo "    ✓ $DISPLAY_NAME <$EMAIL>"
    else
        echo "    ✗ Failed (HTTP $USER_STATUS) - user might not exist or be deactivated"
        echo "USER|$user_id|HTTP $USER_STATUS|User not found in datacenter" >> "$ERROR_LOG"

        # Still add entry with limited info for manual review
        MAPPING_ENTRY=$(jq -n \
            --arg dc_username "$user_id" \
            --arg http_status "$USER_STATUS" \
            '{
                datacenter_username: $dc_username,
                username: $dc_username,
                display_name: "NOT_FOUND",
                email: "",
                active: false,
                cloud_account_id: null,
                error: ("User not found in datacenter (HTTP " + $http_status + ")")
            }')

        CURRENT=$(cat "$TEMP_DIR/users_mapping.json")
        echo "$CURRENT" | jq --argjson entry "$MAPPING_ENTRY" '. + [$entry]' > "$TEMP_DIR/users_mapping.json"
    fi

    rm -f "$USER_RESPONSE_FILE"
done < "$TEMP_DIR/user_ids.txt"

echo ""

# =============================================================================
# Phase 3: Generate Final Mapping File
# =============================================================================

echo "=========================================="
echo "Phase 3: Generating Final Mapping File"
echo "=========================================="
echo ""

# Combine all mappings into one JSON structure
FINAL_MAPPING=$(jq -n \
    --arg jira_url "$JIRA_URL" \
    --arg automation_file "$(basename "$AUTOMATION_JSON")" \
    --argjson projects "$(cat "$TEMP_DIR/projects_mapping.json")" \
    --argjson customfields "$(cat "$TEMP_DIR/customfields_mapping.json")" \
    --argjson issuetypes "$(cat "$TEMP_DIR/issuetypes_mapping.json")" \
    --argjson statuses "$(cat "$TEMP_DIR/statuses_mapping.json")" \
    --argjson users "$(cat "$TEMP_DIR/users_mapping.json")" \
    '{
        metadata: {
            generated: (now | strftime("%Y-%m-%d %H:%M:%S")),
            datacenter_url: $jira_url,
            automation_json: $automation_file,
            version: "1.0"
        },
        instructions: {
            purpose: "This mapping file maps datacenter IDs to cloud IDs for automation migration",
            usage: [
                "1. Review the datacenter entities extracted below",
                "2. Manually populate the cloud_id / cloud_account_id fields with corresponding Cloud values",
                "3. You can use the name/key/email fields to identify matching entities in Cloud",
                "4. Use this completed mapping with the automation migration tool"
            ],
            notes: [
                "Projects: Match by key (preferred) or name",
                "Custom Fields: Match by name and field_type",
                "Issue Types: Match by name",
                "Statuses: Match by name and category",
                "Users: Match by email (preferred) or display_name to get Cloud accountId"
            ]
        },
        projects: $projects,
        custom_fields: $customfields,
        issue_types: $issuetypes,
        statuses: $statuses,
        users: $users,
        statistics: {
            projects_count: ($projects | length),
            custom_fields_count: ($customfields | length),
            issue_types_count: ($issuetypes | length),
            statuses_count: ($statuses | length),
            users_count: ($users | length)
        }
    }')

# Write to output file with pretty formatting
echo "$FINAL_MAPPING" | jq '.' > "$MAPPING_FILE"

echo "✓ Mapping file generated: $MAPPING_FILE"
echo ""
echo "Statistics:"
echo "  - Projects: $(echo "$FINAL_MAPPING" | jq '.statistics.projects_count')"
echo "  - Custom Fields: $(echo "$FINAL_MAPPING" | jq '.statistics.custom_fields_count')"
echo "  - Issue Types: $(echo "$FINAL_MAPPING" | jq '.statistics.issue_types_count')"
echo "  - Statuses: $(echo "$FINAL_MAPPING" | jq '.statistics.statuses_count')"
echo "  - Users: $(echo "$FINAL_MAPPING" | jq '.statistics.users_count')"
echo ""

# =============================================================================
# Error Summary
# =============================================================================

if [ -f "$ERROR_LOG" ] && [ -s "$ERROR_LOG" ]; then
    ERROR_COUNT=$(wc -l < "$ERROR_LOG" | tr -d ' ')
    echo "=========================================="
    echo "⚠️  ERRORS ENCOUNTERED: $ERROR_COUNT"
    echo "=========================================="
    echo ""

    # Count errors by type
    PROJECT_ERRORS=$(grep "^PROJECT|" "$ERROR_LOG" 2>/dev/null | wc -l | tr -d ' ')
    CUSTOMFIELD_ERRORS=$(grep "^CUSTOMFIELD|" "$ERROR_LOG" 2>/dev/null | wc -l | tr -d ' ')
    ISSUETYPE_ERRORS=$(grep "^ISSUETYPE|" "$ERROR_LOG" 2>/dev/null | wc -l | tr -d ' ')
    STATUS_ERRORS=$(grep "^STATUS|" "$ERROR_LOG" 2>/dev/null | wc -l | tr -d ' ')
    USER_ERRORS=$(grep "^USER|" "$ERROR_LOG" 2>/dev/null | wc -l | tr -d ' ')

    echo "Error breakdown:"
    [ "$PROJECT_ERRORS" -gt 0 ] && echo "  - Projects: $PROJECT_ERRORS failed"
    [ "$CUSTOMFIELD_ERRORS" -gt 0 ] && echo "  - Custom Fields: $CUSTOMFIELD_ERRORS failed"
    [ "$ISSUETYPE_ERRORS" -gt 0 ] && echo "  - Issue Types: $ISSUETYPE_ERRORS failed"
    [ "$STATUS_ERRORS" -gt 0 ] && echo "  - Statuses: $STATUS_ERRORS failed"
    [ "$USER_ERRORS" -gt 0 ] && echo "  - Users: $USER_ERRORS failed"
    echo ""

    echo "Detailed errors:"
    echo "----------------------------------------"
    while IFS='|' read -r type id status message; do
        echo "  [$type] $id - $message"
    done < "$ERROR_LOG"
    echo "----------------------------------------"
    echo ""
    echo "Note: Entities that failed to fetch are still included in the mapping"
    echo "with 'NOT_FOUND' or error markers for manual review."
    echo ""
else
    echo "✓ No errors encountered - all entities fetched successfully!"
    echo ""
fi

# =============================================================================
# Cleanup
# =============================================================================

echo "Cleaning up temporary files..."
rm -rf "$TEMP_DIR"
echo "✓ Cleanup complete"
echo ""

# =============================================================================
# Final Instructions
# =============================================================================

echo "=========================================="
echo "SUCCESS! Mapping file created"
echo "=========================================="
echo ""
echo "Output file: $MAPPING_FILE"
echo ""
echo "Next Steps:"
echo "1. Review the generated mapping file"
echo "2. For each entity type, populate the cloud_id/cloud_account_id fields"
echo "   - Use Jira Cloud APIs or UI to find matching entities"
echo "   - Match by key/name/email as indicated in the file"
echo "3. Save the completed mapping file"
echo "4. Use it with the automation migration module (to be implemented)"
echo ""
echo "TIP: You can use jq to query the mapping file:"
echo "  jq '.projects' $MAPPING_FILE"
echo "  jq '.users[] | select(.email | contains(\"example\"))' $MAPPING_FILE"
echo ""
echo "=========================================="
