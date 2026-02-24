#!/bin/bash

# =============================================================================
# Jira Datacenter Asset Extractor
# =============================================================================
# This script extracts all asset information from a Jira Datacenter instance
# It extracts schemas, object types, objects, attributes, references, and attachments
# =============================================================================

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/datacenter_common.sh"

# --- Asset-Specific Configuration ---
DEFAULT_PAGE_SIZE=250

# Enhanced metadata extraction settings
FETCH_REFERENCES=true             # Fetch reference info for each object
INCLUDE_EXTENDED_INFO=true        # Include open issues and attachments info in AQL queries
ATTRIBUTES_DEPTH=2                # How many levels deep to fetch attributes (0-3)

# Parallel processing configuration
PARALLEL_WORKERS=${PARALLEL_WORKERS:-10}  # Number of parallel workers

# HTTP Connection settings for downloads
CURL_DOWNLOAD_OPTS="-s"           # Simple options for downloads (no timeouts)

# Initialize logging
setup_logging "datacenter_assets"

echo "Configuration:"
echo "  PARALLEL_WORKERS: $PARALLEL_WORKERS"
echo "  FETCH_REFERENCES: $FETCH_REFERENCES"
echo "=========================================="


# Create the output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

# Note: Logging already initialized by setup_logging() above

# Global statistics counters
TOTAL_SCHEMAS_PROCESSED=0
TOTAL_SCHEMAS_SUCCESS=0
TOTAL_SCHEMA_ATTRIBUTES_SUCCESS=0
TOTAL_OBJECT_TYPES_PROCESSED=0
TOTAL_OBJECT_TYPES_SUCCESS=0
TOTAL_OBJECTS_PROCESSED=0
TOTAL_OBJECTS_SUCCESS=0
TOTAL_CHILD_TYPES_PROCESSED=0
TOTAL_CHILD_OBJECTS_SUCCESS=0

# Fallback strategy counters
STRATEGY_1_SUCCESS=0
STRATEGY_2_SUCCESS=0
STRATEGY_3_SUCCESS=0
STRATEGY_4_SUCCESS=0
STRATEGY_5_SUCCESS=0
STRATEGY_2_INDIVIDUAL_SUCCESS=0

# Detailed per-schema statistics tracking (Bash 3.2 compatible)
# Using simple variables and temp files instead of associative arrays
SCHEMA_STATS_FILE=$(mktemp)
SCHEMA_NAMES_FILE=$(mktemp)
SCHEMA_OBJECT_TYPE_DETAILS_FILE=$(mktemp)

# Custom field name cache (local JSON file in script directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUSTOM_FIELD_CACHE_FILE="$SCRIPT_DIR/custom_fields_cache.json"

# Helper functions for Bash 3.2 compatibility (replacement for associative arrays)
set_schema_stat() {
    local schema_id="$1"
    local stat_type="$2"
    local value="$3"
    grep -v "^${schema_id}:${stat_type}:" "$SCHEMA_STATS_FILE" > "${SCHEMA_STATS_FILE}.tmp" 2>/dev/null || true
    echo "${schema_id}:${stat_type}:${value}" >> "${SCHEMA_STATS_FILE}.tmp"
    mv "${SCHEMA_STATS_FILE}.tmp" "$SCHEMA_STATS_FILE"
}

get_schema_stat() {
    local schema_id="$1"
    local stat_type="$2"
    local default_value="${3:-0}"
    grep "^${schema_id}:${stat_type}:" "$SCHEMA_STATS_FILE" 2>/dev/null | cut -d: -f3 || echo "$default_value"
}

set_schema_name() {
    local schema_id="$1"
    local name="$2"
    grep -v "^${schema_id}:" "$SCHEMA_NAMES_FILE" > "${SCHEMA_NAMES_FILE}.tmp" 2>/dev/null || true
    echo "${schema_id}:${name}" >> "${SCHEMA_NAMES_FILE}.tmp"
    mv "${SCHEMA_NAMES_FILE}.tmp" "$SCHEMA_NAMES_FILE"
}

get_schema_name() {
    local schema_id="$1"
    grep "^${schema_id}:" "$SCHEMA_NAMES_FILE" 2>/dev/null | cut -d: -f2- || echo "Unknown"
}

set_object_type_detail() {
    local schema_id="$1"
    local object_type_id="$2"
    local details="$3"
    local key="${schema_id}:${object_type_id}"
    grep -v "^${key}:" "$SCHEMA_OBJECT_TYPE_DETAILS_FILE" > "${SCHEMA_OBJECT_TYPE_DETAILS_FILE}.tmp" 2>/dev/null || true
    echo "${key}:${details}" >> "${SCHEMA_OBJECT_TYPE_DETAILS_FILE}.tmp"
    mv "${SCHEMA_OBJECT_TYPE_DETAILS_FILE}.tmp" "$SCHEMA_OBJECT_TYPE_DETAILS_FILE"
}

get_object_type_details_for_schema() {
    local schema_id="$1"
    grep "^${schema_id}:" "$SCHEMA_OBJECT_TYPE_DETAILS_FILE" 2>/dev/null || true
}

get_all_schema_ids() {
    cut -d: -f1 "$SCHEMA_NAMES_FILE" 2>/dev/null | sort -n | uniq
}

echo "Starting asset extraction from $JIRA_URL..."
echo "Start time: $SCRIPT_START_TIME ($SCRIPT_START_TIMESTAMP)"
echo "Configuration:"
echo "  - Parallel workers: $PARALLEL_WORKERS"
echo "  - Fetch references: $FETCH_REFERENCES"
echo "  - Timeouts: NONE (all calls can complete naturally)"

# Configuration validation and warnings
if [ "$PARALLEL_WORKERS" -gt 15 ]; then
    echo "WARNING: Very high parallel workers ($PARALLEL_WORKERS) - monitor for server overload"
fi

echo "=========================================="

# Function to validate JSON integrity (SIMPLIFIED)
validate_json() {
    local json_data="$1"

    # Basic checks only - avoid expensive validation
    if [ -z "$json_data" ] || [ "$json_data" == "null" ]; then
        return 1
    fi

    # Quick syntax check - if it starts with { or [, assume it's JSON
    case "$json_data" in
        "{"*|"["*) return 0 ;;
        *) return 1 ;;
    esac
}

# Safe jq operations with error handling
safe_jq_merge() {
    local current="$1"
    local new_data="$2"
    local output_file="$3"

    if [[ -n "$current" && -n "$new_data" ]]; then
        # Use temp files for reliable jq merge (Bash 3.2 compatible)
        local temp_current=$(mktemp)
        local temp_new=$(mktemp)
        echo "$current" > "$temp_current"
        echo "$new_data" > "$temp_new"

        # Validate both JSON inputs before attempting merge
        local current_valid=false
        local new_valid=false
        if jq empty "$temp_current" 2>/dev/null; then
            current_valid=true
        fi
        if jq empty "$temp_new" 2>/dev/null; then
            new_valid=true
        fi

        if [[ "$current_valid" == "false" ]]; then
            echo "ERROR: jq merge failed - current data is invalid JSON ($(wc -c < "$temp_current") bytes)"
            echo "$new_data" > "$output_file"
            rm -f "$temp_current" "$temp_new"
            return 1
        fi

        if [[ "$new_valid" == "false" ]]; then
            echo "ERROR: jq merge failed - new data is invalid JSON ($(wc -c < "$temp_new") bytes)"
            echo "$current" > "$output_file"
            rm -f "$temp_current" "$temp_new"
            return 1
        fi

        # jq -s reads both files and 'add' merges the arrays
        # Write directly to output file to avoid command substitution size limits
        local jq_error_file=$(mktemp)
        if jq -s 'add' "$temp_current" "$temp_new" > "$output_file" 2>"$jq_error_file"; then
            rm -f "$temp_current" "$temp_new" "$jq_error_file"
            return 0
        else
            local jq_exit_code=$?
            local jq_error=$(cat "$jq_error_file" 2>/dev/null | head -n 1)
            echo "ERROR: jq merge failed (exit $jq_exit_code) - error: '$jq_error' (current: $(wc -c < "$temp_current") bytes, new: $(wc -c < "$temp_new") bytes)"
            # For debugging, save the failing files
            if [ "${DEBUG_ATTACHMENTS:-false}" = "true" ] || [ "${DEBUG_API:-false}" = "true" ]; then
                cp "$temp_current" "/tmp/jq_merge_fail_current_$$.json"
                cp "$temp_new" "/tmp/jq_merge_fail_new_$$.json"
                echo "DEBUG: Saved failing merge files to /tmp/jq_merge_fail_*_$$.json"
            fi
            echo "$current" > "$output_file"
            rm -f "$temp_current" "$temp_new" "$jq_error_file"
            return 1
        fi
    elif [[ -n "$new_data" ]]; then
        echo "$new_data" > "$output_file"
        return 0
    else
        echo "WARNING: No data to merge"
        return 1
    fi
}

safe_combine_chunks() {
    local parallel_work_dir="$1"
    local output_file="$2"

    local combined_temp=$(mktemp)
    local chunk_count=0
    local failed_chunks=0
    local valid_chunks=0

    # Chunk files contain newline-separated JSON objects, not arrays
    # We need to validate each chunk, concatenate valid ones, then use jq -s to create an array
    while IFS= read -r -d '' chunk_file; do
        if [[ -f "$chunk_file" && -s "$chunk_file" ]]; then
            # CRITICAL FIX: Validate each chunk BEFORE adding it to combined file
            # This prevents one bad chunk from destroying ALL data
            local chunk_validation=$(mktemp)
            local chunk_name=$(basename "$chunk_file")

            # Try to parse each line as JSON to validate the chunk
            local chunk_is_valid=true
            local line_num=0
            while IFS= read -r line; do
                line_num=$((line_num + 1))
                if [ -n "$line" ]; then
                    if ! echo "$line" | jq empty 2>/dev/null; then
                        echo "ERROR: Invalid JSON in $chunk_name at line $line_num - SKIPPING THIS CHUNK to preserve other data"
                        echo "DEBUG: Failed line content: ${line:0:200}..."
                        chunk_is_valid=false
                        break
                    fi
                fi
            done < "$chunk_file"

            rm -f "$chunk_validation"

            if [ "$chunk_is_valid" = true ]; then
                # Each chunk file has newline-separated JSON objects
                # Append all objects to combined temp file
                cat "$chunk_file" >> "$combined_temp"
                chunk_count=$((chunk_count + 1))
                valid_chunks=$((valid_chunks + 1))
                echo "DEBUG: Added valid chunk $chunk_name ($line_num objects)"
            else
                echo "ERROR: SKIPPED invalid chunk $chunk_name - preserving other ${valid_chunks} valid chunks"
                failed_chunks=$((failed_chunks + 1))
            fi
        else
            echo "WARNING: Missing or empty chunk: $chunk_file"
            failed_chunks=$((failed_chunks + 1))
        fi
    done < <(find "$parallel_work_dir" -name "chunk_*.enhanced" -print0)

    # Convert newline-separated JSON objects to a single array using jq -s
    if [[ -f "$combined_temp" && -s "$combined_temp" ]]; then
        # Use jq -s to slurp all objects into an array
        local jq_error_file=$(mktemp)
        if jq -s '.' "$combined_temp" > "$output_file" 2>"$jq_error_file"; then
            echo "DEBUG: Successfully combined $valid_chunks valid chunks into array"
            rm -f "$jq_error_file"
        else
            local jq_error=$(cat "$jq_error_file" 2>/dev/null | head -n 1)
            echo "ERROR: Failed to convert combined chunks to JSON array: $jq_error"
            echo "ERROR: Combined temp file size: $(wc -c < "$combined_temp") bytes, $(wc -l < "$combined_temp") lines"
            echo "ERROR: This should not happen after per-chunk validation - saving debug file"

            # Save the failing combined file for debugging
            local debug_file="/tmp/failed_combine_chunks_$$.txt"
            cp "$combined_temp" "$debug_file"
            echo "ERROR: Saved failing combined chunks to: $debug_file"

            # Instead of dropping ALL data, try to salvage what we can
            echo "WARNING: Attempting to salvage valid objects from combined chunks..."
            local salvaged=0
            local salvage_temp=$(mktemp)
            while IFS= read -r line; do
                if [ -n "$line" ] && echo "$line" | jq empty 2>/dev/null; then
                    echo "$line" >> "$salvage_temp"
                    salvaged=$((salvaged + 1))
                fi
            done < "$combined_temp"

            if [ $salvaged -gt 0 ]; then
                echo "WARNING: Salvaged $salvaged valid objects - creating array from salvaged data"
                if jq -s '.' "$salvage_temp" > "$output_file" 2>/dev/null; then
                    echo "WARNING: Successfully created array from $salvaged salvaged objects"
                else
                    echo "ERROR: Failed to create array even from salvaged objects - using empty array"
                    echo "[]" > "$output_file"
                fi
            else
                echo "ERROR: Could not salvage any objects - using empty array"
                echo "[]" > "$output_file"
            fi

            rm -f "$salvage_temp" "$jq_error_file"
            rm -f "$combined_temp"
            return 1
        fi
    else
        echo "WARNING: No chunk data to combine"
        echo "[]" > "$output_file"
    fi

    rm -f "$combined_temp"

    if [[ $failed_chunks -gt 0 ]]; then
        echo "WARNING: WARNING: $failed_chunks chunks failed, $valid_chunks succeeded - some data may be missing"
    fi

    return $((failed_chunks > 0 ? 1 : 0))
}

cleanup_resources() {
    local temp_files=(
        "${ticket_keys_file:-}"
        "${all_jql_tickets:-}"
        "${enhanced_tickets:-}"
        "${PARALLEL_WORK_DIR:-}"
    )

    for temp_file in "${temp_files[@]}"; do
        if [[ -n "$temp_file" && -e "$temp_file" ]]; then
            rm -rf "$temp_file" 2>/dev/null || echo "WARNING: Failed to cleanup: $temp_file"
        fi
    done
}

# Note: cleanup_resources available but not auto-trapped to avoid interference
# cleanup_resources() can be called manually if needed

# Removed unused safe_jq_parse function

# Function to extract objects with robust error handling (OPTIMIZED)
extract_objects_robust() {
    local json_data="$1"
    local context="${2:-"unknown"}"

    if [ -z "$json_data" ] || [ "$json_data" == "null" ]; then
        echo "[]"
        return 1
    fi

    # First validate the JSON structure
    if ! validate_json "$json_data"; then
        echo "[]"
        return 1
    fi

    # Single jq call to try all extraction methods at once (PERFORMANCE OPTIMIZATION)
    local objects=$(echo "$json_data" | jq -c '.objectEntries // .objects // (if type == "array" then . else [] end)' 2>/dev/null)

    if [ -n "$objects" ] && [ "$objects" != "null" ]; then
        echo "$objects"
        return 0  # Return success even for empty arrays - they're valid responses
    fi

    echo "[]"
    return 1
}

# Removed retry variables - no more useless retries

# Function to make API call with fallback curl methods (NO USELESS RETRIES)
api_call() {
    local url="$1"
    local method="${2:-GET}"
    local output_file="${3:-$(mktemp)}"

    # Simple, reliable API call (NO artificial timeouts - let server handle limits)
    local response_temp=$(mktemp)
    curl $CURL_API_OPTS -w "\\n%{http_code}" -u "$USERNAME:$PASSWORD" -X "$method" "$url" > "$response_temp" 2>/dev/null
    local curl_exit_code=$?

    # Extract status and body from temp file
    local http_status=$(tail -n1 "$response_temp" 2>/dev/null | tr -d ' \r\n')
    local body_temp=$(mktemp)
    sed '$d' "$response_temp" > "$body_temp" 2>/dev/null

    # Check for curl errors
    if [ $curl_exit_code -ne 0 ] || [ -z "$http_status" ] || [ "$http_status" = "000" ]; then
        echo "ERROR: curl failed with exit code $curl_exit_code, HTTP status: '$http_status' for URL: $url" >&2
        if [ $curl_exit_code -eq 28 ]; then
            echo "ERROR: Curl timeout (exit 28) - natural timeout occurred" >&2
        fi
        http_status="000"
    fi

    # Report errors immediately
    if [ "$http_status" = "000" ]; then
        echo "ERROR: Connection failed (HTTP 000) for URL: $url" >&2
    elif [ "$http_status" = "503" ]; then
        echo "ERROR: Server overloaded (HTTP 503) for URL: $url" >&2
    elif [ "$http_status" = "429" ]; then
        echo "ERROR: Rate limited (HTTP 429) for URL: $url" >&2
    fi

    # Write structured output to final file
    {
        echo "STATUS:$http_status"
        echo "BODY_START"
        cat "$body_temp"
        echo "BODY_END"
    } > "$output_file"

    # Clean up temp files
    rm -f "$response_temp" "$body_temp"

    # Return the output file path
    echo "$output_file"
}

# Helper function to extract HTTP status from response file
get_response_status() {
    local response_file="$1"
    awk '/^STATUS:/{gsub("STATUS:", "", $0); print $0}' "$response_file" | tr -d ' '
}

# Helper function to extract body from response file
get_response_body() {
    local response_file="$1"
    awk '/^BODY_START/{flag=1;next}/^BODY_END/{flag=0}flag' "$response_file"
}

# Helper function to extract body from response file directly to a temp file (AVOIDS SHELL VARIABLE CORRUPTION)
get_response_body_to_file() {
    local response_file="$1"
    local output_file="${2:-$(mktemp)}"

    # Ensure the response file exists
    if [ ! -f "$response_file" ]; then
        echo "ERROR: Response file $response_file does not exist" >&2
        echo "" > "$output_file"  # Create empty file
        echo "$output_file"
        return 1
    fi

    # Extract body content
    awk '/^BODY_START/{flag=1;next}/^BODY_END/{flag=0}flag' "$response_file" > "$output_file"

    # Verify the output file was created and has content
    if [ ! -f "$output_file" ]; then
        echo "ERROR: Failed to create output file $output_file" >&2
        echo "" > "$output_file"  # Create empty file as fallback
    elif [ ! -s "$output_file" ]; then
        echo "WARNING: Output file $output_file is empty, response file might not have BODY_START/BODY_END markers" >&2
        # Try to extract content without markers as fallback
        cat "$response_file" > "$output_file" 2>/dev/null || echo "" > "$output_file"
    fi

    echo "$output_file"
}

# Enhanced extract_objects_robust that works directly with files to avoid shell variable corruption
extract_objects_robust_from_file() {
    local json_file="$1"
    local context="${2:-"unknown"}"
    local output_file="${3:-$(mktemp)}"

    if [ ! -f "$json_file" ] || [ ! -s "$json_file" ]; then
        echo "[]" > "$output_file"
        echo "$output_file"
        return 1
    fi

    # First validate the JSON structure
    if ! jq empty "$json_file" 2>/dev/null; then
        echo "[]" > "$output_file"
        echo "$output_file"
        return 1
    fi

    # Single jq call to try all extraction methods at once (PERFORMANCE OPTIMIZATION)
    jq -c '.objectEntries // .objects // (if type == "array" then . else [] end)' "$json_file" > "$output_file" 2>/dev/null

    if [ -s "$output_file" ]; then
        echo "$output_file"
        return 0  # Return success even for empty arrays - they're valid responses
    else
        echo "[]" > "$output_file"
        echo "$output_file"
        return 1
    fi
}



# Global array to track successfully processed child types (to avoid double processing)
SUCCESSFULLY_PROCESSED_CHILDREN=""

# Only execute main logic if script is run directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then

# ============================================================================
# PHASE 1: Build Object-to-Tickets Mapping (NEW OPTIMIZED APPROACH)
# ============================================================================
# This runs ONCE at script startup and builds a complete mapping of:
# object_key -> [list of tickets with custom field info]
# This eliminates the need for per-object API calls during processing
# ============================================================================


# Get all object schemas (paginated)
echo "Fetching object schemas..."
SCHEMAS_TEMP_FILE=$(mktemp)
SCHEMA_PAGE_NUM=1
SCHEMA_PAGE_SIZE=$DEFAULT_PAGE_SIZE

while true; do
    SCHEMA_API_URL="$BASE_API_URL/assets/1.0/objectschema/list?page=$SCHEMA_PAGE_NUM&resultPerPage=$SCHEMA_PAGE_SIZE"
    SCHEMA_RESPONSE_FILE=$(api_call "$SCHEMA_API_URL")
    SCHEMA_HTTP_STATUS=$(get_response_status "$SCHEMA_RESPONSE_FILE")
    SCHEMA_BODY=$(get_response_body "$SCHEMA_RESPONSE_FILE")

    if [ "$SCHEMA_HTTP_STATUS" -ne 200 ]; then
        echo "Error: Received HTTP status $SCHEMA_HTTP_STATUS when fetching schemas page $SCHEMA_PAGE_NUM."
        # If first page fails, exit. Otherwise, we just stop fetching more.
        if [ "$SCHEMA_PAGE_NUM" -eq 1 ]; then
            exit 1
        else
            break
        fi
    fi

    # Atlassian paginated APIs often use 'values', but the non-paginated one uses 'objectschemas'
    PAGE_SCHEMAS=$(echo "$SCHEMA_BODY" | jq -c '.values[]' 2>/dev/null) || \
    PAGE_SCHEMAS=$(echo "$SCHEMA_BODY" | jq -c '.objectschemas[]' 2>/dev/null)

    if [ -z "$PAGE_SCHEMAS" ]; then
        break # No more schemas
    fi

    echo "$PAGE_SCHEMAS" >> "$SCHEMAS_TEMP_FILE"

    PAGE_COUNT=$(echo "$PAGE_SCHEMAS" | wc -l | tr -d ' ')
    if [ "$PAGE_COUNT" -lt "$SCHEMA_PAGE_SIZE" ]; then
        rm -f "$SCHEMA_RESPONSE_FILE"
        break # Last page
    fi

    rm -f "$SCHEMA_RESPONSE_FILE"
    SCHEMA_PAGE_NUM=$((SCHEMA_PAGE_NUM + 1))
done

SCHEMAS=$(cat "$SCHEMAS_TEMP_FILE")
rm -f "$SCHEMAS_TEMP_FILE"

if [ -z "$SCHEMAS" ]; then
    echo "Could not find any schemas."
    exit 1
fi

# Count schemas
SCHEMA_COUNT=$(echo "$SCHEMAS" | wc -l | tr -d ' ')
echo "Found $SCHEMA_COUNT schemas"

# Process each schema
while IFS= read -r schema; do
    if [ -z "$schema" ]; then
        continue
    fi

    # Try to extract schema ID and name with error handling
    SCHEMA_ID=""
    SCHEMA_NAME=""

    SCHEMA_ID=$(echo "$schema" | jq -r '.id' 2>/dev/null) || SCHEMA_ID=""
    SCHEMA_NAME=$(echo "$schema" | jq -r '.name' 2>/dev/null) || SCHEMA_NAME=""

    if [ -z "$SCHEMA_ID" ] || [ -z "$SCHEMA_NAME" ]; then
        echo "Warning: Could not extract ID or name from schema. Skipping."
        echo "Schema data: $schema"
        continue
    fi





    echo "Processing schema: '$SCHEMA_NAME' (ID: $SCHEMA_ID)"
    TOTAL_SCHEMAS_PROCESSED=$((TOTAL_SCHEMAS_PROCESSED + 1))

    # Initialize detailed statistics for this schema
    set_schema_name "$SCHEMA_ID" "$SCHEMA_NAME"
    set_schema_stat "$SCHEMA_ID" "attributes" 0
    set_schema_stat "$SCHEMA_ID" "object_types" 0
    set_schema_stat "$SCHEMA_ID" "objects" 0
    set_schema_stat "$SCHEMA_ID" "child_types" 0
    set_schema_stat "$SCHEMA_ID" "child_objects" 0

    # Sanitize schema name for directory use
    SANITIZED_SCHEMA_NAME=$(echo "$SCHEMA_NAME" | sed 's/[^a-zA-Z0-9._-]/_/g')
    SCHEMA_DIR="$OUTPUT_DIR/$SANITIZED_SCHEMA_NAME"
    mkdir -p "$SCHEMA_DIR"

    # Get all attributes for the schema
    echo "  Fetching attributes for schema '$SCHEMA_NAME'..."
    SCHEMA_ATTRIBUTES_RESPONSE_FILE=$(api_call "$BASE_API_URL/assets/1.0/objectschema/$SCHEMA_ID/attributes")
    SCHEMA_ATTRIBUTES_HTTP_STATUS=$(get_response_status "$SCHEMA_ATTRIBUTES_RESPONSE_FILE")
    SCHEMA_ATTRIBUTES_BODY=$(get_response_body "$SCHEMA_ATTRIBUTES_RESPONSE_FILE")

    if [ -n "$SCHEMA_ATTRIBUTES_HTTP_STATUS" ] && [[ "$SCHEMA_ATTRIBUTES_HTTP_STATUS" =~ ^[0-9]+$ ]] && [ "$SCHEMA_ATTRIBUTES_HTTP_STATUS" -eq 200 ]; then
        SCHEMA_ATTRIBUTES_FILE="$SCHEMA_DIR/schema_attributes.json"
        echo "$SCHEMA_ATTRIBUTES_BODY" | jq '.' > "$SCHEMA_ATTRIBUTES_FILE"
        # Count the number of attributes
        ATTR_COUNT=$(echo "$SCHEMA_ATTRIBUTES_BODY" | jq 'length' 2>/dev/null || echo "0")
        echo "  Saved $ATTR_COUNT schema attributes to $SCHEMA_ATTRIBUTES_FILE"
        TOTAL_SCHEMA_ATTRIBUTES_SUCCESS=$((TOTAL_SCHEMA_ATTRIBUTES_SUCCESS + ATTR_COUNT))
        set_schema_stat "$SCHEMA_ID" "attributes" "$ATTR_COUNT"
    else
        echo "  Warning: HTTP $SCHEMA_ATTRIBUTES_HTTP_STATUS when fetching attributes for schema '$SCHEMA_NAME'."
        set_schema_stat "$SCHEMA_ID" "attributes" 0
    fi
    rm -f "$SCHEMA_ATTRIBUTES_RESPONSE_FILE"

    # Get all object types for the schema using AQL (WITH PROPER PAGINATION!)
    echo "  Fetching object types for schema '$SCHEMA_NAME'..."

    # First try the flat API to get object type metadata
    OT_API_URL="$BASE_API_URL/assets/1.0/objectschema/$SCHEMA_ID/objecttypes/flat"
    echo "    DEBUG: Trying flat object types API first: $OT_API_URL"
    FLAT_RESPONSE_FILE=$(api_call "$OT_API_URL")
    FLAT_HTTP_STATUS=$(get_response_status "$FLAT_RESPONSE_FILE")
    FLAT_BODY=$(get_response_body "$FLAT_RESPONSE_FILE")

    FLAT_OBJECT_TYPES=""
    if [ "$FLAT_HTTP_STATUS" -eq 200 ]; then
        # Try to parse flat response
        FLAT_OBJECT_TYPES=$(echo "$FLAT_BODY" | jq -c '.values[]' 2>/dev/null) || \
        FLAT_OBJECT_TYPES=$(echo "$FLAT_BODY" | jq -c '.[]' 2>/dev/null)

        if [ -n "$FLAT_OBJECT_TYPES" ]; then
            FLAT_COUNT=$(echo "$FLAT_OBJECT_TYPES" | wc -l | tr -d ' ')
            echo "    DEBUG: Flat API returned $FLAT_COUNT object types"

            # ALWAYS use AQL to ensure we get ALL object types
            echo "    Using AQL to ensure we get ALL object types..."
            FLAT_OBJECT_TYPES=""  # Clear it to force AQL usage
        fi
    fi
    rm -f "$FLAT_RESPONSE_FILE"

    # If flat API gave us types and it's not exactly 50, use them
    if [ -n "$FLAT_OBJECT_TYPES" ]; then
        OBJECT_TYPES="$FLAT_OBJECT_TYPES"
        echo "    DEBUG: Using $FLAT_COUNT object types from flat API"
    else
        # Use AQL to get ALL object types by querying for objects
        echo "    DEBUG: Using AQL to fetch ALL object types with pagination..."

        # Create temp file to collect unique object types
        ALL_TYPES_TEMP=$(mktemp)
        TYPES_MAP_TEMP=$(mktemp)

        # Query for all objects in this schema, but we'll extract unique types
        AQL_QUERY="objectSchemaId = $SCHEMA_ID"
        ENCODED_AQL=$(printf %s "$AQL_QUERY" | jq -s -R -r @uri)

        OT_PAGE_NUM=1
        OT_PAGE_SIZE=1000  # Large page to minimize requests
        OT_TOTAL_OBJECTS=0

        while true; do
            OT_API_URL="$BASE_API_URL/assets/1.0/aql/objects"
            OT_API_URL="${OT_API_URL}?qlQuery=$ENCODED_AQL"
            OT_API_URL="${OT_API_URL}&page=$OT_PAGE_NUM"
            OT_API_URL="${OT_API_URL}&resultPerPage=$OT_PAGE_SIZE"
            OT_API_URL="${OT_API_URL}&includeAttributes=false"  # Just need type info

            echo "      Fetching objects page $OT_PAGE_NUM to extract types..."
            AQL_RESPONSE_FILE=$(api_call "$OT_API_URL")
            AQL_STATUS=$(get_response_status "$AQL_RESPONSE_FILE")
            AQL_BODY=$(get_response_body "$AQL_RESPONSE_FILE")

            if [ "$AQL_STATUS" -ne 200 ]; then
                echo "      Warning: HTTP $AQL_STATUS for AQL page $OT_PAGE_NUM"
                rm -f "$AQL_RESPONSE_FILE"
                break
            fi

            # Extract objects from this page
            PAGE_OBJECTS=$(echo "$AQL_BODY" | jq -c '.objectEntries[]? // empty' 2>/dev/null)
            PAGE_COUNT=$(echo "$PAGE_OBJECTS" | jq -s 'length' 2>/dev/null || echo "0")

            if [ "${PAGE_COUNT:-0}" -eq 0 ]; then
                rm -f "$AQL_RESPONSE_FILE"
                break
            fi

            # Extract unique object types from this page's objects
            echo "$PAGE_OBJECTS" | jq -c '.objectType' 2>/dev/null | while IFS= read -r type_obj; do
                if [ -n "$type_obj" ] && [ "$type_obj" != "null" ]; then
                    TYPE_ID=$(echo "$type_obj" | jq -r '.id' 2>/dev/null)
                    if [ -n "$TYPE_ID" ] && ! grep -q "^$TYPE_ID$" "$TYPES_MAP_TEMP" 2>/dev/null; then
                        echo "$TYPE_ID" >> "$TYPES_MAP_TEMP"
                        echo "$type_obj" >> "$ALL_TYPES_TEMP"
                    fi
                fi
            done

            OT_TOTAL_OBJECTS=$((OT_TOTAL_OBJECTS + PAGE_COUNT))

            # Get unique type count so far
            CURRENT_UNIQUE=$(wc -l < "$TYPES_MAP_TEMP" 2>/dev/null | tr -d ' ')
            echo "      Processed $OT_TOTAL_OBJECTS objects, found $CURRENT_UNIQUE unique types so far..."

            # Check pagination
            TOTAL_FILTER_COUNT=$(echo "$AQL_BODY" | jq -r '.totalFilterCount // 0' 2>/dev/null)

            rm -f "$AQL_RESPONSE_FILE"

            if [ "${PAGE_COUNT:-0}" -lt "${OT_PAGE_SIZE}" ]; then
                break
            fi

            if [ -n "$TOTAL_FILTER_COUNT" ] && [ "$TOTAL_FILTER_COUNT" -gt 0 ] && [ "$OT_TOTAL_OBJECTS" -ge "$TOTAL_FILTER_COUNT" ]; then
                break
            fi

            OT_PAGE_NUM=$((OT_PAGE_NUM + 1))

            # Safety limit
            if [ "$OT_PAGE_NUM" -gt 100 ]; then
                echo "      Warning: Reached page limit for type extraction"
                break
            fi
        done

        # Convert collected types to proper format
        if [ -f "$ALL_TYPES_TEMP" ] && [ -s "$ALL_TYPES_TEMP" ]; then
            # Read all types and format as newline-separated JSON objects
            OBJECT_TYPES=$(cat "$ALL_TYPES_TEMP")
            FINAL_COUNT=$(echo "$OBJECT_TYPES" | wc -l | tr -d ' ')
            echo "    DEBUG: Found $FINAL_COUNT unique object types via AQL from $OT_TOTAL_OBJECTS objects"
        else
            echo "    ERROR: Failed to get object types via AQL"
            OBJECT_TYPES=""
        fi

        rm -f "$ALL_TYPES_TEMP" "$TYPES_MAP_TEMP"
    fi

    if [ -z "$OBJECT_TYPES" ]; then
        echo "  No object types found for schema '$SCHEMA_NAME'."
        continue
    fi

    # Count object types
    OBJECT_TYPE_COUNT=$(echo "$OBJECT_TYPES" | wc -l | tr -d ' ')
    echo "  Found $OBJECT_TYPE_COUNT object types"
    TOTAL_OBJECT_TYPES_PROCESSED=$((TOTAL_OBJECT_TYPES_PROCESSED + OBJECT_TYPE_COUNT))
    TOTAL_SCHEMAS_SUCCESS=$((TOTAL_SCHEMAS_SUCCESS + 1))
    set_schema_stat "$SCHEMA_ID" "object_types" "$OBJECT_TYPE_COUNT"

    # FETCH MISSING PARENT TYPES
    echo "  Checking for missing parent types..."

    # Collect all unique parent IDs that are referenced
    PARENT_IDS_TEMP=$(mktemp)
    EXISTING_IDS_TEMP=$(mktemp)

    # Extract all parent IDs from object types
    echo "$OBJECT_TYPES" | while IFS= read -r object_type; do
        if [ -z "$object_type" ]; then
            continue
        fi
        PARENT_ID=$(echo "$object_type" | jq -r '.parentObjectTypeId // empty' 2>/dev/null)
        if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "null" ]; then
            echo "$PARENT_ID" >> "$PARENT_IDS_TEMP"
        fi
    done

    # Extract all existing object type IDs
    echo "$OBJECT_TYPES" | while IFS= read -r object_type; do
        if [ -z "$object_type" ]; then
            continue
        fi
        TYPE_ID=$(echo "$object_type" | jq -r '.id // empty' 2>/dev/null)
        if [ -n "$TYPE_ID" ] && [ "$TYPE_ID" != "null" ]; then
            echo "$TYPE_ID" >> "$EXISTING_IDS_TEMP"
        fi
    done

    # Find unique parent IDs that are missing from our object types
    MISSING_PARENTS=$(sort -u "$PARENT_IDS_TEMP" 2>/dev/null | while read -r parent_id; do
        if ! grep -q "^${parent_id}$" "$EXISTING_IDS_TEMP" 2>/dev/null; then
            echo "$parent_id"
        fi
    done)

    # Fetch each missing parent type
    if [ -n "$MISSING_PARENTS" ]; then
        MISSING_COUNT=$(echo "$MISSING_PARENTS" | wc -l | tr -d ' ')
        echo "    Found $MISSING_COUNT missing parent type(s) to fetch..."

        for PARENT_ID in $MISSING_PARENTS; do
            echo "    Fetching missing parent type ID: $PARENT_ID"

            # First try to get it as an object (might be an abstract type with an instance)
            PARENT_URL="$BASE_API_URL/assets/1.0/object/$PARENT_ID"
            PARENT_RESPONSE_FILE=$(api_call "$PARENT_URL")
            PARENT_STATUS=$(get_response_status "$PARENT_RESPONSE_FILE")
            PARENT_BODY=$(get_response_body "$PARENT_RESPONSE_FILE")

            PARENT_TYPE_DATA=""
            if [ "$PARENT_STATUS" = "200" ] && validate_json "$PARENT_BODY"; then
                # Extract objectType from the object response
                PARENT_TYPE_DATA=$(echo "$PARENT_BODY" | jq -c '.objectType // empty' 2>/dev/null)
                if [ -n "$PARENT_TYPE_DATA" ] && [ "$PARENT_TYPE_DATA" != "null" ]; then
                    echo "      Successfully fetched parent type from object API"
                fi
            fi
            rm -f "$PARENT_RESPONSE_FILE"

            # If object API didn't work, try the objecttype API directly
            if [ -z "$PARENT_TYPE_DATA" ] || [ "$PARENT_TYPE_DATA" = "null" ]; then
                PARENT_TYPE_URL="$BASE_API_URL/assets/1.0/objecttype/$PARENT_ID"
                PARENT_TYPE_RESPONSE_FILE=$(api_call "$PARENT_TYPE_URL")
                PARENT_TYPE_STATUS=$(get_response_status "$PARENT_TYPE_RESPONSE_FILE")
                PARENT_TYPE_BODY=$(get_response_body "$PARENT_TYPE_RESPONSE_FILE")

                if [ "$PARENT_TYPE_STATUS" = "200" ] && validate_json "$PARENT_TYPE_BODY"; then
                    PARENT_TYPE_DATA="$PARENT_TYPE_BODY"
                    echo "      Successfully fetched parent type from objecttype API"
                else
                    echo "      Warning: Failed to fetch parent type ID $PARENT_ID (HTTP $PARENT_TYPE_STATUS)"
                fi
                rm -f "$PARENT_TYPE_RESPONSE_FILE"
            fi

            # Add the parent type to our collection if we got it
            if [ -n "$PARENT_TYPE_DATA" ] && [ "$PARENT_TYPE_DATA" != "null" ]; then
                # Add to OBJECT_TYPES at the BEGINNING (newline-separated JSON objects)
                # This ensures parents are processed before their children
                OBJECT_TYPES=$(printf "%s\n%s" "$PARENT_TYPE_DATA" "$OBJECT_TYPES")
                PARENT_NAME=$(echo "$PARENT_TYPE_DATA" | jq -r '.name // "Unknown"' 2>/dev/null)
                IS_ABSTRACT=$(echo "$PARENT_TYPE_DATA" | jq -r '.abstractObjectType // false' 2>/dev/null)
                echo "      Added parent type: '$PARENT_NAME' (ID: $PARENT_ID, Abstract: $IS_ABSTRACT)"
            fi
        done

        # Update count after adding parents
        OBJECT_TYPE_COUNT=$(echo "$OBJECT_TYPES" | wc -l | tr -d ' ')
        echo "    Total object types after fetching parents: $OBJECT_TYPE_COUNT"
    else
        echo "    No missing parent types found"
    fi

    rm -f "$PARENT_IDS_TEMP" "$EXISTING_IDS_TEMP"

    # Fetch attributes for each object type (parallel processing)
    echo "  Fetching attributes for each object type (parallel)..."
    ENHANCED_OBJECT_TYPES_TEMP=$(mktemp)

    # Create a function for parallel attribute fetching
    fetch_object_type_attributes() {
        local object_type="$1"
        local temp_dir="$2"

        if [ -z "$object_type" ]; then
            return
        fi

        # Ensure temp directory exists
        if [ ! -d "$temp_dir" ]; then
            mkdir -p "$temp_dir" 2>/dev/null || return
        fi

        OBJECT_TYPE_ID=$(echo "$object_type" | jq -r '.id' 2>/dev/null)
        OBJECT_TYPE_NAME=$(echo "$object_type" | jq -r '.name' 2>/dev/null)

        if [ -z "$OBJECT_TYPE_ID" ] || [ "$OBJECT_TYPE_ID" == "null" ]; then
            echo "$object_type" > "$temp_dir/ot_${OBJECT_TYPE_ID:-unknown}_$(date +%s%N).json"
            return
        fi

        echo "    Fetching attributes for object type '$OBJECT_TYPE_NAME' (ID: $OBJECT_TYPE_ID)..."

        # Fetch attributes for this object type
        OT_ATTR_URL="$BASE_API_URL/assets/1.0/objecttype/$OBJECT_TYPE_ID/attributes"
        OT_ATTR_RESPONSE_FILE=$(api_call "$OT_ATTR_URL")
        OT_ATTR_STATUS=$(get_response_status "$OT_ATTR_RESPONSE_FILE")
        OT_ATTR_BODY=$(get_response_body "$OT_ATTR_RESPONSE_FILE")

        if [ "$OT_ATTR_STATUS" = "200" ] && validate_json "$OT_ATTR_BODY"; then
            # The attributes API returns an array of attribute objects
            # Check if response is an array or needs to be wrapped
            if echo "$OT_ATTR_BODY" | jq -e 'type == "array"' >/dev/null 2>&1; then
                # Response is already an array
                ATTRIBUTES_ARRAY="$OT_ATTR_BODY"
            else
                # Response might be a single object, wrap in array
                ATTRIBUTES_ARRAY=$(echo "$OT_ATTR_BODY" | jq -c '[.]' 2>/dev/null)
            fi

            # Combine object type with its attributes array (ENSURE COMPACT JSON)
            ENHANCED_OBJECT_TYPE=$(echo "$object_type" | jq -c --argjson attrs "$ATTRIBUTES_ARRAY" '. + {attributes: $attrs}' 2>/dev/null)
            if [ -n "$ENHANCED_OBJECT_TYPE" ] && [ "$ENHANCED_OBJECT_TYPE" != "null" ]; then
                echo "$ENHANCED_OBJECT_TYPE" > "$temp_dir/ot_${OBJECT_TYPE_ID}.json"
                echo "    Successfully added $(echo "$ATTRIBUTES_ARRAY" | jq 'length' 2>/dev/null || echo "0") attributes for $OBJECT_TYPE_NAME"
            else
                # If enhancement fails, keep the base object type (also compact)
                echo "$object_type" | jq -c '.' > "$temp_dir/ot_${OBJECT_TYPE_ID}.json"
                echo "    Warning: Failed to enhance object type with attributes for $OBJECT_TYPE_NAME"
            fi
        else
            echo "    Warning: Failed to fetch attributes for object type '$OBJECT_TYPE_NAME' (HTTP $OT_ATTR_STATUS)"
            # Keep the base object type without attributes
            echo "$object_type" > "$temp_dir/ot_${OBJECT_TYPE_ID}.json"
        fi
        rm -f "$OT_ATTR_RESPONSE_FILE"
    }

    # Reusable function for parallel individual object attribute fetching
    fetch_individual_object_attributes() {
        local base_object="$1"
        local temp_dir="$2"
        local object_prefix="${3:-obj}"

        # Ensure temp directory exists
        if [ ! -d "$temp_dir" ]; then
            mkdir -p "$temp_dir" 2>/dev/null || return
        fi

        OBJECT_ID=$(echo "$base_object" | jq -r '.id' 2>/dev/null)
        if [ -n "$OBJECT_ID" ] && [ "$OBJECT_ID" != "null" ]; then
            # Fetch attributes for this specific object
            ATTR_URL="$BASE_API_URL/assets/1.0/object/$OBJECT_ID/attributes"
            ATTR_RESPONSE_FILE=$(api_call "$ATTR_URL")
            ATTR_STATUS=$(get_response_status "$ATTR_RESPONSE_FILE")
            ATTR_BODY=$(get_response_body "$ATTR_RESPONSE_FILE")

            if [ "$ATTR_STATUS" = "200" ] && validate_json "$ATTR_BODY"; then
                # Combine base object with fetched attributes
                ENHANCED_OBJECT=$(echo "$base_object" | jq --argjson attrs "$ATTR_BODY" '. + {attributes: $attrs}' 2>/dev/null)
                if [ -n "$ENHANCED_OBJECT" ] && [ "$ENHANCED_OBJECT" != "null" ]; then
                    echo "$ENHANCED_OBJECT" > "$temp_dir/${object_prefix}_${OBJECT_ID}.json"
                else
                    echo "$base_object" > "$temp_dir/${object_prefix}_${OBJECT_ID}.json"
                fi
            else
                # If individual attribute fetch fails, keep the base object
                echo "$base_object" > "$temp_dir/${object_prefix}_${OBJECT_ID}.json"
            fi
            rm -f "$ATTR_RESPONSE_FILE"
        fi
    }

    # Reusable function for debug file saving
    save_debug_file_if_needed() {
        local response_body="$1"
        local type_id="$2"
        local type_name="$3"
        local page_num="$4"
        local page_count="$5"
        local indent="${6:-      }"

        if [ "$page_num" -eq 1 ] || [ "${page_count:-0}" -eq 0 ]; then
            if [ "$(echo "$response_body" | wc -c)" -gt 100000 ] || [ "${page_count:-0}" -eq 0 ]; then
                DEBUG_FILENAME="/tmp/debug_response_${type_id}_${type_name}_page${page_num}.json"
                echo "$response_body" > "$DEBUG_FILENAME"
                echo "${indent}DEBUG: Saved debug file: $DEBUG_FILENAME ($(wc -c < "$DEBUG_FILENAME") bytes)"
            fi
        fi
    }

    # Reusable function for temp file operations with optional enhancement
    finalize_temp_file() {
        local temp_file="$1"
        local output_file="$2"
        local type_name="$3"
        local indent="${4:-          }"
        local attachments_base_dir="${5:-}"

        if [ -f "$temp_file" ] && [ -s "$temp_file" ]; then
            # Check if we need to enhance objects with references
            if [ "$FETCH_REFERENCES" = "true" ]; then
                # Count total objects for progress tracking
                TOTAL_TO_ENHANCE=$(wc -l < "$temp_file" | tr -d ' ')
                echo "${indent}Enhancing $TOTAL_TO_ENHANCE objects with metadata (references: $FETCH_REFERENCES)..."
                echo "${indent}Note: This will make additional API calls for each object"

                ENHANCED_TEMP=$(mktemp)
                OBJECT_NUM=0
                OBJECTS_WITH_TICKETS=0
                OBJECTS_WITH_REFS=0
                ENHANCEMENT_START_TIME=$(date +%s)

                # Use full parallel processing - only reduce workers when errors actually occur
                METADATA_WORKERS=$PARALLEL_WORKERS
                echo "${indent}Processing $TOTAL_TO_ENHANCE objects with $METADATA_WORKERS parallel workers"

                # Check if we should use parallel processing
                if [ "$METADATA_WORKERS" -eq 1 ]; then
                    echo "${indent}Running in sequential mode"
                    # Sequential processing
                    while IFS= read -r object; do
                        if [ -n "$object" ] && [ "$object" != "null" ]; then
                            OBJECT_NUM=$((OBJECT_NUM + 1))
                            # Show progress every 50 objects
                            if [ $((OBJECT_NUM % 50)) -eq 0 ]; then
                                echo "${indent}Progress: $OBJECT_NUM/$TOTAL_TO_ENHANCE objects processed..."
                            fi
                            ENHANCED=$(enhance_object_with_metadata "$object" "$FETCH_REFERENCES" "$attachments_base_dir" "$OBJECT_NUM" "$TOTAL_TO_ENHANCE")
                            printf '%s\n' "$ENHANCED" >> "$ENHANCED_TEMP"
                        else
                            printf '%s\n' "$object" >> "$ENHANCED_TEMP"
                        fi
                    done < "$temp_file"
                else
                    # Process objects in parallel for speedup (with reduced workers for large datasets)
                    echo "${indent}Processing with $METADATA_WORKERS parallel workers..."

                # Create temp directory for parallel processing
                PARALLEL_WORK_DIR=$(mktemp -d)

                # Split input file into chunks for parallel processing
                CHUNK_SIZE=$(( (TOTAL_TO_ENHANCE + METADATA_WORKERS - 1) / METADATA_WORKERS ))
                export CHUNK_SIZE TOTAL_TO_ENHANCE
                split -l "$CHUNK_SIZE" "$temp_file" "$PARALLEL_WORK_DIR/chunk_"

                # Process each chunk in parallel
                process_chunk() {
                    local chunk_file="$1"
                    local chunk_num="$2"
                    local output_file="${chunk_file}.enhanced"
                    local line_num=0

                    while IFS= read -r object; do
                        line_num=$((line_num + 1))
                        if [ -n "$object" ] && [ "$object" != "null" ]; then
                            # Calculate global object number
                            local global_num=$((chunk_num * CHUNK_SIZE + line_num))
                            ENHANCED=$(enhance_object_with_metadata "$object" "$FETCH_REFERENCES" "$attachments_base_dir" "$global_num" "$TOTAL_TO_ENHANCE")

                            printf '%s\n' "$ENHANCED" >> "$output_file"
                        else
                            printf '%s\n' "$object" >> "$output_file"
                        fi
                    done < "$chunk_file"
                }
                export -f process_chunk

                # Run chunks in parallel
                CHUNK_NUM=0
                TOTAL_CHUNKS=$(ls -1 "$PARALLEL_WORK_DIR"/chunk_* 2>/dev/null | wc -l)
                echo "${indent}Split into $TOTAL_CHUNKS chunks for parallel processing"

                for chunk_file in "$PARALLEL_WORK_DIR"/chunk_*; do
                    [ -f "$chunk_file" ] || continue
                    # Run process_chunk in background with unbuffered output
                    ( process_chunk "$chunk_file" "$CHUNK_NUM" ) &
                    CHUNK_NUM=$((CHUNK_NUM + 1))

                    # Limit parallel jobs
                    while [ $(jobs -r | wc -l) -ge "$METADATA_WORKERS" ]; do
                        sleep 0.1
                    done
                done

                # Wait for all background jobs to complete with progress
                echo "${indent}Processing objects in parallel..."
                MONITOR_START=$(date +%s)
                while [ $(jobs -r | wc -l) -gt 0 ]; do
                    JOBS_RUNNING=$(jobs -r | wc -l)
                    ELAPSED=$(($(date +%s) - MONITOR_START))
                    COMPLETED_FILES=$(ls -1 "$PARALLEL_WORK_DIR"/chunk_*.enhanced 2>/dev/null | wc -l)
                    # Update status every 5 seconds
                    if [ $((ELAPSED % 5)) -eq 0 ]; then
                        echo "${indent}Progress: $COMPLETED_FILES/$TOTAL_CHUNKS chunks completed (${ELAPSED}s elapsed, $JOBS_RUNNING workers active)"
                    fi
                    sleep 1
                done
                echo "${indent}All chunks processed successfully"

                # Combine all enhanced chunks with proper validation
                echo "INFO: ${indent}Combining $TOTAL_CHUNKS enhanced chunks..."
                if ! safe_combine_chunks "$PARALLEL_WORK_DIR" "$ENHANCED_TEMP"; then
                    echo "WARNING: ${indent}WARN: Some chunks failed to combine, but proceeding with available data"
                fi

                # CRITICAL VERIFICATION: Check if combined file has data
                if [ -f "$ENHANCED_TEMP" ]; then
                    local combined_size=$(wc -c < "$ENHANCED_TEMP" 2>/dev/null || echo "0")
                    local combined_count=$(jq 'length' "$ENHANCED_TEMP" 2>/dev/null || echo "0")
                    echo "INFO: ${indent}Combined file size: $combined_size bytes, object count: $combined_count"

                    if [ "$combined_count" -eq 0 ]; then
                        echo "ERROR: ${indent}CRITICAL: Combined file has 0 objects but we processed $TOTAL_TO_ENHANCE objects!"
                        echo "ERROR: ${indent}This indicates data was lost during chunk combination"
                        echo "ERROR: ${indent}Check chunk files in: $PARALLEL_WORK_DIR"

                        # List all chunk files for debugging
                        echo "ERROR: ${indent}Chunk files present:"
                        ls -lh "$PARALLEL_WORK_DIR"/chunk_*.enhanced 2>/dev/null | while read -r line; do
                            echo "ERROR: ${indent}  $line"
                        done
                    fi
                else
                    echo "ERROR: ${indent}CRITICAL: Enhanced temp file does not exist after combination!"
                fi

                # Clean up parallel work directory (but keep it if data was lost for debugging)
                if [ "$combined_count" -gt 0 ]; then
                    rm -rf "$PARALLEL_WORK_DIR"
                else
                    echo "ERROR: ${indent}Preserving chunk directory for debugging: $PARALLEL_WORK_DIR"
                fi
                fi  # End of parallel processing block

                # Count objects with references for summary
                if [ "$FETCH_REFERENCES" = "true" ]; then
                    OBJECTS_WITH_REFS=$(grep -c '"numberOfReferencedObjects":[1-9]' "$ENHANCED_TEMP" 2>/dev/null || echo "0")
                fi

                # Report completion time and summary
                ENHANCEMENT_END_TIME=$(date +%s)
                TOTAL_ENHANCEMENT_TIME=$((ENHANCEMENT_END_TIME - ENHANCEMENT_START_TIME))
                echo "${indent}Enhancement completed in ${TOTAL_ENHANCEMENT_TIME} seconds"

                # Show summary statistics
                if [ "$FETCH_REFERENCES" = "true" ]; then
                    echo "${indent}    Objects with references: $OBJECTS_WITH_REFS/$TOTAL_TO_ENHANCE"
                fi

                # Use enhanced objects for final output with validation
                if [[ -f "$ENHANCED_TEMP" && -s "$ENHANCED_TEMP" ]]; then
                    if jq empty "$ENHANCED_TEMP" 2>/dev/null; then
                        # $ENHANCED_TEMP is already a valid JSON array from safe_combine_chunks
                        # Just move it to the output file, don't re-wrap it with jq -s
                        if cat "$ENHANCED_TEMP" > "$output_file" 2>/dev/null; then
                            echo "DEBUG: ${indent}Successfully created final JSON from enhanced data"
                        else
                            echo "${indent}ERROR: Failed to create final JSON array, using empty array" >&2
                            echo "[]" > "$output_file"
                        fi
                    else
                        echo "${indent}ERROR: Invalid JSON in enhanced temp file, using empty array" >&2
                        echo "[]" > "$output_file"
                    fi
                    rm -f "$ENHANCED_TEMP"
                else
                    echo "WARNING: ${indent}Enhanced temp file is empty or missing"
                    echo "[]" > "$output_file"
                fi
            else
                # No enhancement needed, process normally with validation
                if [[ -f "$temp_file" && -s "$temp_file" ]]; then
                    if jq empty "$temp_file" 2>/dev/null; then
                        if jq -s '.' "$temp_file" > "$output_file" 2>/dev/null; then
                            echo "DEBUG: ${indent}Successfully created final JSON from temp data"
                        else
                            echo "${indent}ERROR: Failed to create final JSON array, using empty array" >&2
                            echo "[]" > "$output_file"
                        fi
                    else
                        echo "${indent}ERROR: Invalid JSON in temp file, using empty array" >&2
                        echo "[]" > "$output_file"
                    fi
                else
                    echo "WARNING: ${indent}Temp file is empty or missing"
                    echo "[]" > "$output_file"
                fi
            fi

            FINAL_COUNT=$(jq 'length' "$output_file" 2>/dev/null || echo "0")
            echo "${indent}Saved $FINAL_COUNT objects to $output_file"
        else
            echo "${indent}No objects found for '$type_name'"
        fi
        rm -f "$temp_file"
    }

    # Function to try POST AQL fallback for child types
    try_post_aql_fallback() {
        local aql_query="$1"
        local schema_id="$2"
        local page_num="$3"
        local page_size="$4"
        local type_name="$5"

        echo "          DEBUG: Trying POST AQL fallback for '$type_name'..."

        # Create POST data
        POST_DATA=$(cat << EOF
{
    "page": $page_num,
    "objectSchemaId": $schema_id,
    "qlQuery": "$aql_query",
    "resultsPerPage": $page_size,
    "includeAttributes": true
}
EOF
)

        POST_URL="$BASE_API_URL/assets/1.0/object/navlist/aql"
        echo "          DEBUG: POST URL: $POST_URL"

        # Create temp file for POST data
        POST_DATA_FILE=$(mktemp)
        echo "$POST_DATA" > "$POST_DATA_FILE"

        # Make POST request and structure like api_call output
        POST_RESPONSE_TEMP=$(mktemp)
        curl $CURL_API_OPTS -w "\n%{http_code}" \
             -u "$USERNAME:$PASSWORD" \
             -X POST \
             -H "Accept: application/json" \
             -H "Content-Type: application/json" \
             --data @"$POST_DATA_FILE" \
             "$POST_URL" > "$POST_RESPONSE_TEMP"

        # Parse and structure response
        POST_STATUS=$(tail -n1 "$POST_RESPONSE_TEMP")
        POST_BODY_TEMP=$(mktemp)
        sed '$d' "$POST_RESPONSE_TEMP" > "$POST_BODY_TEMP"

        # Create structured response file
        POST_RESPONSE_FILE=$(mktemp)
        {
            echo "STATUS:$POST_STATUS"
            echo "BODY_START"
            cat "$POST_BODY_TEMP"
            echo "BODY_END"
        } > "$POST_RESPONSE_FILE"

        # Cleanup temp files
        rm -f "$POST_DATA_FILE" "$POST_RESPONSE_TEMP" "$POST_BODY_TEMP"

        echo "          DEBUG: POST HTTP Status: $POST_STATUS"

        # Return the response file path
        echo "$POST_RESPONSE_FILE"
    }

    # Function to load all custom fields and cache them (with parallel-safe locking)
    load_custom_fields_cache() {
        # DISABLED: No caching - all field lookups are done via direct API calls
        return 0

        # Check if cache file already exists and is valid (parallel-safe check)
        if [ -f "$CUSTOM_FIELD_CACHE_FILE" ] && [ -s "$CUSTOM_FIELD_CACHE_FILE" ]; then
            CUSTOM_FIELD_CACHE_LOADED=true
            return 0
        fi

        # Use file locking to prevent multiple parallel processes from loading simultaneously
        local lock_acquired=false
        local lock_attempts=0
        local max_lock_attempts=30

        while [ $lock_attempts -lt $max_lock_attempts ]; do
            if mkdir "$CUSTOM_FIELD_CACHE_LOCK_FILE" 2>/dev/null; then
                lock_acquired=true
                break
            fi
            lock_attempts=$((lock_attempts + 1))
            sleep 1

            # Check if another process completed the cache while we were waiting
            if [ -f "$CUSTOM_FIELD_CACHE_FILE" ] && [ -s "$CUSTOM_FIELD_CACHE_FILE" ]; then
                CUSTOM_FIELD_CACHE_LOADED=true
                return 0
            fi
        done

        if [ "$lock_acquired" = false ]; then
            echo "                  WARNING: Could not acquire lock for custom field cache loading" >&2
            # Try to use existing cache if available, even if potentially incomplete
            if [ -f "$CUSTOM_FIELD_CACHE_FILE" ]; then
                CUSTOM_FIELD_CACHE_LOADED=true
                return 0
            fi
            return 1
        fi

        # Double-check if cache was created while acquiring lock
        if [ -f "$CUSTOM_FIELD_CACHE_FILE" ] && [ -s "$CUSTOM_FIELD_CACHE_FILE" ]; then
            rmdir "$CUSTOM_FIELD_CACHE_LOCK_FILE" 2>/dev/null
            CUSTOM_FIELD_CACHE_LOADED=true
            return 0
        fi

        echo "                  Loading custom field definitions..." >&2
        echo "                  DEBUG: Using cache file: $CUSTOM_FIELD_CACHE_FILE" >&2

        # Fetch all custom fields with pagination support
        local page_start=0
        local page_size=100
        local total_loaded=0

        while true; do
            local cf_url="$JIRA_URL/rest/api/2/customFields?startAt=$page_start&maxResults=$page_size"
            local cf_response_file=$(api_call "$cf_url")
            local cf_status=$(get_response_status "$cf_response_file")

            if [ "$cf_status" != "200" ]; then
                echo "                  WARNING: Failed to fetch custom fields (HTTP $cf_status)" >&2
                echo "                  DEBUG: URL was: $cf_url" >&2
                rm -f "$cf_response_file"
                break
            fi

            local cf_body=$(get_response_body "$cf_response_file")
            echo "                  DEBUG: Response body size: $(echo "$cf_body" | wc -c) characters" >&2

            # Parse and store custom fields (format: customfield_ID:name)
            # Try both .values[] (paginated) and .[] (non-paginated) formats
            local page_fields=$(echo "$cf_body" | jq -r '
                if .values then
                    .values[] | "\(.id):\(.name)"
                else
                    .[] | select(.custom == true) | "\(.id):\(.name)"
                end
            ' 2>/dev/null)

            if [ -z "$page_fields" ]; then
                echo "                  DEBUG: No fields found in this page, breaking" >&2
                rm -f "$cf_response_file"
                break
            fi

            echo "$page_fields" >> "$CUSTOM_FIELD_CACHE_FILE"
            local page_count=$(echo "$page_fields" | wc -l | tr -d ' ')
            total_loaded=$((total_loaded + page_count))
            echo "                  DEBUG: Page $((page_start/page_size + 1)): Found $page_count fields (total: $total_loaded)" >&2

            # Check if we need more pages
            local total_available=$(echo "$cf_body" | jq -r '.total // 0' 2>/dev/null)

            rm -f "$cf_response_file"

            if [ "$total_available" -gt 0 ] && [ "$total_loaded" -ge "$total_available" ]; then
                break
            fi

            if [ "$page_count" -lt "$page_size" ]; then
                break
            fi

            page_start=$((page_start + page_size))

            # Safety limit
            if [ "$page_start" -gt 5000 ]; then
                echo "                  WARNING: Reached custom field pagination limit" >&2
                break
            fi
        done

        CUSTOM_FIELD_CACHE_LOADED=true
        echo "                  Loaded $total_loaded custom field definitions" >&2

        # Release the lock
        rmdir "$CUSTOM_FIELD_CACHE_LOCK_FILE" 2>/dev/null

        return 0
    }

    # Function to get custom field name by ID (with local JSON cache)
    get_custom_field_name() {
        local field_id="$1"

        # This function is deprecated - custom fields are now extracted in Phase 2
        # Keeping for backward compatibility but always returns unknown
        echo "Unknown Field ($field_id)"
        return 0

        # Initialize cache file if it doesn't exist
        if [ ! -f "$CUSTOM_FIELD_CACHE_FILE" ]; then
            echo "{}" > "$CUSTOM_FIELD_CACHE_FILE"
            echo "                  Created custom field cache file: $CUSTOM_FIELD_CACHE_FILE" >&2
        fi

        # First, check if field is already in local cache
        local cached_name=$(jq -r --arg field_id "$field_id" '.[$field_id] // empty' "$CUSTOM_FIELD_CACHE_FILE" 2>/dev/null)
        if [ -n "$cached_name" ] && [ "$cached_name" != "null" ]; then
            echo "                  Found $field_id in local cache: '$cached_name'" >&2
            echo "$cached_name"
            return 0
        fi

        echo "                  Field $field_id not in cache, fetching ALL custom fields from API..." >&2

        # Use broader customFields API call to get ALL fields (no pagination - get all 625+ at once)
        local broad_url="$JIRA_URL/rest/api/2/customFields?maxResults=1000"
        local broad_response_file=$(api_call "$broad_url")
        local broad_status=$(get_response_status "$broad_response_file")

        if [ "$broad_status" = "200" ]; then
            local broad_body=$(get_response_body "$broad_response_file")

            # Look for our specific field in ALL fields
            local found_name=$(echo "$broad_body" | jq -r --arg target_id "$field_id" '
                .values[]? | select(.id == $target_id or ("customfield_" + (.numericId | tostring)) == $target_id) | .name // empty
            ' 2>/dev/null)

            if [ -n "$found_name" ]; then
                echo "                  SUCCESS: Found field name '$found_name' for $field_id" >&2

                # Add to local cache (with file locking for parallel safety)
                local temp_cache=$(mktemp)
                local lock_file="${CUSTOM_FIELD_CACHE_FILE}.lock"

                # Simple file locking mechanism
                local lock_attempts=0
                while [ $lock_attempts -lt 10 ]; do
                    if mkdir "$lock_file" 2>/dev/null; then
                        # Lock acquired, update cache
                        jq --arg field_id "$field_id" --arg field_name "$found_name" '. + {($field_id): $field_name}' "$CUSTOM_FIELD_CACHE_FILE" > "$temp_cache"
                        mv "$temp_cache" "$CUSTOM_FIELD_CACHE_FILE"
                        rmdir "$lock_file"
                        echo "                  Added $field_id to local cache" >&2
                        break
                    else
                        # Lock not available, wait briefly
                        sleep 0.1
                        lock_attempts=$((lock_attempts + 1))
                    fi
                done

                # Clean up temp file if locking failed
                rm -f "$temp_cache"

                echo "$found_name"
                rm -f "$broad_response_file"
                return 0
            else
                local total_fields=$(echo "$broad_body" | jq -r '.total // 0' 2>/dev/null)
                local fetched_fields=$(echo "$broad_body" | jq -r '.values | length' 2>/dev/null)
                echo "                  Field $field_id not found in $fetched_fields/$total_fields custom fields" >&2
            fi
        else
            echo "                  ERROR: API call failed (HTTP $broad_status)" >&2
        fi

        rm -f "$broad_response_file"

        # If all else fails, return the unknown format
        echo "                  ERROR: Could not find field name for $field_id" >&2
        echo "Unknown Field ($field_id)"
        return 1
    }

    # Function to identify custom fields using individual ticket fetching (OPTIMIZED)
    # Instead of complex JQL chunking, fetch each ticket individually and extract custom field info directly
    # This eliminates URL length issues and simplifies custom field identification
    batch_identify_custom_fields_smart() {
        local object_key="$1"
        local object_id="$2"
        local object_label="$3"
        local tickets_data="$4"  # JSON array of tickets from connected tickets API

        # Skip if object key is empty or no tickets
        if [ -z "$object_key" ] || [ "$object_key" = "null" ] || [ -z "$tickets_data" ] || [ "$tickets_data" = "[]" ]; then
            echo "$tickets_data"
            return
        fi

        local ticket_count=$(echo "$tickets_data" | jq 'length' 2>/dev/null || echo "0")
        echo "DEBUG: INDIVIDUAL: Processing custom fields for $ticket_count connected tickets of object $object_key..."

        # Process tickets to find custom fields containing the asset reference
        local enhanced_tickets=$(mktemp)
        local tickets_with_fields=0
        local tickets_processed=0

        # Write individual tickets to temp file to avoid subshell issues with pipe
        local tickets_temp=$(mktemp)
        echo "$tickets_data" | jq -c '.[]' > "$tickets_temp"

        # Process each ticket individually (no pipe, no subshell!)
        while IFS= read -r original_ticket; do
            if [ -n "$original_ticket" ] && [ "$original_ticket" != "null" ]; then
                local ticket_key=$(echo "$original_ticket" | jq -r '.key // ""' 2>/dev/null)
                tickets_processed=$((tickets_processed + 1))

                if [ -n "$ticket_key" ] && [ "$ticket_key" != "null" ]; then
                    # Fetch individual ticket details to get all custom fields
                    local issue_url="$JIRA_URL/rest/api/2/issue/$ticket_key"
                    local issue_response_file=$(api_call "$issue_url")
                    local issue_status=$(get_response_status "$issue_response_file")

                    if [ "$issue_status" = "200" ]; then
                        # Use file-based processing to avoid variable corruption
                        local issue_body_file=$(get_response_body_to_file "$issue_response_file")

                        # Dynamically find ONLY ASSET REFERENCE custom fields that contain the object
                        # Asset fields are ARRAYS with format ["Label (KEY-ID)"] or contain the object key
                        # Text fields are plain strings and should be IGNORED
                        local custom_fields_file=$(mktemp)
                        jq --arg objkey "$object_key" --arg objid "$object_id" --arg label "$object_label" '
                            .fields | to_entries | map(select(
                                (.key | startswith("customfield_")) and
                                .value != null and
                                # ONLY match ARRAY fields (asset reference fields)
                                (.value | type == "array") and
                                any(.value[];
                                    type == "string" and (
                                        # Match exact object key (e.g., "AAP-36956")
                                        test($objkey; "i") or
                                        # Match pattern "Label (KEY)" where KEY matches our object
                                        test("\\(" + $objkey + "\\)"; "i") or
                                        # For objects without keys, match by label in array format
                                        (($objkey == "" or $objkey == null) and test($label; "i"))
                                    )
                                )
                            )) | map({
                                datacenterFieldId: .key,
                                fieldValue: .value,
                                datacenterFieldName: .key
                            })' "$issue_body_file" > "$custom_fields_file" 2>/dev/null

                        local field_count=$(jq 'length' "$custom_fields_file" 2>/dev/null || echo "0")

                        if [ "$field_count" -gt 0 ]; then
                            # Enhance custom field names using cache or API
                            local enhanced_fields=$(mktemp)
                            local fields_list=$(mktemp)
                            jq -c '.[]' "$custom_fields_file" > "$fields_list"

                            # Process each field without pipe (avoids subshell)
                            while IFS= read -r field; do
                                if [ -n "$field" ] && [ "$field" != "null" ]; then
                                    local field_id=$(echo "$field" | jq -r '.datacenterFieldId' 2>/dev/null)

                                    # Try to get proper field name from cache first, then from API response
                                    local field_name=$(get_custom_field_name "$field_id" 2>/dev/null)
                                    if [ -z "$field_name" ] || [ "$field_name" = "null" ]; then
                                        # Extract name from the schema in the API response if available
                                        field_name=$(jq -r --arg fid "$field_id" '.fields[$fid].schema.customId // .fields[$fid].name // $fid' "$issue_body_file" 2>/dev/null)
                                        if [ -z "$field_name" ] || [ "$field_name" = "null" ]; then
                                            field_name="Asset Field $field_id"
                                        fi
                                    fi

                                    echo "$field" | jq --arg name "$field_name" '.datacenterFieldName = $name' >> "$enhanced_fields"
                                fi
                            done < "$fields_list"
                            rm -f "$fields_list"

                            # Build the custom fields array in a file (avoid shell variable)
                            local custom_fields_final=$(mktemp)
                            if [ -f "$enhanced_fields" ] && [ -s "$enhanced_fields" ]; then
                                jq -s '.' "$enhanced_fields" > "$custom_fields_final" 2>/dev/null
                            else
                                echo "[]" > "$custom_fields_final"
                            fi
                            rm -f "$enhanced_fields"

                            # Add custom field info to original ticket using file
                            local enhanced_ticket=$(echo "$original_ticket" | jq --slurpfile fields "$custom_fields_final" '. + {customFieldsContainingObject: $fields[0]}' 2>/dev/null)
                            echo "$enhanced_ticket" >> "$enhanced_tickets"
                            tickets_with_fields=$((tickets_with_fields + 1))

                            # Track statistics
                            TOTAL_TICKETS_WITH_CUSTOM_FIELDS=$((TOTAL_TICKETS_WITH_CUSTOM_FIELDS + 1))
                            TOTAL_CUSTOM_FIELD_MAPPINGS=$((TOTAL_CUSTOM_FIELD_MAPPINGS + field_count))

                            echo "DEBUG: Found $field_count custom field(s) in ticket $ticket_key"

                            rm -f "$custom_fields_final"
                        else
                            # No matching custom fields found
                            echo "$original_ticket" >> "$enhanced_tickets"
                        fi

                        rm -f "$custom_fields_file" "$issue_body_file"
                    else
                        # Failed to fetch ticket, keep original
                        echo "WARNING: Failed to fetch ticket $ticket_key (HTTP $issue_status)"
                        echo "$original_ticket" >> "$enhanced_tickets"
                    fi

                    rm -f "$issue_response_file"
                else
                    # No ticket key, keep original
                    echo "$original_ticket" >> "$enhanced_tickets"
                fi
            fi
        done < "$tickets_temp"

        rm -f "$tickets_temp"

        echo "DEBUG: INDIVIDUAL: Processed $tickets_processed tickets, found custom fields in $tickets_with_fields tickets"

        # Combine enhanced tickets into array
        if [ -f "$enhanced_tickets" ] && [ -s "$enhanced_tickets" ]; then
            local enhanced_count=$(wc -l < "$enhanced_tickets" 2>/dev/null || echo "0")
            echo "DEBUG: INDIVIDUAL: Combining $enhanced_count enhanced ticket lines into array"

            # CRITICAL: Create result file, don't load into variable
            local result_file=$(mktemp)
            if jq -s '.' "$enhanced_tickets" > "$result_file" 2>/dev/null; then
                local result_count=$(jq 'length' "$result_file" 2>/dev/null || echo "0")

                echo "DEBUG: INDIVIDUAL: Final result array has $result_count tickets (expected: $ticket_count)"

                if [ "$result_count" -ne "$ticket_count" ]; then
                    echo "ERROR: INDIVIDUAL: CRITICAL - Lost tickets during processing!"
                    echo "ERROR: INDIVIDUAL: Started with $ticket_count tickets, ended with $result_count"
                fi

                # Output to stdout, caller must handle it carefully
                cat "$result_file"
                rm -f "$result_file"
            else
                echo "ERROR: INDIVIDUAL: Failed to combine enhanced tickets to JSON array"
                echo "$tickets_data"
            fi
        else
            echo "WARNING: INDIVIDUAL: enhanced_tickets file is missing or empty, returning original tickets_data"
            echo "DEBUG: INDIVIDUAL: File exists: $([ -f "$enhanced_tickets" ] && echo "yes" || echo "no"), Size: $(wc -c < "$enhanced_tickets" 2>/dev/null || echo 0) bytes"
            echo "$tickets_data"
        fi

        rm -f "$enhanced_tickets"
    }

    # Function to identify which custom fields contain an object reference in an issue
    identify_custom_fields_for_object() {
        local issue_key="$1"
        local object_key="$2"
        local object_id="$3"
        local object_label="$4"

        # Skip if object key is empty (can't match in custom fields)
        if [ -z "$object_key" ] || [ "$object_key" = "null" ]; then
            echo "[]"
            return
        fi

        # Debug logging for custom field identification
        if [ "$DEBUG_ATTACHMENTS" = "true" ]; then
            echo "                  Fetching issue $issue_key to identify custom fields for object $object_key" >&2
        fi

        # Fetch full issue details
        ISSUE_URL="$JIRA_URL/rest/api/2/issue/$issue_key"
        ISSUE_RESPONSE_FILE=$(api_call "$ISSUE_URL")
        ISSUE_STATUS=$(get_response_status "$ISSUE_RESPONSE_FILE")

        if [ "$ISSUE_STATUS" != "200" ]; then
            if [ "$PARALLEL_WORKERS" -le 1 ]; then
                echo "                  WARNING: Failed to fetch issue $issue_key (HTTP $ISSUE_STATUS)" >&2
            fi
            echo "[]"
            rm -f "$ISSUE_RESPONSE_FILE"
            return
        fi

        ISSUE_BODY=$(get_response_body "$ISSUE_RESPONSE_FILE")

        # Search for the object reference in all fields
        # We look for patterns like: objectKey (e.g., AAM-53596), object ID, or label with key
        CUSTOM_FIELD_IDS=$(echo "$ISSUE_BODY" | jq -r --arg objkey "$object_key" --arg objid "$object_id" --arg label "$object_label" '
            .fields | to_entries | map(select(
                (.key | startswith("customfield_")) and
                (
                    (.value | type == "array" and any(tostring | contains($objkey))) or
                    (.value | type == "string" and contains($objkey)) or
                    (.value | type == "object" and (tostring | contains($objkey))) or
                    (.value | type == "array" and any(tostring | contains($objid | tostring))) or
                    (.value | type == "string" and contains($objid | tostring)) or
                    (.value | type == "object" and (tostring | contains($objid | tostring)))
                )
            )) | map({
                datacenterFieldId: .key,
                fieldValue: .value
            })' 2>/dev/null || echo "[]")

        # Enhance each field with its name
        if [ -n "$CUSTOM_FIELD_IDS" ] && [ "$CUSTOM_FIELD_IDS" != "[]" ] && [ "$CUSTOM_FIELD_IDS" != "null" ]; then
            CUSTOM_FIELDS_TEMP=$(mktemp)
            echo "$CUSTOM_FIELD_IDS" | jq -c '.[]' | while IFS= read -r field_obj; do
                if [ -n "$field_obj" ] && [ "$field_obj" != "null" ]; then
                    FIELD_ID=$(echo "$field_obj" | jq -r '.datacenterFieldId' 2>/dev/null)
                    if [ -n "$FIELD_ID" ]; then
                        # Get the field name
                        FIELD_NAME=$(get_custom_field_name "$FIELD_ID")
                        # Add datacenterFieldName to the object
                        echo "$field_obj" | jq --arg name "$FIELD_NAME" '. + {datacenterFieldName: $name}' >> "$CUSTOM_FIELDS_TEMP"
                    else
                        echo "$field_obj" >> "$CUSTOM_FIELDS_TEMP"
                    fi
                fi
            done

            # Combine enhanced fields into array
            if [ -f "$CUSTOM_FIELDS_TEMP" ] && [ -s "$CUSTOM_FIELDS_TEMP" ]; then
                CUSTOM_FIELDS=$(jq -s '.' "$CUSTOM_FIELDS_TEMP")
            else
                CUSTOM_FIELDS="$CUSTOM_FIELD_IDS"
            fi
            rm -f "$CUSTOM_FIELDS_TEMP"
        else
            CUSTOM_FIELDS="$CUSTOM_FIELD_IDS"
        fi

        rm -f "$ISSUE_RESPONSE_FILE"

        # Return JSON object with custom field information
        if [ -n "$CUSTOM_FIELDS" ] && [ "$CUSTOM_FIELDS" != "[]" ] && [ "$CUSTOM_FIELDS" != "null" ]; then
            # Log which custom fields were found
            if [ "$PARALLEL_WORKERS" -le 1 ]; then
                FIELD_COUNT=$(echo "$CUSTOM_FIELDS" | jq 'length' 2>/dev/null || echo "0")
                if [ "$FIELD_COUNT" -gt 0 ]; then
                    # Show both field IDs and names
                    FIELD_INFO=$(echo "$CUSTOM_FIELDS" | jq -r '.[] | "\(.datacenterFieldId) (\(.datacenterFieldName))"' 2>/dev/null | tr '\n' ', ' | sed 's/, $//')
                    echo "                  Found object $object_key in $FIELD_COUNT custom field(s): $FIELD_INFO" >&2
                fi
            fi
            echo "$CUSTOM_FIELDS"
        else
            if [ "$PARALLEL_WORKERS" -le 1 ]; then
                echo "                  No custom fields found containing object $object_key in issue $issue_key" >&2
            fi
            echo "[]"
        fi
    }

    # Function to fetch reference info for an object
    fetch_object_reference_info() {
        local object_id="$1"

        REF_INFO_URL="$BASE_API_URL/assets/1.0/object/$object_id/referenceinfo"
        REF_RESPONSE_FILE=$(api_call "$REF_INFO_URL")
        REF_STATUS=$(get_response_status "$REF_RESPONSE_FILE")

        if [ "$REF_STATUS" = "200" ]; then
            REF_BODY=$(get_response_body "$REF_RESPONSE_FILE")
            # Extract reference information
            REF_DATA=$(echo "$REF_BODY" | jq '{referenceTypes: .referenceTypes, numberOfReferencedObjects: .numberOfReferencedObjects, openIssuesExists: .openIssuesExists}' 2>/dev/null)
            if [ -n "$REF_DATA" ] && [ "$REF_DATA" != "null" ]; then
                echo "$REF_DATA"
            else
                echo "{}"
            fi
        elif [ "$REF_STATUS" = "404" ]; then
            # 404 is common for objects without references - not an error
            echo "{}"
        elif [ "$REF_STATUS" = "503" ]; then
            echo "                ERROR: Failed to fetch references (HTTP $REF_STATUS) - Server overloaded" >&2
            echo "{}"
        else
            echo "                ERROR: Failed to fetch references (HTTP $REF_STATUS)" >&2
            echo "{}"
        fi

        rm -f "$REF_RESPONSE_FILE"
    }

    # Function to enhance object with tickets and references (optional, based on config)
    enhance_object_with_metadata() {
        local object="$1"
        local fetch_references="${2:-false}"
        local attachments_base_dir="${3:-}"
        local object_num="${4:-0}"
        local total_objects="${5:-0}"

        OBJECT_ID=$(echo "$object" | jq -r '.id' 2>/dev/null)
        if [ -z "$OBJECT_ID" ] || [ "$OBJECT_ID" = "null" ]; then
            echo "$object"
            return
        fi

        # Extract object key/name/label for logging and ticket enhancement
        OBJECT_KEY=$(echo "$object" | jq -r '.objectKey // ""' 2>/dev/null)
        OBJECT_LABEL=$(echo "$object" | jq -r '.label // .name // ""' 2>/dev/null)
        OBJECT_DISPLAY=$(echo "$object" | jq -r '.objectKey // .label // .id' 2>/dev/null)

        # Show progress and object details for sequential processing
        if [ "$PARALLEL_WORKERS" -le 1 ]; then
            if [ "$object_num" -eq 1 ] || [ "$object_num" -eq "$total_objects" ] || [ $((object_num % 10)) -eq 0 ]; then
                echo "            Enhancing object $object_num/$total_objects: $OBJECT_DISPLAY (ID: $OBJECT_ID)" >&2
                if [ "$DEBUG_ATTACHMENTS" = "true" ]; then
                    echo "            DEBUG: Object Key: '$OBJECT_KEY', Label: '$OBJECT_LABEL'" >&2
                fi
            fi
        fi

        ENHANCED_OBJECT="$object"

        # NOTE: Tickets are now stored in separate files per custom field in connectedTickets/ folder
        # We no longer inject connectedTickets into each object to keep objects.json smaller
        # The JavaScript will load custom field files separately and reference them

        # Add reference info if requested
        if [ "$fetch_references" = "true" ]; then
            REF_INFO=$(fetch_object_reference_info "$OBJECT_ID")
            if [ -n "$REF_INFO" ] && [ "$REF_INFO" != "{}" ]; then
                REF_COUNT=$(echo "$REF_INFO" | jq '.numberOfReferencedObjects // 0' 2>/dev/null)
                # Only log in sequential mode, not parallel
                if [ "$PARALLEL_WORKERS" -le 1 ] && [ "$REF_COUNT" -gt 0 ] && ([ "$object_num" -eq 1 ] || [ $((object_num % 10)) -eq 0 ]); then
                    echo "              Found $REF_COUNT referenced object(s) for $OBJECT_KEY" >&2
                fi
                ENHANCED_OBJECT=$(echo "$ENHANCED_OBJECT" | jq --argjson refs "$REF_INFO" '. + {referenceInfo: $refs}' 2>/dev/null)
            fi
        fi

        printf '%s\n' "$ENHANCED_OBJECT"
    }

    # Export function and variables for parallel execution
    export -f fetch_object_type_attributes fetch_individual_object_attributes save_debug_file_if_needed finalize_temp_file api_call validate_json get_response_status get_response_body get_response_body_to_file extract_objects_robust_from_file try_post_aql_fallback load_custom_fields_cache get_custom_field_name batch_identify_custom_fields_smart identify_custom_fields_for_object fetch_object_reference_info enhance_object_with_metadata
    export BASE_API_URL JIRA_URL USERNAME PASSWORD CURL_API_OPTS CURL_DOWNLOAD_OPTS FETCH_REFERENCES PARALLEL_WORKERS CUSTOM_FIELD_CACHE_FILE LOG_FILE

    # Create temp directory for parallel results
    PARALLEL_TEMP_DIR=$(mktemp -d)

    # Process object types in parallel (limit to 5 concurrent to avoid overwhelming server)
    # Use here-string to avoid subshell variable scope issues
    MAX_PARALLEL=5
    RUNNING_JOBS=0

    while IFS= read -r object_type; do
        if [ -z "$object_type" ]; then
            continue
        fi

        # Wait if we have too many background jobs
        while [ $RUNNING_JOBS -ge $MAX_PARALLEL ]; do
            # Try wait -n first, fallback to sleep if not available
            if ! wait -n 2>/dev/null; then
                sleep 0.1
                # Count running jobs manually
                RUNNING_JOBS=$(jobs -r | wc -l)
            else
                RUNNING_JOBS=$((RUNNING_JOBS - 1))
            fi
        done

        # Start background job
        (fetch_object_type_attributes "$object_type" "$PARALLEL_TEMP_DIR") &
        RUNNING_JOBS=$((RUNNING_JOBS + 1))
    done <<< "$OBJECT_TYPES"

    # Wait for all remaining jobs to complete
    wait

    # Collect results and provide debugging info
    ENHANCED_COUNT=0
    FAILED_COUNT=0

    for result_file in "$PARALLEL_TEMP_DIR"/ot_*.json; do
        if [ -f "$result_file" ]; then
            cat "$result_file" >> "$ENHANCED_OBJECT_TYPES_TEMP"
            ENHANCED_COUNT=$((ENHANCED_COUNT + 1))
        fi
    done

    # Check for any failed processing by comparing expected vs actual files
    EXPECTED_COUNT=$(echo "$OBJECT_TYPES" | wc -l | tr -d ' ')
    FAILED_COUNT=$((EXPECTED_COUNT - ENHANCED_COUNT))

    if [ $FAILED_COUNT -gt 0 ]; then
        echo "  DEBUG: $FAILED_COUNT object types failed parallel processing"
        echo "  DEBUG: Expected $EXPECTED_COUNT files, found $ENHANCED_COUNT files"
        echo "  DEBUG: Files in temp dir:"
        ls -la "$PARALLEL_TEMP_DIR"/ 2>/dev/null || echo "    (temp dir is empty or doesn't exist)"
    fi

    # Clean up parallel temp directory
    rm -rf "$PARALLEL_TEMP_DIR"

    # Replace OBJECT_TYPES with enhanced version (ensure proper line formatting)
    if [ -f "$ENHANCED_OBJECT_TYPES_TEMP" ] && [ -s "$ENHANCED_OBJECT_TYPES_TEMP" ]; then
        OBJECT_TYPES=$(cat "$ENHANCED_OBJECT_TYPES_TEMP")
        echo "  Successfully enhanced $ENHANCED_COUNT object types with attributes"
    else
        echo "  Warning: No enhanced object types found, using original object types"
        FAILED_COUNT=$EXPECTED_COUNT
    fi
    rm -f "$ENHANCED_OBJECT_TYPES_TEMP"

    # Debug: Check if object types are properly formatted
    OT_COUNT_CHECK=$(echo "$OBJECT_TYPES" | wc -l | tr -d ' ')
    echo "  DEBUG: Enhanced object types count: $OT_COUNT_CHECK"



    # First pass: Identify all parent-child relationships
    echo "  Analyzing object type hierarchy..."
    PARENT_CHILD_MAP=$(mktemp)
    echo "$OBJECT_TYPES" | while IFS= read -r object_type; do
        if [ -z "$object_type" ]; then
            continue
        fi

        # Debug: Show first 100 chars of object_type being processed
        echo "  DEBUG: Processing object type: $(echo "$object_type" | head -c 100)..." >&2

        OBJECT_TYPE_ID=$(echo "$object_type" | jq -r '.id' 2>/dev/null) || continue
        PARENT_ID=$(echo "$object_type" | jq -r '.parentObjectTypeId // empty' 2>/dev/null)

        echo "  DEBUG: Extracted ID: $OBJECT_TYPE_ID, Parent: $PARENT_ID" >&2

        if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "null" ]; then
            echo "$PARENT_ID:$OBJECT_TYPE_ID" >> "$PARENT_CHILD_MAP"
        fi
    done

    PARENT_CHILD_RELATIONSHIPS=$(cat "$PARENT_CHILD_MAP" 2>/dev/null || echo "")
    rm -f "$PARENT_CHILD_MAP"



    # CRITICAL: Sort object types hierarchically - parents must be processed before children
    # This prevents children from being processed as standalone before their parent adds them to SUCCESSFULLY_PROCESSED_CHILDREN
    echo "  Sorting object types hierarchically (parents before children)..."

    SORTED_OBJECT_TYPES=$(mktemp)
    PROCESSED_IDS_FILE=$(mktemp)
    REMAINING_TYPES_FILE=$(mktemp)
    echo "$OBJECT_TYPES" > "$REMAINING_TYPES_FILE"

    # Multiple passes to sort hierarchically
    MAX_PASSES=10
    for pass in $(seq 1 $MAX_PASSES); do
        TYPES_THIS_PASS=$(mktemp)
        NEW_REMAINING=$(mktemp)

        # Load processed IDs
        PROCESSED_IDS=$(cat "$PROCESSED_IDS_FILE" 2>/dev/null || echo "")

        # Find types that can be processed this pass (no parent or parent already processed)
        while IFS= read -r object_type; do
            if [ -z "$object_type" ]; then
                continue
            fi

            TYPE_ID=$(echo "$object_type" | jq -r '.id' 2>/dev/null)
            PARENT_ID=$(echo "$object_type" | jq -r '.parentObjectTypeId // null' 2>/dev/null)
            TYPE_NAME=$(echo "$object_type" | jq -r '.name' 2>/dev/null)

            # Can process if: no parent OR parent already processed
            if [ "$PARENT_ID" = "null" ] || [ -z "$PARENT_ID" ] || echo " $PROCESSED_IDS " | grep -q " $PARENT_ID "; then
                echo "$object_type" >> "$TYPES_THIS_PASS"
                # Append ID to the processed list (avoid duplicates)
                if ! echo " $PROCESSED_IDS " | grep -q " $TYPE_ID "; then
                    echo -n " $TYPE_ID" >> "$PROCESSED_IDS_FILE"
                fi
                # Debug: Only show for specific problematic schemas or verbose mode
                # echo "    Pass $pass: Adding '$TYPE_NAME' (ID: $TYPE_ID, Parent: ${PARENT_ID:-none})"
            else
                echo "$object_type" >> "$NEW_REMAINING"
            fi
        done < "$REMAINING_TYPES_FILE"

        # Add this pass's types to sorted list
        if [ -s "$TYPES_THIS_PASS" ]; then
            cat "$TYPES_THIS_PASS" >> "$SORTED_OBJECT_TYPES"
        fi

        # Update remaining types
        mv "$NEW_REMAINING" "$REMAINING_TYPES_FILE"
        rm -f "$TYPES_THIS_PASS"

        # If no remaining types, we're done
        if [ ! -s "$REMAINING_TYPES_FILE" ]; then
            echo "    Hierarchical sorting complete after $pass passes"
            break
        fi

        # Safety check - if we're not making progress, break
        if [ "$pass" -eq "$MAX_PASSES" ]; then
            echo "    Warning: Reached max passes, some types may have circular dependencies"
            cat "$REMAINING_TYPES_FILE" >> "$SORTED_OBJECT_TYPES"
            break
        fi
    done

    # Use sorted object types for processing
    OBJECT_TYPES=$(cat "$SORTED_OBJECT_TYPES")

    # Debug: Show the sorted order for problematic schemas
    if [ "$SCHEMA_NAME" = "Atlassian World Management" ]; then
        echo "  DEBUG: Sorted order for Atlassian World Management:"
        echo "$OBJECT_TYPES" | while IFS= read -r ot; do
            [ -z "$ot" ] && continue
            OT_NAME=$(echo "$ot" | jq -r '.name')
            OT_ID=$(echo "$ot" | jq -r '.id')
            OT_PARENT=$(echo "$ot" | jq -r '.parentObjectTypeId // "none"')
            echo "    - $OT_NAME (ID: $OT_ID, Parent: $OT_PARENT)"
        done
    fi

    rm -f "$SORTED_OBJECT_TYPES" "$PROCESSED_IDS_FILE" "$REMAINING_TYPES_FILE"

    echo "  Object types sorted hierarchically for proper parent-child processing"

    # Process each object type with hierarchy awareness
    # Use process substitution to avoid subshell variable scope issues
    while IFS= read -r object_type; do
        if [ -z "$object_type" ]; then
            continue
        fi

        OBJECT_TYPE_ID=""
        OBJECT_TYPE_NAME=""
        PARENT_OBJECT_TYPE_ID=""

        OBJECT_TYPE_ID=$(echo "$object_type" | jq -r '.id' 2>/dev/null) || OBJECT_TYPE_ID=""
        OBJECT_TYPE_NAME=$(echo "$object_type" | jq -r '.name' 2>/dev/null) || OBJECT_TYPE_NAME=""
        PARENT_OBJECT_TYPE_ID=$(echo "$object_type" | jq -r '.parentObjectTypeId // empty' 2>/dev/null)



        if [ -z "$OBJECT_TYPE_ID" ] || [ -z "$OBJECT_TYPE_NAME" ]; then
            echo "    Warning: Could not extract ID or name from object type. Skipping."
            continue
        fi

        # Skip if this object type is a child of another concrete object type AND was successfully processed as a child
        if [ -n "$PARENT_OBJECT_TYPE_ID" ] && [ "$PARENT_OBJECT_TYPE_ID" != "null" ]; then
            # Check if parent exists in our object types (not abstract)
            PARENT_EXISTS=$(echo "$OBJECT_TYPES" | jq -c ". | select(.id == $PARENT_OBJECT_TYPE_ID)" 2>/dev/null)
            if [ -n "$PARENT_EXISTS" ]; then
                PARENT_IS_ABSTRACT=$(echo "$PARENT_EXISTS" | jq -r '.abstractObjectType // false' 2>/dev/null)
                PARENT_NAME=$(echo "$PARENT_EXISTS" | jq -r '.name // "Unknown"' 2>/dev/null)
                echo "    DEBUG: Object type '$OBJECT_TYPE_NAME' has parent '$PARENT_NAME' (ID: $PARENT_OBJECT_TYPE_ID, Abstract: $PARENT_IS_ABSTRACT)"

                # Check if already processed as a child FIRST, regardless of parent type
                if echo " $SUCCESSFULLY_PROCESSED_CHILDREN " | grep -q " $OBJECT_TYPE_ID "; then
                    echo "    SKIPPING '$OBJECT_TYPE_NAME' (ID: $OBJECT_TYPE_ID) - already processed as child of '$PARENT_NAME' (parent abstract: $PARENT_IS_ABSTRACT)"
                    continue
                fi

                # If not already processed, decide how to handle it
                if [ "$PARENT_IS_ABSTRACT" != "true" ]; then
                    echo "    Processing '$OBJECT_TYPE_NAME' (ID: $OBJECT_TYPE_ID) as standalone - child processing failed/incomplete for parent '$PARENT_NAME'"
                else
                    echo "    Processing '$OBJECT_TYPE_NAME' (ID: $OBJECT_TYPE_ID) as standalone - parent '$PARENT_NAME' is abstract and this wasn't processed as child"
                fi
            else
                echo "    Processing '$OBJECT_TYPE_NAME' (ID: $OBJECT_TYPE_ID) as standalone - parent (ID: $PARENT_OBJECT_TYPE_ID) not found in schema"
            fi
        else
            echo "    Processing '$OBJECT_TYPE_NAME' (ID: $OBJECT_TYPE_ID) as standalone - no parent relationship"
        fi



        echo "    Processing object type: '$OBJECT_TYPE_NAME' (ID: $OBJECT_TYPE_ID)"

        # Check if this is an abstract object type
        IS_ABSTRACT=$(echo "$object_type" | jq -r '.abstractObjectType // false' 2>/dev/null)
        if [ "$IS_ABSTRACT" == "true" ]; then
            echo "      Note: Abstract object type - will process child types separately"
        fi

        # Check if this concrete type has children
        HAS_CHILDREN=$(echo "$PARENT_CHILD_RELATIONSHIPS" | grep "^$OBJECT_TYPE_ID:" | wc -l | tr -d ' ')
        if [ "${HAS_CHILDREN:-0}" -gt 0 ] && [ "$IS_ABSTRACT" != "true" ]; then
            echo "      Note: Concrete object type with $HAS_CHILDREN child type(s) - will process children hierarchically"
        fi

        # Sanitize object type name for directory use
        SANITIZED_OBJECT_TYPE_NAME=$(echo "$OBJECT_TYPE_NAME" | sed 's/[^a-zA-Z0-9._-]/_/g')
        OBJECT_TYPE_DIR="$SCHEMA_DIR/$SANITIZED_OBJECT_TYPE_NAME"
        mkdir -p "$OBJECT_TYPE_DIR"

        # For non-abstract types, fetch objects with optimized pagination
        echo "      Fetching objects for object type '$OBJECT_TYPE_NAME'..."

        if [ "$IS_ABSTRACT" != "true" ]; then
            # Use optimized query with large page size
            AQL_QUERY="objectTypeId = $OBJECT_TYPE_ID"
            ENCODED_AQL_QUERY=$(printf %s "$AQL_QUERY" | jq -s -R -r @uri)

            # Use temp file for efficient pagination
            TEMP_FILE=$(mktemp)
            PAGE_NUM=1
            PAGE_SIZE=$DEFAULT_PAGE_SIZE
            TOTAL_FETCHED=0

            while true; do
                API_URL="$BASE_API_URL/assets/1.0/aql/objects"
                API_URL="${API_URL}?qlQuery=$ENCODED_AQL_QUERY"
                API_URL="${API_URL}&objectSchemaId=$SCHEMA_ID"
                API_URL="${API_URL}&page=$PAGE_NUM"
                API_URL="${API_URL}&resultPerPage=$PAGE_SIZE"
                API_URL="${API_URL}&includeAttributes=true"
                API_URL="${API_URL}&includeAttributesDeep=$ATTRIBUTES_DEPTH"
                if [ "$INCLUDE_EXTENDED_INFO" = "true" ]; then
                    API_URL="${API_URL}&includeExtendedInfo=true"
                fi

                OBJECTS_RESPONSE_FILE=$(api_call "$API_URL")
                OBJECTS_HTTP_STATUS=$(get_response_status "$OBJECTS_RESPONSE_FILE")
                OBJECTS_BODY=$(get_response_body "$OBJECTS_RESPONSE_FILE")

                if [ -z "$OBJECTS_HTTP_STATUS" ] || ! [[ "$OBJECTS_HTTP_STATUS" =~ ^[0-9]+$ ]] || [ "$OBJECTS_HTTP_STATUS" -ne 200 ]; then
                    echo "      Warning: HTTP $OBJECTS_HTTP_STATUS when fetching page $PAGE_NUM. Stopping."
                    rm -f "$OBJECTS_RESPONSE_FILE"
                break
            fi

                # Response size handling removed - temp files handle unlimited sizes

                # Robust object extraction with improved error handling
                PAGE_OBJECTS=""
                PAGE_COUNT=0

                # Try extraction directly - let extract_objects_robust handle validation (PERFORMANCE OPTIMIZATION)
                PAGE_OBJECTS=$(extract_objects_robust "$OBJECTS_BODY" "object_type_${OBJECT_TYPE_ID}_page_${PAGE_NUM}")
                EXTRACT_SUCCESS=$?
                PAGE_COUNT=$(echo "$PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")

                # Increment total objects processed counter
                TOTAL_OBJECTS_PROCESSED=$((TOTAL_OBJECTS_PROCESSED + PAGE_COUNT))

                if [ "${PAGE_COUNT:-0}" -gt 0 ]; then
                    echo "      Extracted $PAGE_COUNT objects with attributes"
                elif [ $EXTRACT_SUCCESS -eq 0 ]; then
                    echo "      No objects found for this object type (empty result)"
                    # Skip fallback strategies - this is a valid empty response
                    PAGE_OBJECTS="[]"
                    PAGE_COUNT=0
                else
                    echo "      DEBUG: JSON validation failed. Response size: $(echo "$OBJECTS_BODY" | wc -c) bytes"
                    echo "      DEBUG: First 5000 chars: $(echo "$OBJECTS_BODY" | head -c 5000)"

                    # Try to extract partial data from potentially truncated JSON
                    PARTIAL_OBJECTS=$(echo "$OBJECTS_BODY" | grep -o '"objectEntries":\[[^]]*\]' | head -c 50000)
                    if [ -n "$PARTIAL_OBJECTS" ]; then
                        echo "      DEBUG: Found partial objectEntries data, attempting to parse..."
                        # Extract just the array part
                        PARTIAL_ARRAY=$(echo "$PARTIAL_OBJECTS" | sed -n 's/.*"objectEntries":\(\[[^]]*\]\).*/\1/p')
                        if [ -n "$PARTIAL_ARRAY" ] && validate_json "$PARTIAL_ARRAY"; then
                            PAGE_OBJECTS="$PARTIAL_ARRAY"
                            PAGE_COUNT=$(echo "$PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                            echo "      DEBUG: Partial extraction found $PAGE_COUNT objects"
                        fi
                    fi

                    # If partial extraction failed, trigger the intelligent fallback
                    if [ "${PAGE_COUNT:-0}" -eq 0 ]; then
                        echo "      DEBUG: Triggering intelligent fallback mechanism..."

                        # Try multiple fallback strategies to preserve attributes while handling large responses
                        FALLBACK_SUCCESS=false

                        # Strategy 1: Try with includeAttributesDeep=1 (less deep nesting)
                        echo "      DEBUG: Fallback Strategy 1 - Trying with includeAttributesDeep=1..."
                        FALLBACK_URL_1="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_AQL_QUERY&objectSchemaId=$SCHEMA_ID&page=$PAGE_NUM&resultPerPage=$PAGE_SIZE&includeAttributes=true&includeAttributesDeep=1"
                        FALLBACK_RESPONSE_FILE_1=$(api_call "$FALLBACK_URL_1")
                        FALLBACK_STATUS_1=$(get_response_status "$FALLBACK_RESPONSE_FILE_1")
                        FALLBACK_BODY_1=$(get_response_body "$FALLBACK_RESPONSE_FILE_1")

                        if [ "$FALLBACK_STATUS_1" = "200" ] && validate_json "$FALLBACK_BODY_1"; then
                            PAGE_OBJECTS=$(extract_objects_robust "$FALLBACK_BODY_1" "fallback_strategy_1_page_${PAGE_NUM}")
                            PAGE_COUNT=$(echo "$PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                            if [ "${PAGE_COUNT:-0}" -gt 0 ]; then
                                echo "      DEBUG: Strategy 1 successful - got $PAGE_COUNT objects with shallow attributes"
                                FALLBACK_SUCCESS=true
                                STRATEGY_1_SUCCESS=$((STRATEGY_1_SUCCESS + 1))
                            fi
                        fi
                        rm -f "$FALLBACK_RESPONSE_FILE_1"

                        # Strategy 2: Try with includeAttributesDeep=0 (no deep nesting)
                        if [ "$FALLBACK_SUCCESS" = false ]; then
                            echo "      DEBUG: Fallback Strategy 2 - Trying with includeAttributesDeep=0..."
                            FALLBACK_URL_2="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_AQL_QUERY&objectSchemaId=$SCHEMA_ID&page=$PAGE_NUM&resultPerPage=$PAGE_SIZE&includeAttributes=true&includeAttributesDeep=0"
                            FALLBACK_RESPONSE_FILE_2=$(api_call "$FALLBACK_URL_2")
                            FALLBACK_STATUS_2=$(get_response_status "$FALLBACK_RESPONSE_FILE_2")
                            FALLBACK_BODY_2=$(get_response_body "$FALLBACK_RESPONSE_FILE_2")

                            if [ "$FALLBACK_STATUS_2" = "200" ] && validate_json "$FALLBACK_BODY_2"; then
                                BASE_OBJECTS=$(extract_objects_robust "$FALLBACK_BODY_2" "fallback_strategy_2_page_${PAGE_NUM}")
                                BASE_COUNT=$(echo "$BASE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                if [ "${BASE_COUNT:-0}" -gt 0 ]; then
                                    echo "      DEBUG: Strategy 2 got $BASE_COUNT objects WITHOUT full attributes - fetching individual attributes..."

                                    # Strategy 2 gives objects without attributes, so fetch them individually (parallel)
                                    echo "      DEBUG: Strategy 2 fetching individual attributes in parallel..."
                                    ENHANCED_OBJECTS_TEMP=$(mktemp)
                                    INDIVIDUAL_PARALLEL_TEMP_DIR=$(mktemp -d)

                                    # Process objects in parallel (limit to 4 concurrent for individual attributes to prevent HTTP 000)
                                    OBJECTS_FILE=$(mktemp)
                                    echo "$BASE_OBJECTS" | jq -c '.[]' > "$OBJECTS_FILE"
                                    cat "$OBJECTS_FILE" | xargs -I {} -P 4 bash -c 'fetch_individual_object_attributes "$1" "$2" "strategy2"' _ {} "$INDIVIDUAL_PARALLEL_TEMP_DIR"
                                    rm -f "$OBJECTS_FILE"

                                    # Collect parallel results
                                    INDIVIDUAL_SUCCESS_COUNT=0
                                    for result_file in "$INDIVIDUAL_PARALLEL_TEMP_DIR"/strategy2_*.json; do
                                        if [ -f "$result_file" ]; then
                                            cat "$result_file" >> "$ENHANCED_OBJECTS_TEMP"
                                            INDIVIDUAL_SUCCESS_COUNT=$((INDIVIDUAL_SUCCESS_COUNT + 1))
                                        fi
                                    done

                                    # Clean up parallel temp directory
                                    rm -rf "$INDIVIDUAL_PARALLEL_TEMP_DIR"

                                    # Check if we got enhanced objects
                                    if [ -f "$ENHANCED_OBJECTS_TEMP" ] && [ -s "$ENHANCED_OBJECTS_TEMP" ]; then
                                        PAGE_OBJECTS=$(jq -s '.' "$ENHANCED_OBJECTS_TEMP" 2>/dev/null || echo "[]")
                                        PAGE_COUNT=$(echo "$PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                        echo "      DEBUG: Strategy 2+individual attributes successful - enhanced $PAGE_COUNT objects with full attributes"
                                        FALLBACK_SUCCESS=true
                                        STRATEGY_2_SUCCESS=$((STRATEGY_2_SUCCESS + 1))
                                        STRATEGY_2_INDIVIDUAL_SUCCESS=$((STRATEGY_2_INDIVIDUAL_SUCCESS + INDIVIDUAL_SUCCESS_COUNT))
                                    fi

                                    rm -f "$ENHANCED_OBJECTS_TEMP"
                                fi
                            fi
                            rm -f "$FALLBACK_RESPONSE_FILE_2"
                        fi

                        # Strategy 3: Try without extended info but keep attributes
                        if [ "$FALLBACK_SUCCESS" = false ]; then
                            echo "      DEBUG: Fallback Strategy 3 - Trying without extended info..."
                            FALLBACK_URL_3="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_AQL_QUERY&objectSchemaId=$SCHEMA_ID&page=$PAGE_NUM&resultPerPage=$PAGE_SIZE&includeAttributes=true&includeExtendedInfo=false"
                            FALLBACK_RESPONSE_FILE_3=$(api_call "$FALLBACK_URL_3")
                            FALLBACK_STATUS_3=$(get_response_status "$FALLBACK_RESPONSE_FILE_3")
                            FALLBACK_BODY_3=$(get_response_body "$FALLBACK_RESPONSE_FILE_3")

                            if [ "$FALLBACK_STATUS_3" = "200" ] && validate_json "$FALLBACK_BODY_3"; then
                                PAGE_OBJECTS=$(extract_objects_robust "$FALLBACK_BODY_3" "fallback_strategy_3_page_${PAGE_NUM}")
                                PAGE_COUNT=$(echo "$PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                if [ "${PAGE_COUNT:-0}" -gt 0 ]; then
                                    echo "      DEBUG: Strategy 3 successful - got $PAGE_COUNT objects with attributes (no extended info)"
                                    FALLBACK_SUCCESS=true
                                    STRATEGY_3_SUCCESS=$((STRATEGY_3_SUCCESS + 1))
                                fi
                            fi
                            rm -f "$FALLBACK_RESPONSE_FILE_3"
                        fi

                        # Strategy 4: Last resort - smaller page size but keep attributes
                        if [ "$FALLBACK_SUCCESS" = false ]; then
                            REDUCED_PAGE_SIZE=$((DEFAULT_PAGE_SIZE / 2))
                            echo "      DEBUG: Fallback Strategy 4 - Trying smaller page size ($REDUCED_PAGE_SIZE) but keeping attributes..."
                            FALLBACK_URL_4="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_AQL_QUERY&objectSchemaId=$SCHEMA_ID&page=$PAGE_NUM&resultPerPage=$REDUCED_PAGE_SIZE&includeAttributes=true&includeAttributesDeep=0&includeExtendedInfo=false"
                            FALLBACK_RESPONSE_FILE_4=$(api_call "$FALLBACK_URL_4")
                            FALLBACK_STATUS_4=$(get_response_status "$FALLBACK_RESPONSE_FILE_4")
                            FALLBACK_BODY_4=$(get_response_body "$FALLBACK_RESPONSE_FILE_4")

                            if [ "$FALLBACK_STATUS_4" = "200" ] && validate_json "$FALLBACK_BODY_4"; then
                                PAGE_OBJECTS=$(extract_objects_robust "$FALLBACK_BODY_4" "fallback_strategy_4_page_${PAGE_NUM}")
                                PAGE_COUNT=$(echo "$PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                if [ "${PAGE_COUNT:-0}" -gt 0 ]; then
                                    echo "      DEBUG: Strategy 4 successful - got $PAGE_COUNT objects with reduced page size"
                                    FALLBACK_SUCCESS=true
                                    STRATEGY_4_SUCCESS=$((STRATEGY_4_SUCCESS + 1))
                                    # Adjust page size for remaining pages
                                    PAGE_SIZE=$REDUCED_PAGE_SIZE
                                fi
                            fi
                            rm -f "$FALLBACK_RESPONSE_FILE_4"
                        fi

                        # Strategy 5: Individual object fetching with separate attribute calls
                        if [ "$FALLBACK_SUCCESS" = false ]; then
                            echo "      DEBUG: Fallback Strategy 5 - Individual object fetching with separate attribute calls..."
                            # First get objects without attributes
                            INDIVIDUAL_URL="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_AQL_QUERY&objectSchemaId=$SCHEMA_ID&page=$PAGE_NUM&resultPerPage=$PAGE_SIZE&includeAttributes=false"
                            INDIVIDUAL_RESPONSE_FILE=$(api_call "$INDIVIDUAL_URL")
                            INDIVIDUAL_STATUS=$(get_response_status "$INDIVIDUAL_RESPONSE_FILE")
                            INDIVIDUAL_BODY=$(get_response_body "$INDIVIDUAL_RESPONSE_FILE")

                            if [ "$INDIVIDUAL_STATUS" = "200" ] && validate_json "$INDIVIDUAL_BODY"; then
                                BASE_OBJECTS=$(extract_objects_robust "$INDIVIDUAL_BODY" "individual_base_objects_page_${PAGE_NUM}")
                                BASE_COUNT=$(echo "$BASE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")

                                if [ "${BASE_COUNT:-0}" -gt 0 ]; then
                                    echo "      DEBUG: Strategy 5 base fetch successful - got $BASE_COUNT objects without attributes"
                                    echo "      DEBUG: Fetching individual attributes for each object..."

                                    # Create enhanced objects with individual attribute fetching (parallel)
                                    echo "      DEBUG: Strategy 5 fetching individual attributes in parallel..."
                                    ENHANCED_OBJECTS_TEMP=$(mktemp)
                                    INDIVIDUAL_PARALLEL_TEMP_DIR=$(mktemp -d)

                                    # Process objects in parallel (limit to 4 concurrent for individual attributes to prevent HTTP 000)
                                    OBJECTS_FILE=$(mktemp)
                                    echo "$BASE_OBJECTS" | jq -c '.[]' > "$OBJECTS_FILE"
                                    cat "$OBJECTS_FILE" | xargs -I {} -P 4 bash -c 'fetch_individual_object_attributes "$1" "$2" "strategy5"' _ {} "$INDIVIDUAL_PARALLEL_TEMP_DIR"
                                    rm -f "$OBJECTS_FILE"

                                    # Collect parallel results
                                    INDIVIDUAL_SUCCESS_COUNT=0
                                    for result_file in "$INDIVIDUAL_PARALLEL_TEMP_DIR"/strategy5_*.json; do
                                        if [ -f "$result_file" ]; then
                                            cat "$result_file" >> "$ENHANCED_OBJECTS_TEMP"
                                            INDIVIDUAL_SUCCESS_COUNT=$((INDIVIDUAL_SUCCESS_COUNT + 1))
                                        fi
                                    done

                                    # Clean up parallel temp directory
                                    rm -rf "$INDIVIDUAL_PARALLEL_TEMP_DIR"

                                    # Check if we got enhanced objects
                                    if [ -f "$ENHANCED_OBJECTS_TEMP" ] && [ -s "$ENHANCED_OBJECTS_TEMP" ]; then
                                        PAGE_OBJECTS=$(jq -s '.' "$ENHANCED_OBJECTS_TEMP" 2>/dev/null || echo "[]")
                                        PAGE_COUNT=$(echo "$PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                        echo "      DEBUG: Strategy 5 successful - enhanced $PAGE_COUNT objects with individual attribute fetching"
                                        FALLBACK_SUCCESS=true
                                        STRATEGY_5_SUCCESS=$((STRATEGY_5_SUCCESS + 1))
                                    fi

                                    rm -f "$ENHANCED_OBJECTS_TEMP"
                                fi
                            fi
                            rm -f "$INDIVIDUAL_RESPONSE_FILE"
                        fi

                        # If all strategies failed, skip this page with error
                        if [ "$FALLBACK_SUCCESS" = false ]; then
                            echo "      ERROR: All fallback strategies failed for page $PAGE_NUM of object type '$OBJECT_TYPE_NAME'"
                            echo "      SKIPPING: Unable to retrieve objects with attributes for this page"
                            break
                        fi
                    fi
                fi  # End of JSON validation failed (else) block

                # Debug pagination metadata
                TOTAL_FILTER_COUNT=$(echo "$OBJECTS_BODY" | jq -r '.totalFilterCount // 0' 2>/dev/null)
                echo "      DEBUG: === PAGINATION METADATA ==="
                echo "      DEBUG: Page objects count: $PAGE_COUNT"
                echo "      DEBUG: Total filter count: $TOTAL_FILTER_COUNT"
                echo "      DEBUG: Page size requested: $PAGE_SIZE"

                # Additional debugging for empty responses
                if [ "${PAGE_COUNT:-0}" -eq 0 ]; then
                    echo "      DEBUG: Empty response ($(echo -n "$OBJECTS_BODY" | wc -c) chars): $(echo "$OBJECTS_BODY" | head -c 500)"
                fi

                # Save debug file if needed
                save_debug_file_if_needed "$OBJECTS_BODY" "$OBJECT_TYPE_ID" "$OBJECT_TYPE_NAME" "$PAGE_NUM" "$PAGE_COUNT"

                if [ "${PAGE_COUNT:-0}" -eq 0 ]; then
                    # Check if this is the first page with totalFilterCount = 0 (truly empty)
                    TOTAL_FILTER_COUNT=$(echo "$OBJECTS_BODY" | jq -r '.totalFilterCount // 0' 2>/dev/null)
                    if [ "$PAGE_NUM" -eq 1 ] && [ "$TOTAL_FILTER_COUNT" -eq 0 ]; then
                        echo "      INFO: Object type '$OBJECT_TYPE_NAME' is empty (0 objects) - this is valid"
                        echo "      Will check for child types that may contain the actual data..."
                        # Create empty array in temp file for consistency
                        echo "[]" | jq -c '.[]' > "$TEMP_FILE"
                    else
                        echo "      DEBUG: No objects found on page $PAGE_NUM, breaking loop"
                    fi
                    rm -f "$OBJECTS_RESPONSE_FILE"
                    break
                fi

                # Append objects to temp file (one per line for efficiency)
                echo "$PAGE_OBJECTS" | jq -c '.[]' >> "$TEMP_FILE"
                TOTAL_FETCHED=$((TOTAL_FETCHED + PAGE_COUNT))

                # Clean up response file
                rm -f "$OBJECTS_RESPONSE_FILE"

                # Check if we need more pages
                TOTAL_FILTER_COUNT=$(echo "$OBJECTS_BODY" | jq -r '.totalFilterCount // 0' 2>/dev/null)

                if [ "${PAGE_COUNT:-0}" -lt "${PAGE_SIZE:-2000}" ]; then
                    # Got fewer than requested, we're done
                break
            fi

                if [ -n "$TOTAL_FILTER_COUNT" ] && [ "$TOTAL_FILTER_COUNT" -gt 0 ] && [ "$TOTAL_FETCHED" -ge "$TOTAL_FILTER_COUNT" ]; then
                    # Fetched all available objects
                break
            fi

                echo "      Fetched $PAGE_COUNT objects (page $PAGE_NUM), total: $TOTAL_FETCHED/$TOTAL_FILTER_COUNT..."
                PAGE_NUM=$((PAGE_NUM + 1))

                # Safety limit
                if [ "$PAGE_NUM" -gt 50 ]; then
                    echo "      Warning: Reached page limit (50 pages), stopping."
                    break
                fi
            done

            # Save all collected objects
            OBJECTS_FILE="$OBJECT_TYPE_DIR/objects.json"
            finalize_temp_file "$TEMP_FILE" "$OBJECTS_FILE" "$OBJECT_TYPE_NAME" "      " "$OBJECT_TYPE_DIR"

            if [ -f "$OBJECTS_FILE" ]; then
                FINAL_COUNT=$(jq 'length' "$OBJECTS_FILE" 2>/dev/null || echo "0")
                TOTAL_OBJECTS_SUCCESS=$((TOTAL_OBJECTS_SUCCESS + FINAL_COUNT))
                TOTAL_OBJECT_TYPES_SUCCESS=$((TOTAL_OBJECT_TYPES_SUCCESS + 1))

                # Update detailed per-schema statistics
                CURRENT_SCHEMA_OBJECTS=$(get_schema_stat "$SCHEMA_ID" "objects")
                set_schema_stat "$SCHEMA_ID" "objects" "$((CURRENT_SCHEMA_OBJECTS + FINAL_COUNT))"

                # Track per-object-type details
                set_object_type_detail "$SCHEMA_ID" "$OBJECT_TYPE_ID" "${OBJECT_TYPE_NAME}:${FINAL_COUNT}"
            fi

            # Process child types if this concrete type has children OR if it has 0 objects (might be a container)
            # Check for children even if we got 0 objects - it might be an empty container with child types
            if ([ "${HAS_CHILDREN:-0}" -gt 0 ] || [ "$TOTAL_FETCHED" -eq 0 ]) && [ "$IS_ABSTRACT" != "true" ]; then
                if [ "$TOTAL_FETCHED" -eq 0 ]; then
                    echo "      Object type '$OBJECT_TYPE_NAME' has 0 objects - checking for child types..."
                else
                    echo "      Processing child types of concrete parent '$OBJECT_TYPE_NAME'..."
                fi

                # Find child types where parentObjectTypeId matches this concrete type
                CONCRETE_CHILD_TYPES=$(echo "$OBJECT_TYPES" | jq -c ". | select(.parentObjectTypeId == $OBJECT_TYPE_ID)" 2>/dev/null)
                CHILD_COUNT=$(echo "$CONCRETE_CHILD_TYPES" | wc -l | tr -d ' ')

                if [ -n "$CONCRETE_CHILD_TYPES" ] && [ "$CHILD_COUNT" -gt 0 ]; then
                    echo "      Found $CHILD_COUNT child object types of '$OBJECT_TYPE_NAME':"
                    # Debug: List all child types found
                    echo "$CONCRETE_CHILD_TYPES" | while IFS= read -r child; do
                        if [ -n "$child" ]; then
                            CHILD_ID=$(echo "$child" | jq -r '.id // "unknown"')
                            CHILD_NAME=$(echo "$child" | jq -r '.name // "unknown"')
                            echo "        DEBUG: Found child '$CHILD_NAME' (ID: $CHILD_ID)"
                        fi
                    done

                    # Process each child type separately
                    while IFS= read -r child_type; do
                        CHILD_TYPE_ID=$(echo "$child_type" | jq -r '.id')
                        CHILD_TYPE_NAME=$(echo "$child_type" | jq -r '.name')

                            echo "        Processing child type: '$CHILD_TYPE_NAME' (ID: $CHILD_TYPE_ID)"

                            # Create directory for this child type under the parent concrete type
                            SANITIZED_CHILD_NAME=$(echo "$CHILD_TYPE_NAME" | sed 's/[^a-zA-Z0-9._-]/_/g')
                            # Store under parent type directory: Schema/ParentType/ChildType/
                            CHILD_TYPE_DIR="$OBJECT_TYPE_DIR/$SANITIZED_CHILD_NAME"
                            mkdir -p "$CHILD_TYPE_DIR"

                            # Fetch objects for this specific child type with pagination
                            CHILD_AQL="objectTypeId = $CHILD_TYPE_ID"
                            ENCODED_CHILD_AQL=$(printf %s "$CHILD_AQL" | jq -s -R -r @uri)

                            echo "          DEBUG: AQL Query: $CHILD_AQL"
                            echo "          DEBUG: Encoded: $ENCODED_CHILD_AQL"

                            # Use temp file for efficient pagination
                            CHILD_TEMP_FILE=$(mktemp)
                            echo "          DEBUG: Temp file: $CHILD_TEMP_FILE"
                            CHILD_PAGE_NUM=1
                            CHILD_PAGE_SIZE=$DEFAULT_PAGE_SIZE
                            CHILD_TOTAL_FETCHED=0

                            while true; do
                                CHILD_URL="$BASE_API_URL/assets/1.0/aql/objects"
                                CHILD_URL="${CHILD_URL}?qlQuery=$ENCODED_CHILD_AQL"
                                CHILD_URL="${CHILD_URL}&objectSchemaId=$SCHEMA_ID"
                                CHILD_URL="${CHILD_URL}&page=$CHILD_PAGE_NUM"
                                CHILD_URL="${CHILD_URL}&resultPerPage=$CHILD_PAGE_SIZE"
                                CHILD_URL="${CHILD_URL}&includeAttributes=true"

                                echo "          DEBUG: Fetching page $CHILD_PAGE_NUM - URL: $CHILD_URL"

                                CHILD_OBJECTS_RESPONSE_FILE=$(api_call "$CHILD_URL")
                                echo "          DEBUG: Response file: $CHILD_OBJECTS_RESPONSE_FILE"
                                CHILD_OBJECTS_STATUS=$(get_response_status "$CHILD_OBJECTS_RESPONSE_FILE")
                                echo "          DEBUG: HTTP Status: $CHILD_OBJECTS_STATUS"
                                CHILD_OBJECTS_BODY_FILE=$(get_response_body_to_file "$CHILD_OBJECTS_RESPONSE_FILE")
                                echo "          DEBUG: Body file: $CHILD_OBJECTS_BODY_FILE"

                                if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                    echo "          DEBUG: Response body size: $(wc -c < "$CHILD_OBJECTS_BODY_FILE") bytes"
                                else
                                    echo "          DEBUG: ERROR - Body file does not exist!"
                                fi

                                if [ "$CHILD_OBJECTS_STATUS" != "200" ]; then
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        echo "          DEBUG: Non-200 status, response preview: $(head -c 500 "$CHILD_OBJECTS_BODY_FILE")"
                                    else
                                        echo "          DEBUG: Non-200 status, response preview: [BODY FILE MISSING]"
                                    fi
                                    if [ "$CHILD_PAGE_NUM" -eq 1 ]; then
                                        echo "          Failed to fetch objects for '$CHILD_TYPE_NAME'"

                                        # Try POST fallback
                                        FALLBACK_RESPONSE_FILE=$(try_post_aql_fallback "$CHILD_AQL" "$SCHEMA_ID" "$CHILD_PAGE_NUM" "$CHILD_PAGE_SIZE" "$CHILD_TYPE_NAME")
                                        FALLBACK_STATUS=$(get_response_status "$FALLBACK_RESPONSE_FILE")

                                        if [ "$FALLBACK_STATUS" = "200" ]; then
                                            echo "          DEBUG: POST fallback successful for '$CHILD_TYPE_NAME'!"
                                            # Use the fallback response
                                            rm -f "$CHILD_OBJECTS_RESPONSE_FILE" "$CHILD_OBJECTS_BODY_FILE"
                                            CHILD_OBJECTS_RESPONSE_FILE="$FALLBACK_RESPONSE_FILE"
                                            CHILD_OBJECTS_STATUS="$FALLBACK_STATUS"
                                            # Update the body file to point to the fallback response
                                            CHILD_OBJECTS_BODY_FILE=$(get_response_body_to_file "$CHILD_OBJECTS_RESPONSE_FILE")
                                            echo "          DEBUG: POST Response body size: $(wc -c < "$CHILD_OBJECTS_BODY_FILE") bytes"
                                        else
                                            echo "          DEBUG: POST fallback also failed for '$CHILD_TYPE_NAME'"
                                            rm -f "$CHILD_OBJECTS_RESPONSE_FILE" "$CHILD_OBJECTS_BODY_FILE" "$FALLBACK_RESPONSE_FILE"
                                            break
                                        fi
                                    else
                                        rm -f "$CHILD_OBJECTS_RESPONSE_FILE" "$CHILD_OBJECTS_BODY_FILE"
                                        break
                                    fi
                                fi

                                # Response size handling removed - temp files handle unlimited sizes

                                # Robust object extraction with improved error handling for child types
                                CHILD_PAGE_OBJECTS=""
                                CHILD_PAGE_COUNT=0

                                echo "          DEBUG: === OBJECT EXTRACTION ATTEMPT ==="

                                # First, validate the JSON response using file-based approach
                                if [ -f "$CHILD_OBJECTS_BODY_FILE" ] && [ -s "$CHILD_OBJECTS_BODY_FILE" ] && jq empty "$CHILD_OBJECTS_BODY_FILE" 2>/dev/null; then
                                    echo "          DEBUG: JSON validation passed"
                                    # Use our enhanced file-based extraction function
                                    CHILD_PAGE_OBJECTS_FILE=$(extract_objects_robust_from_file "$CHILD_OBJECTS_BODY_FILE" "child_type_${CHILD_TYPE_ID}_page_${CHILD_PAGE_NUM}")
                                    CHILD_PAGE_COUNT=$(jq 'length' "$CHILD_PAGE_OBJECTS_FILE" 2>/dev/null || echo "0")
                                    echo "          DEBUG: Extracted $CHILD_PAGE_COUNT objects with attributes"
                                else
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        echo "          DEBUG: JSON validation failed. Response size: $(wc -c < "$CHILD_OBJECTS_BODY_FILE") bytes"
                                        echo "          DEBUG: First 5000 chars: $(head -c 5000 "$CHILD_OBJECTS_BODY_FILE")"
                                    else
                                        echo "          DEBUG: JSON validation failed. Body file missing or empty."
                                        echo "          DEBUG: First 5000 chars: [FILE NOT AVAILABLE]"
                                    fi

                                    # Try to extract partial data from potentially truncated JSON
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        PARTIAL_OBJECTS=$(grep -o '"objectEntries":\[[^]]*\]' "$CHILD_OBJECTS_BODY_FILE" | head -c 50000)
                                    else
                                        PARTIAL_OBJECTS=""
                                    fi
                                    if [ -n "$PARTIAL_OBJECTS" ]; then
                                        echo "          DEBUG: Found partial objectEntries data, attempting to parse..."
                                        # Extract just the array part
                                        PARTIAL_ARRAY=$(echo "$PARTIAL_OBJECTS" | sed -n 's/.*"objectEntries":\(\[[^]]*\]\).*/\1/p')
                                        if [ -n "$PARTIAL_ARRAY" ] && validate_json "$PARTIAL_ARRAY"; then
                                            CHILD_PAGE_OBJECTS="$PARTIAL_ARRAY"
                                            CHILD_PAGE_COUNT=$(echo "$CHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                            echo "          DEBUG: Partial extraction found $CHILD_PAGE_COUNT objects"
                                        fi
                                    fi

                                    # If partial extraction failed, trigger the intelligent fallback for child types
                                    if [ "${CHILD_PAGE_COUNT:-0}" -eq 0 ]; then
                                        echo "          DEBUG: Triggering intelligent fallback mechanism for concrete child type..."

                                        # Try multiple fallback strategies to preserve attributes while handling large responses
                                        CHILD_FALLBACK_SUCCESS=false

                                        # Strategy 1: Try with includeAttributesDeep=1 (less deep nesting)
                                        echo "          DEBUG: Concrete Child Fallback Strategy 1 - Trying with includeAttributesDeep=1..."
                                        CHILD_FALLBACK_URL_1="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_CHILD_AQL&objectSchemaId=$SCHEMA_ID&page=$CHILD_PAGE_NUM&resultPerPage=$CHILD_PAGE_SIZE&includeAttributes=true&includeAttributesDeep=1"
                                        CHILD_FALLBACK_RESPONSE_FILE_1=$(api_call "$CHILD_FALLBACK_URL_1")
                                        CHILD_FALLBACK_STATUS_1=$(get_response_status "$CHILD_FALLBACK_RESPONSE_FILE_1")
                                        CHILD_FALLBACK_BODY_1=$(get_response_body "$CHILD_FALLBACK_RESPONSE_FILE_1")

                                        if [ "$CHILD_FALLBACK_STATUS_1" = "200" ] && validate_json "$CHILD_FALLBACK_BODY_1"; then
                                            CHILD_PAGE_OBJECTS=$(extract_objects_robust "$CHILD_FALLBACK_BODY_1" "concrete_child_fallback_strategy_1_page_${CHILD_PAGE_NUM}")
                                            CHILD_PAGE_COUNT=$(echo "$CHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                            if [ "${CHILD_PAGE_COUNT:-0}" -gt 0 ]; then
                                                echo "          DEBUG: Concrete Child Strategy 1 successful - got $CHILD_PAGE_COUNT objects with shallow attributes"
                                                CHILD_FALLBACK_SUCCESS=true
                                            fi
                                        fi
                                        rm -f "$CHILD_FALLBACK_RESPONSE_FILE_1"

                                        # Strategy 2: Try with includeAttributesDeep=0 (no deep nesting)
                                        if [ "$CHILD_FALLBACK_SUCCESS" = false ]; then
                                            echo "          DEBUG: Concrete Child Fallback Strategy 2 - Trying with includeAttributesDeep=0..."
                                            CHILD_FALLBACK_URL_2="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_CHILD_AQL&objectSchemaId=$SCHEMA_ID&page=$CHILD_PAGE_NUM&resultPerPage=$CHILD_PAGE_SIZE&includeAttributes=true&includeAttributesDeep=0"
                                            CHILD_FALLBACK_RESPONSE_FILE_2=$(api_call "$CHILD_FALLBACK_URL_2")
                                            CHILD_FALLBACK_STATUS_2=$(get_response_status "$CHILD_FALLBACK_RESPONSE_FILE_2")
                                            CHILD_FALLBACK_BODY_2=$(get_response_body "$CHILD_FALLBACK_RESPONSE_FILE_2")

                                            if [ "$CHILD_FALLBACK_STATUS_2" = "200" ] && validate_json "$CHILD_FALLBACK_BODY_2"; then
                                                CHILD_BASE_OBJECTS=$(extract_objects_robust "$CHILD_FALLBACK_BODY_2" "concrete_child_fallback_strategy_2_page_${CHILD_PAGE_NUM}")
                                                CHILD_BASE_COUNT=$(echo "$CHILD_BASE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                                if [ "${CHILD_BASE_COUNT:-0}" -gt 0 ]; then
                                                    echo "          DEBUG: Concrete Child Strategy 2 got $CHILD_BASE_COUNT objects WITHOUT full attributes - fetching individual attributes..."

                                                    # Strategy 2 gives objects without attributes, so fetch them individually (parallel)
                                                    echo "          DEBUG: Concrete Child Strategy 2 fetching individual attributes in parallel..."
                                                    CHILD_ENHANCED_OBJECTS_TEMP=$(mktemp)
                                                    CHILD_INDIVIDUAL_PARALLEL_TEMP_DIR=$(mktemp -d)

                                                    # Process child objects in parallel (limit to 3 concurrent for child attributes to prevent HTTP 000)
                                                    CHILD_OBJECTS_FILE=$(mktemp)
                                                    echo "$CHILD_BASE_OBJECTS" | jq -c '.[]' > "$CHILD_OBJECTS_FILE"
                                                    cat "$CHILD_OBJECTS_FILE" | xargs -I {} -P 3 bash -c 'fetch_individual_object_attributes "$1" "$2" "child_strategy2"' _ {} "$CHILD_INDIVIDUAL_PARALLEL_TEMP_DIR"
                                                    rm -f "$CHILD_OBJECTS_FILE"

                                                    # Collect parallel results
                                                    CHILD_INDIVIDUAL_SUCCESS_COUNT=0
                                                    for result_file in "$CHILD_INDIVIDUAL_PARALLEL_TEMP_DIR"/child_strategy2_*.json; do
                                                        if [ -f "$result_file" ]; then
                                                            cat "$result_file" >> "$CHILD_ENHANCED_OBJECTS_TEMP"
                                                            CHILD_INDIVIDUAL_SUCCESS_COUNT=$((CHILD_INDIVIDUAL_SUCCESS_COUNT + 1))
                                                        fi
                                                    done

                                                    # Clean up parallel temp directory
                                                    rm -rf "$CHILD_INDIVIDUAL_PARALLEL_TEMP_DIR"

                                                    # Check if we got enhanced child objects
                                                    if [ -f "$CHILD_ENHANCED_OBJECTS_TEMP" ] && [ -s "$CHILD_ENHANCED_OBJECTS_TEMP" ]; then
                                                        CHILD_PAGE_OBJECTS=$(jq -s '.' "$CHILD_ENHANCED_OBJECTS_TEMP" 2>/dev/null || echo "[]")
                                                        CHILD_PAGE_COUNT=$(echo "$CHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                                        echo "          DEBUG: Concrete Child Strategy 2+individual attributes successful - enhanced $CHILD_PAGE_COUNT objects with full attributes"
                                                        CHILD_FALLBACK_SUCCESS=true
                                                    fi

                                                    rm -f "$CHILD_ENHANCED_OBJECTS_TEMP"
                                                fi
                                            fi
                                            rm -f "$CHILD_FALLBACK_RESPONSE_FILE_2"
                                        fi

                                        # Strategy 3: Try without extended info but keep attributes
                                        if [ "$CHILD_FALLBACK_SUCCESS" = false ]; then
                                            echo "          DEBUG: Concrete Child Fallback Strategy 3 - Trying without extended info..."
                                            CHILD_FALLBACK_URL_3="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_CHILD_AQL&objectSchemaId=$SCHEMA_ID&page=$CHILD_PAGE_NUM&resultPerPage=$CHILD_PAGE_SIZE&includeAttributes=true&includeExtendedInfo=false"
                                            CHILD_FALLBACK_RESPONSE_FILE_3=$(api_call "$CHILD_FALLBACK_URL_3")
                                            CHILD_FALLBACK_STATUS_3=$(get_response_status "$CHILD_FALLBACK_RESPONSE_FILE_3")
                                            CHILD_FALLBACK_BODY_3=$(get_response_body "$CHILD_FALLBACK_RESPONSE_FILE_3")

                                            if [ "$CHILD_FALLBACK_STATUS_3" = "200" ] && validate_json "$CHILD_FALLBACK_BODY_3"; then
                                                CHILD_PAGE_OBJECTS=$(extract_objects_robust "$CHILD_FALLBACK_BODY_3" "concrete_child_fallback_strategy_3_page_${CHILD_PAGE_NUM}")
                                                CHILD_PAGE_COUNT=$(echo "$CHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                                if [ "${CHILD_PAGE_COUNT:-0}" -gt 0 ]; then
                                                    echo "          DEBUG: Concrete Child Strategy 3 successful - got $CHILD_PAGE_COUNT objects with attributes (no extended info)"
                                                    CHILD_FALLBACK_SUCCESS=true
                                                fi
                                            fi
                                            rm -f "$CHILD_FALLBACK_RESPONSE_FILE_3"
                                        fi

                                        # Strategy 4: Last resort - smaller page size but keep attributes
                                        if [ "$CHILD_FALLBACK_SUCCESS" = false ]; then
                                            CHILD_REDUCED_PAGE_SIZE=$((DEFAULT_PAGE_SIZE / 2))
                                            echo "          DEBUG: Concrete Child Fallback Strategy 4 - Trying smaller page size ($CHILD_REDUCED_PAGE_SIZE) but keeping attributes..."
                                            CHILD_FALLBACK_URL_4="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_CHILD_AQL&objectSchemaId=$SCHEMA_ID&page=$CHILD_PAGE_NUM&resultPerPage=$CHILD_REDUCED_PAGE_SIZE&includeAttributes=true&includeAttributesDeep=0&includeExtendedInfo=false"
                                            CHILD_FALLBACK_RESPONSE_FILE_4=$(api_call "$CHILD_FALLBACK_URL_4")
                                            CHILD_FALLBACK_STATUS_4=$(get_response_status "$CHILD_FALLBACK_RESPONSE_FILE_4")
                                            CHILD_FALLBACK_BODY_4=$(get_response_body "$CHILD_FALLBACK_RESPONSE_FILE_4")

                                            if [ "$CHILD_FALLBACK_STATUS_4" = "200" ] && validate_json "$CHILD_FALLBACK_BODY_4"; then
                                                CHILD_PAGE_OBJECTS=$(extract_objects_robust "$CHILD_FALLBACK_BODY_4" "concrete_child_fallback_strategy_4_page_${CHILD_PAGE_NUM}")
                                                CHILD_PAGE_COUNT=$(echo "$CHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                                if [ "${CHILD_PAGE_COUNT:-0}" -gt 0 ]; then
                                                    echo "          DEBUG: Concrete Child Strategy 4 successful - got $CHILD_PAGE_COUNT objects with reduced page size"
                                                    CHILD_FALLBACK_SUCCESS=true
                                                    # Adjust page size for remaining pages
                                                    CHILD_PAGE_SIZE=$CHILD_REDUCED_PAGE_SIZE
                                                fi
                                            fi
                                            rm -f "$CHILD_FALLBACK_RESPONSE_FILE_4"
                                        fi

                                        # If all attribute-preserving strategies failed, skip this page with error
                                        if [ "$CHILD_FALLBACK_SUCCESS" = false ]; then
                                            echo "          ERROR: All concrete child fallback strategies failed for page $CHILD_PAGE_NUM of child type '$CHILD_TYPE_NAME'"
                                            echo "          SKIPPING: Unable to retrieve child objects with attributes for this page"
                                            break
                                        fi
                                    fi
                                fi

                                # Debug pagination metadata
                                if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                    CHILD_TOTAL_FILTER_COUNT=$(jq -r '.totalFilterCount // 0' "$CHILD_OBJECTS_BODY_FILE" 2>/dev/null)
                                else
                                    CHILD_TOTAL_FILTER_COUNT=0
                                fi
                                echo "          DEBUG: === PAGINATION METADATA ==="
                                echo "          DEBUG: Page objects count: $CHILD_PAGE_COUNT"
                                echo "          DEBUG: Total filter count: $CHILD_TOTAL_FILTER_COUNT"
                                echo "          DEBUG: Page size requested: $CHILD_PAGE_SIZE"

                                # Additional debugging for empty responses
                                if [ "${CHILD_PAGE_COUNT:-0}" -eq 0 ]; then
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        echo "          DEBUG: Empty child response ($(wc -c < "$CHILD_OBJECTS_BODY_FILE") chars): $(head -c 300 "$CHILD_OBJECTS_BODY_FILE")"
                                    else
                                        echo "          DEBUG: Empty child response (body file missing)"
                                    fi
                                fi

                                # Save response to file for manual inspection if it's large or problematic
                                if [ "$CHILD_PAGE_NUM" -eq 1 ] || [ "${CHILD_PAGE_COUNT:-0}" -eq 0 ]; then
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ] && ([ "$(wc -c < "$CHILD_OBJECTS_BODY_FILE")" -gt 100000 ] || [ "${CHILD_PAGE_COUNT:-0}" -eq 0 ]); then
                                        echo "          DEBUG: Saving detailed debug file due to size or empty response..."
                                        DEBUG_FILENAME="/tmp/debug_response_${CHILD_TYPE_ID}_${CHILD_TYPE_NAME}_page${CHILD_PAGE_NUM}.json"
                                        cp "$CHILD_OBJECTS_BODY_FILE" "$DEBUG_FILENAME"
                                        echo "          DEBUG: Saved to $DEBUG_FILENAME (size: $(wc -c < "$DEBUG_FILENAME") bytes)"
                                    elif [ ! -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        echo "          DEBUG: Cannot save debug file - body file is missing"
                                    fi
                                fi

                                if [ "${CHILD_PAGE_COUNT:-0}" -eq 0 ]; then
                                    # Check if this is the first page with totalFilterCount = 0 (truly empty)
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        CHILD_TOTAL_FILTER_COUNT=$(jq -r '.totalFilterCount // 0' "$CHILD_OBJECTS_BODY_FILE" 2>/dev/null)
                                    else
                                        CHILD_TOTAL_FILTER_COUNT=0
                                    fi

                                    if [ "$CHILD_PAGE_NUM" -eq 1 ] && [ "$CHILD_TOTAL_FILTER_COUNT" -eq 0 ]; then
                                        echo "          INFO: Child type '$CHILD_TYPE_NAME' is empty (0 objects) - this is valid"
                                        echo "          Will check for grandchild types that may contain the actual data..."
                                        # Create empty array in temp file for consistency
                                        echo "[]" | jq -c '.[]' > "$CHILD_TEMP_FILE"
                                    else
                                        echo "          DEBUG: No objects found on page $CHILD_PAGE_NUM, breaking loop"
                                    fi
                                    break
                                fi

                                # Append objects to temp file (one per line for efficiency)
                                if [ -f "$CHILD_PAGE_OBJECTS_FILE" ]; then
                                    jq -c '.[]' "$CHILD_PAGE_OBJECTS_FILE" >> "$CHILD_TEMP_FILE"
                                else
                                    # Fallback for cases where CHILD_PAGE_OBJECTS is still used (fallback strategies)
                                    echo "$CHILD_PAGE_OBJECTS" | jq -c '.[]' >> "$CHILD_TEMP_FILE"
                                fi
                                CHILD_TOTAL_FETCHED=$((CHILD_TOTAL_FETCHED + CHILD_PAGE_COUNT))

                                echo "          DEBUG: Wrote $CHILD_PAGE_COUNT objects (total: $CHILD_TOTAL_FETCHED)"

                                # Clean up response and temporary files after successful processing
                                rm -f "$CHILD_OBJECTS_RESPONSE_FILE" "$CHILD_OBJECTS_BODY_FILE"
                                [ -f "$CHILD_PAGE_OBJECTS_FILE" ] && rm -f "$CHILD_PAGE_OBJECTS_FILE"

                                if [ "${CHILD_PAGE_COUNT:-0}" -lt "${CHILD_PAGE_SIZE:-2000}" ]; then
                                    break
                                fi

                                if [ -n "$CHILD_TOTAL_FILTER_COUNT" ] && [ "$CHILD_TOTAL_FILTER_COUNT" -gt 0 ] && [ "$CHILD_TOTAL_FETCHED" -ge "$CHILD_TOTAL_FILTER_COUNT" ]; then
                                    break
                                fi

                                echo "          Fetched $CHILD_PAGE_COUNT objects (page $CHILD_PAGE_NUM), total: $CHILD_TOTAL_FETCHED/$CHILD_TOTAL_FILTER_COUNT..."

                                CHILD_PAGE_NUM=$((CHILD_PAGE_NUM + 1))

                                if [ "$CHILD_PAGE_NUM" -gt 50 ]; then
                                    echo "          Warning: Reached page limit for child type."
                                    break
                                fi
                            done

                            # Save all collected objects for this child type
                            CHILD_OBJECTS_FILE="$CHILD_TYPE_DIR/objects.json"
                            finalize_temp_file "$CHILD_TEMP_FILE" "$CHILD_OBJECTS_FILE" "child type '$CHILD_TYPE_NAME'" "          " "$CHILD_TYPE_DIR"

                            # Track that this child type was successfully processed
                            SUCCESSFULLY_PROCESSED_CHILDREN="$SUCCESSFULLY_PROCESSED_CHILDREN $CHILD_TYPE_ID"
                            if [ "$CHILD_TOTAL_FETCHED" -eq 0 ]; then
                                echo "          INFO: Successfully processed EMPTY child type '$CHILD_TYPE_NAME' (ID: $CHILD_TYPE_ID)"
                            else
                                echo "          DEBUG: Successfully processed child type '$CHILD_TYPE_NAME' (ID: $CHILD_TYPE_ID) - added to processed list"
                            fi

                            # Update child statistics
                            TOTAL_CHILD_TYPES_PROCESSED=$((TOTAL_CHILD_TYPES_PROCESSED + 1))
                            TOTAL_CHILD_OBJECTS_SUCCESS=$((TOTAL_CHILD_OBJECTS_SUCCESS + CHILD_TOTAL_FETCHED))

                            # Update detailed per-schema child statistics
                            CURRENT_CHILD_TYPES=$(get_schema_stat "$SCHEMA_ID" "child_types")
                            CURRENT_CHILD_OBJECTS=$(get_schema_stat "$SCHEMA_ID" "child_objects")
                            set_schema_stat "$SCHEMA_ID" "child_types" "$((CURRENT_CHILD_TYPES + 1))"
                            set_schema_stat "$SCHEMA_ID" "child_objects" "$((CURRENT_CHILD_OBJECTS + CHILD_TOTAL_FETCHED))"

                            # Check if this child type has its own children (grandchildren of the original parent)
                            # Also check if child had 0 objects (might be a container)
                            GRANDCHILDREN=$(echo "$PARENT_CHILD_RELATIONSHIPS" | grep "^$CHILD_TYPE_ID:" | wc -l | tr -d ' ')
                            if [ "${GRANDCHILDREN:-0}" -gt 0 ] || [ "$CHILD_TOTAL_FETCHED" -eq 0 ]; then
                                if [ "$CHILD_TOTAL_FETCHED" -eq 0 ]; then
                                    echo "          Child type '$CHILD_TYPE_NAME' has 0 objects - checking for grandchild types..."
                                elif [ "${GRANDCHILDREN:-0}" -gt 0 ]; then
                                    echo "          Processing grandchildren of '$CHILD_TYPE_NAME' (${GRANDCHILDREN} found)..."
                                fi

                                # Find grandchild types where parentObjectTypeId matches this child type
                                GRANDCHILD_TYPES=$(echo "$OBJECT_TYPES" | jq -c ". | select(.parentObjectTypeId == $CHILD_TYPE_ID)" 2>/dev/null)

                                if [ -n "$GRANDCHILD_TYPES" ]; then
                                    while IFS= read -r grandchild_type; do
                                        GRANDCHILD_TYPE_ID=$(echo "$grandchild_type" | jq -r '.id')
                                        GRANDCHILD_TYPE_NAME=$(echo "$grandchild_type" | jq -r '.name')

                                        echo "            Processing grandchild type: '$GRANDCHILD_TYPE_NAME' (ID: $GRANDCHILD_TYPE_ID)"

                                        # Create directory for this grandchild type under the child type
                                        SANITIZED_GRANDCHILD_NAME=$(echo "$GRANDCHILD_TYPE_NAME" | sed 's/[^a-zA-Z0-9._-]/_/g')
                                        GRANDCHILD_TYPE_DIR="$CHILD_TYPE_DIR/$SANITIZED_GRANDCHILD_NAME"
                                        mkdir -p "$GRANDCHILD_TYPE_DIR"

                                        # Fetch objects for this grandchild type
                                        GRANDCHILD_AQL="objectTypeId = $GRANDCHILD_TYPE_ID"
                                        ENCODED_GRANDCHILD_AQL=$(printf %s "$GRANDCHILD_AQL" | jq -s -R -r @uri)

                                        GRANDCHILD_TEMP_FILE=$(mktemp)
                                        GRANDCHILD_PAGE_NUM=1
                                        GRANDCHILD_PAGE_SIZE=$DEFAULT_PAGE_SIZE

                                        while true; do
                                            API_URL="$BASE_API_URL/assets/1.0/aql/objects"
                                            API_URL="${API_URL}?qlQuery=$ENCODED_GRANDCHILD_AQL"
                                            API_URL="${API_URL}&objectSchemaId=$SCHEMA_ID"
                                            API_URL="${API_URL}&page=$GRANDCHILD_PAGE_NUM"
                                            API_URL="${API_URL}&resultPerPage=$GRANDCHILD_PAGE_SIZE"
                                            API_URL="${API_URL}&includeAttributes=true"

                                            GRANDCHILD_OBJECTS_RESPONSE_FILE=$(api_call "$API_URL")
                                            GRANDCHILD_OBJECTS_HTTP_STATUS=$(get_response_status "$GRANDCHILD_OBJECTS_RESPONSE_FILE")
                                            GRANDCHILD_OBJECTS_BODY=$(get_response_body "$GRANDCHILD_OBJECTS_RESPONSE_FILE")

                                            if [ "$GRANDCHILD_OBJECTS_HTTP_STATUS" -ne 200 ]; then
                                                echo "            Warning: HTTP $GRANDCHILD_OBJECTS_HTTP_STATUS for grandchild page $GRANDCHILD_PAGE_NUM. Stopping."
                                                rm -f "$GRANDCHILD_OBJECTS_RESPONSE_FILE"
                                                break
                                            fi

                                            # Extract objects using robust function
                                            GRANDCHILD_PAGE_OBJECTS=$(extract_objects_robust "$GRANDCHILD_OBJECTS_BODY" "grandchild_type_${GRANDCHILD_TYPE_ID}_page_${GRANDCHILD_PAGE_NUM}")
                                            GRANDCHILD_EXTRACT_SUCCESS=$?
                                            GRANDCHILD_PAGE_COUNT=$(echo "$GRANDCHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")

                                            if [ "${GRANDCHILD_PAGE_COUNT:-0}" -gt 0 ]; then
                                                echo "            Extracted $GRANDCHILD_PAGE_COUNT grandchild objects"
                                                echo "$GRANDCHILD_PAGE_OBJECTS" | jq -c '.[]' >> "$GRANDCHILD_TEMP_FILE"
                                            elif [ $GRANDCHILD_EXTRACT_SUCCESS -eq 0 ]; then
                                                echo "            No objects found for grandchild type (empty result)"
                                                break
                                            else
                                                echo "            ERROR: Failed to extract grandchild objects"
                                                break
                                            fi

                                            rm -f "$GRANDCHILD_OBJECTS_RESPONSE_FILE"

                                            # Check if we've reached the end
                                            if [ "${GRANDCHILD_PAGE_COUNT:-0}" -lt "$GRANDCHILD_PAGE_SIZE" ]; then
                                                break
                                            fi

                                            GRANDCHILD_PAGE_NUM=$((GRANDCHILD_PAGE_NUM + 1))
                                        done

                                        # Save all collected grandchild objects
                                        GRANDCHILD_OBJECTS_FILE="$GRANDCHILD_TYPE_DIR/objects.json"
                                        finalize_temp_file "$GRANDCHILD_TEMP_FILE" "$GRANDCHILD_OBJECTS_FILE" "grandchild type '$GRANDCHILD_TYPE_NAME'" "            " "$GRANDCHILD_TYPE_DIR"

                                        # Count grandchild objects in statistics
                                        if [ -f "$GRANDCHILD_OBJECTS_FILE" ]; then
                                            GRANDCHILD_COUNT=$(jq 'length' "$GRANDCHILD_OBJECTS_FILE" 2>/dev/null || echo "0")
                                            TOTAL_CHILD_OBJECTS_SUCCESS=$((TOTAL_CHILD_OBJECTS_SUCCESS + GRANDCHILD_COUNT))

                                            # Update per-schema child object count
                                            CURRENT_CHILD_OBJECTS=$(get_schema_stat "$SCHEMA_ID" "child_objects")
                                            set_schema_stat "$SCHEMA_ID" "child_objects" "$((CURRENT_CHILD_OBJECTS + GRANDCHILD_COUNT))"

                                            echo "            Added $GRANDCHILD_COUNT grandchild objects to statistics"
                                        fi

                                        # Track that this grandchild type was successfully processed
                                        SUCCESSFULLY_PROCESSED_CHILDREN="$SUCCESSFULLY_PROCESSED_CHILDREN $GRANDCHILD_TYPE_ID"
                                        echo "            DEBUG: Successfully processed grandchild type '$GRANDCHILD_TYPE_NAME' (ID: $GRANDCHILD_TYPE_ID) - added to processed list"
                                    done <<< "$GRANDCHILD_TYPES"
                                fi
                            fi
                        done <<< "$CONCRETE_CHILD_TYPES"

                        echo "      Completed processing child types of concrete parent '$OBJECT_TYPE_NAME'"
                        echo "      DEBUG: Successfully processed children: $SUCCESSFULLY_PROCESSED_CHILDREN"
                else
                    echo "      No child types found for concrete parent '$OBJECT_TYPE_NAME'"
                fi
            fi
        else
            # For abstract types, fetch and process child types separately
            if [ "$IS_ABSTRACT" == "true" ]; then
                echo "      Abstract type detected. Processing child object types separately..."

                # Find child types where parentObjectTypeId matches our abstract type
                CHILD_TYPES=$(echo "$OBJECT_TYPES" | jq -c ". | select(.parentObjectTypeId == $OBJECT_TYPE_ID)" 2>/dev/null)

                if [ -n "$CHILD_TYPES" ]; then
                    echo "      Found child object types of '$OBJECT_TYPE_NAME':"

                    # Process each child type separately
                    while IFS= read -r child_type; do
                        CHILD_TYPE_ID=$(echo "$child_type" | jq -r '.id')
                        CHILD_TYPE_NAME=$(echo "$child_type" | jq -r '.name')

                            echo "        Processing child type: '$CHILD_TYPE_NAME' (ID: $CHILD_TYPE_ID)"

                            # Create directory for this child type under the parent abstract type
                            SANITIZED_CHILD_NAME=$(echo "$CHILD_TYPE_NAME" | sed 's/[^a-zA-Z0-9._-]/_/g')
                            # Store under parent type directory: Schema/ParentType/ChildType/
                            CHILD_TYPE_DIR="$OBJECT_TYPE_DIR/$SANITIZED_CHILD_NAME"
                            mkdir -p "$CHILD_TYPE_DIR"

                            # Fetch objects for this specific child type with pagination
                            CHILD_AQL="objectTypeId = $CHILD_TYPE_ID"
                            ENCODED_CHILD_AQL=$(printf %s "$CHILD_AQL" | jq -s -R -r @uri)

                            echo "          DEBUG: AQL Query: $CHILD_AQL"
                            echo "          DEBUG: Encoded: $ENCODED_CHILD_AQL"

                            # Use temp file for efficient pagination
                            CHILD_TEMP_FILE=$(mktemp)
                            echo "          DEBUG: Temp file: $CHILD_TEMP_FILE"
                            CHILD_PAGE_NUM=1
                            CHILD_PAGE_SIZE=$DEFAULT_PAGE_SIZE
                            CHILD_TOTAL_FETCHED=0

                            while true; do
                                CHILD_URL="$BASE_API_URL/assets/1.0/aql/objects"
                                CHILD_URL="${CHILD_URL}?qlQuery=$ENCODED_CHILD_AQL"
                                CHILD_URL="${CHILD_URL}&objectSchemaId=$SCHEMA_ID"
                                CHILD_URL="${CHILD_URL}&page=$CHILD_PAGE_NUM"
                                CHILD_URL="${CHILD_URL}&resultPerPage=$CHILD_PAGE_SIZE"
                                CHILD_URL="${CHILD_URL}&includeAttributes=true"

                                echo "          DEBUG: Fetching page $CHILD_PAGE_NUM - URL: $CHILD_URL"

                                CHILD_OBJECTS_RESPONSE_FILE=$(api_call "$CHILD_URL")
                                echo "          DEBUG: Response file: $CHILD_OBJECTS_RESPONSE_FILE"
                                CHILD_OBJECTS_STATUS=$(get_response_status "$CHILD_OBJECTS_RESPONSE_FILE")
                                echo "          DEBUG: HTTP Status: $CHILD_OBJECTS_STATUS"
                                CHILD_OBJECTS_BODY_FILE=$(get_response_body_to_file "$CHILD_OBJECTS_RESPONSE_FILE")
                                echo "          DEBUG: Body file: $CHILD_OBJECTS_BODY_FILE"

                                if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                    echo "          DEBUG: Response body size: $(wc -c < "$CHILD_OBJECTS_BODY_FILE") bytes"
                                else
                                    echo "          DEBUG: ERROR - Body file does not exist!"
                                fi

                                if [ "$CHILD_OBJECTS_STATUS" != "200" ]; then
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        echo "          DEBUG: Non-200 status, response preview: $(head -c 500 "$CHILD_OBJECTS_BODY_FILE")"
                                    else
                                        echo "          DEBUG: Non-200 status, response preview: [BODY FILE MISSING]"
                                    fi
                                    if [ "$CHILD_PAGE_NUM" -eq 1 ]; then
                                        echo "          Failed to fetch objects for '$CHILD_TYPE_NAME'"

                                        # Try POST fallback
                                        FALLBACK_RESPONSE_FILE=$(try_post_aql_fallback "$CHILD_AQL" "$SCHEMA_ID" "$CHILD_PAGE_NUM" "$CHILD_PAGE_SIZE" "$CHILD_TYPE_NAME")
                                        FALLBACK_STATUS=$(get_response_status "$FALLBACK_RESPONSE_FILE")

                                        if [ "$FALLBACK_STATUS" = "200" ]; then
                                            echo "          DEBUG: POST fallback successful for '$CHILD_TYPE_NAME'!"
                                            # Use the fallback response
                                            rm -f "$CHILD_OBJECTS_RESPONSE_FILE" "$CHILD_OBJECTS_BODY_FILE"
                                            CHILD_OBJECTS_RESPONSE_FILE="$FALLBACK_RESPONSE_FILE"
                                            CHILD_OBJECTS_STATUS="$FALLBACK_STATUS"
                                            # Update the body file to point to the fallback response
                                            CHILD_OBJECTS_BODY_FILE=$(get_response_body_to_file "$CHILD_OBJECTS_RESPONSE_FILE")
                                            echo "          DEBUG: POST Response body size: $(wc -c < "$CHILD_OBJECTS_BODY_FILE") bytes"
                                        else
                                            echo "          DEBUG: POST fallback also failed for '$CHILD_TYPE_NAME'"
                                            rm -f "$CHILD_OBJECTS_RESPONSE_FILE" "$CHILD_OBJECTS_BODY_FILE" "$FALLBACK_RESPONSE_FILE"
                                            break
                                        fi
                                    else
                                        rm -f "$CHILD_OBJECTS_RESPONSE_FILE" "$CHILD_OBJECTS_BODY_FILE"
                                        break
                                    fi
                                fi

                                # Robust object extraction with improved error handling for child types
                                CHILD_PAGE_OBJECTS=""
                                CHILD_PAGE_COUNT=0

                                echo "          DEBUG: === OBJECT EXTRACTION ATTEMPT ==="

                                # First, validate the JSON response using file-based approach
                                if [ -f "$CHILD_OBJECTS_BODY_FILE" ] && [ -s "$CHILD_OBJECTS_BODY_FILE" ] && jq empty "$CHILD_OBJECTS_BODY_FILE" 2>/dev/null; then
                                    echo "          DEBUG: JSON validation passed"
                                    # Use our enhanced file-based extraction function
                                    CHILD_PAGE_OBJECTS_FILE=$(extract_objects_robust_from_file "$CHILD_OBJECTS_BODY_FILE" "child_type_${CHILD_TYPE_ID}_page_${CHILD_PAGE_NUM}")
                                    CHILD_PAGE_COUNT=$(jq 'length' "$CHILD_PAGE_OBJECTS_FILE" 2>/dev/null || echo "0")
                                    echo "          DEBUG: Extracted $CHILD_PAGE_COUNT objects with attributes"
                                else
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        echo "          DEBUG: JSON validation failed. Response size: $(wc -c < "$CHILD_OBJECTS_BODY_FILE") bytes"
                                        echo "          DEBUG: First 5000 chars: $(head -c 5000 "$CHILD_OBJECTS_BODY_FILE")"
                                    else
                                        echo "          DEBUG: JSON validation failed. Body file missing or empty."
                                        echo "          DEBUG: First 5000 chars: [FILE NOT AVAILABLE]"
                                    fi

                                    # Try to extract partial data from potentially truncated JSON
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        PARTIAL_OBJECTS=$(grep -o '"objectEntries":\[[^]]*\]' "$CHILD_OBJECTS_BODY_FILE" | head -c 50000)
                                    else
                                        PARTIAL_OBJECTS=""
                                    fi
                                    if [ -n "$PARTIAL_OBJECTS" ]; then
                                        echo "          DEBUG: Found partial objectEntries data, attempting to parse..."
                                        # Extract just the array part
                                        PARTIAL_ARRAY=$(echo "$PARTIAL_OBJECTS" | sed -n 's/.*"objectEntries":\(\[[^]]*\]\).*/\1/p')
                                        if [ -n "$PARTIAL_ARRAY" ] && validate_json "$PARTIAL_ARRAY"; then
                                            CHILD_PAGE_OBJECTS="$PARTIAL_ARRAY"
                                            CHILD_PAGE_COUNT=$(echo "$CHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                            echo "          DEBUG: Partial extraction found $CHILD_PAGE_COUNT objects"
                                        fi
                                    fi

                                    # If partial extraction failed, check if it's truly empty or needs fallback
                                    if [ "${CHILD_PAGE_COUNT:-0}" -eq 0 ]; then
                                        # First check if this is a valid empty response (totalFilterCount = 0)
                                        if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                            CHILD_TOTAL_FILTER_COUNT=$(jq -r '.totalFilterCount // -1' "$CHILD_OBJECTS_BODY_FILE" 2>/dev/null)
                                        else
                                            CHILD_TOTAL_FILTER_COUNT=-1
                                        fi

                                        if [ "$CHILD_PAGE_NUM" -eq 1 ] && [ "$CHILD_TOTAL_FILTER_COUNT" -eq 0 ]; then
                                            echo "          INFO: Child type '$CHILD_TYPE_NAME' is empty (0 objects) - this is valid"
                                            echo "          Will check for grandchild types that may contain the actual data..."
                                            # Create empty array for consistency
                                            CHILD_PAGE_OBJECTS_FILE=$(mktemp)
                                            echo "[]" > "$CHILD_PAGE_OBJECTS_FILE"
                                            CHILD_PAGE_OBJECTS="[]"
                                            CHILD_PAGE_COUNT=0
                                            # Don't trigger fallback strategies for valid empty responses
                                        else
                                            echo "          DEBUG: Triggering intelligent fallback mechanism for child type..."

                                            # Try multiple fallback strategies to preserve attributes while handling large responses
                                            CHILD_FALLBACK_SUCCESS=false

                                        # Strategy 1: Try with includeAttributesDeep=1 (less deep nesting)
                                        echo "          DEBUG: Child Fallback Strategy 1 - Trying with includeAttributesDeep=1..."
                                        CHILD_FALLBACK_URL_1="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_CHILD_AQL&objectSchemaId=$SCHEMA_ID&page=$CHILD_PAGE_NUM&resultPerPage=$CHILD_PAGE_SIZE&includeAttributes=true&includeAttributesDeep=1"
                                        CHILD_FALLBACK_RESPONSE_FILE_1=$(api_call "$CHILD_FALLBACK_URL_1")
                                        CHILD_FALLBACK_STATUS_1=$(get_response_status "$CHILD_FALLBACK_RESPONSE_FILE_1")
                                        CHILD_FALLBACK_BODY_1=$(get_response_body "$CHILD_FALLBACK_RESPONSE_FILE_1")

                                        if [ "$CHILD_FALLBACK_STATUS_1" = "200" ] && validate_json "$CHILD_FALLBACK_BODY_1"; then
                                            CHILD_PAGE_OBJECTS=$(extract_objects_robust "$CHILD_FALLBACK_BODY_1" "child_fallback_strategy_1_page_${CHILD_PAGE_NUM}")
                                            CHILD_PAGE_COUNT=$(echo "$CHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                            if [ "${CHILD_PAGE_COUNT:-0}" -gt 0 ]; then
                                                echo "          DEBUG: Child Strategy 1 successful - got $CHILD_PAGE_COUNT objects with shallow attributes"
                                                CHILD_FALLBACK_SUCCESS=true
                                            fi
                                        fi
                                        rm -f "$CHILD_FALLBACK_RESPONSE_FILE_1"

                                        # Strategy 2: Try with includeAttributesDeep=0 (no deep nesting)
                                        if [ "$CHILD_FALLBACK_SUCCESS" = false ]; then
                                            echo "          DEBUG: Child Fallback Strategy 2 - Trying with includeAttributesDeep=0..."
                                            CHILD_FALLBACK_URL_2="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_CHILD_AQL&objectSchemaId=$SCHEMA_ID&page=$CHILD_PAGE_NUM&resultPerPage=$CHILD_PAGE_SIZE&includeAttributes=true&includeAttributesDeep=0"
                                            CHILD_FALLBACK_RESPONSE_FILE_2=$(api_call "$CHILD_FALLBACK_URL_2")
                                            CHILD_FALLBACK_STATUS_2=$(get_response_status "$CHILD_FALLBACK_RESPONSE_FILE_2")
                                            CHILD_FALLBACK_BODY_2=$(get_response_body "$CHILD_FALLBACK_RESPONSE_FILE_2")

                                            if [ "$CHILD_FALLBACK_STATUS_2" = "200" ] && validate_json "$CHILD_FALLBACK_BODY_2"; then
                                                CHILD_PAGE_OBJECTS=$(extract_objects_robust "$CHILD_FALLBACK_BODY_2" "child_fallback_strategy_2_page_${CHILD_PAGE_NUM}")
                                                CHILD_PAGE_COUNT=$(echo "$CHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                                if [ "${CHILD_PAGE_COUNT:-0}" -gt 0 ]; then
                                                    echo "          DEBUG: Child Strategy 2 successful - got $CHILD_PAGE_COUNT objects with basic attributes"
                                                    CHILD_FALLBACK_SUCCESS=true
                                                fi
                                            fi
                                            rm -f "$CHILD_FALLBACK_RESPONSE_FILE_2"
                                        fi

                                        # Strategy 3: Try without extended info but keep attributes
                                        if [ "$CHILD_FALLBACK_SUCCESS" = false ]; then
                                            echo "          DEBUG: Child Fallback Strategy 3 - Trying without extended info..."
                                            CHILD_FALLBACK_URL_3="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_CHILD_AQL&objectSchemaId=$SCHEMA_ID&page=$CHILD_PAGE_NUM&resultPerPage=$CHILD_PAGE_SIZE&includeAttributes=true&includeExtendedInfo=false"
                                            CHILD_FALLBACK_RESPONSE_FILE_3=$(api_call "$CHILD_FALLBACK_URL_3")
                                            CHILD_FALLBACK_STATUS_3=$(get_response_status "$CHILD_FALLBACK_RESPONSE_FILE_3")
                                            CHILD_FALLBACK_BODY_3=$(get_response_body "$CHILD_FALLBACK_RESPONSE_FILE_3")

                                            if [ "$CHILD_FALLBACK_STATUS_3" = "200" ] && validate_json "$CHILD_FALLBACK_BODY_3"; then
                                                CHILD_PAGE_OBJECTS=$(extract_objects_robust "$CHILD_FALLBACK_BODY_3" "child_fallback_strategy_3_page_${CHILD_PAGE_NUM}")
                                                CHILD_PAGE_COUNT=$(echo "$CHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                                if [ "${CHILD_PAGE_COUNT:-0}" -gt 0 ]; then
                                                    echo "          DEBUG: Child Strategy 3 successful - got $CHILD_PAGE_COUNT objects with attributes (no extended info)"
                                                    CHILD_FALLBACK_SUCCESS=true
                                                fi
                                            fi
                                            rm -f "$CHILD_FALLBACK_RESPONSE_FILE_3"
                                        fi

                                        # Strategy 4: Last resort - smaller page size but keep attributes
                                        if [ "$CHILD_FALLBACK_SUCCESS" = false ]; then
                                            CHILD_REDUCED_PAGE_SIZE=$((DEFAULT_PAGE_SIZE / 2))
                                            echo "          DEBUG: Child Fallback Strategy 4 - Trying smaller page size ($CHILD_REDUCED_PAGE_SIZE) but keeping attributes..."
                                            CHILD_FALLBACK_URL_4="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_CHILD_AQL&objectSchemaId=$SCHEMA_ID&page=$CHILD_PAGE_NUM&resultPerPage=$CHILD_REDUCED_PAGE_SIZE&includeAttributes=true&includeAttributesDeep=0&includeExtendedInfo=false"
                                            CHILD_FALLBACK_RESPONSE_FILE_4=$(api_call "$CHILD_FALLBACK_URL_4")
                                            CHILD_FALLBACK_STATUS_4=$(get_response_status "$CHILD_FALLBACK_RESPONSE_FILE_4")
                                            CHILD_FALLBACK_BODY_4=$(get_response_body "$CHILD_FALLBACK_RESPONSE_FILE_4")

                                            if [ "$CHILD_FALLBACK_STATUS_4" = "200" ] && validate_json "$CHILD_FALLBACK_BODY_4"; then
                                                CHILD_PAGE_OBJECTS=$(extract_objects_robust "$CHILD_FALLBACK_BODY_4" "child_fallback_strategy_4_page_${CHILD_PAGE_NUM}")
                                                CHILD_PAGE_COUNT=$(echo "$CHILD_PAGE_OBJECTS" | jq 'length' 2>/dev/null || echo "0")
                                                if [ "${CHILD_PAGE_COUNT:-0}" -gt 0 ]; then
                                                    echo "          DEBUG: Child Strategy 4 successful - got $CHILD_PAGE_COUNT objects with reduced page size"
                                                    CHILD_FALLBACK_SUCCESS=true
                                                    # Adjust page size for remaining pages
                                                    CHILD_PAGE_SIZE=$CHILD_REDUCED_PAGE_SIZE
                                                fi
                                            fi
                                            rm -f "$CHILD_FALLBACK_RESPONSE_FILE_4"
                                        fi

                                            # If all attribute-preserving strategies failed, this might be a valid empty type
                                            if [ "$CHILD_FALLBACK_SUCCESS" = false ]; then
                                                echo "          INFO: No objects found for child type '$CHILD_TYPE_NAME' after trying all strategies"
                                                echo "          NOTE: This may be a valid empty container type - will check for grandchildren"
                                                break
                                            fi
                                        fi  # End of fallback strategies block
                                    fi  # End of CHILD_PAGE_COUNT -eq 0 check
                                fi  # End of JSON validation check

                                # Debug pagination metadata
                                if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                    CHILD_TOTAL_FILTER_COUNT=$(jq -r '.totalFilterCount // 0' "$CHILD_OBJECTS_BODY_FILE" 2>/dev/null)
                                else
                                    CHILD_TOTAL_FILTER_COUNT=0
                                fi
                                echo "          DEBUG: === PAGINATION METADATA ==="
                                echo "          DEBUG: Page objects count: $CHILD_PAGE_COUNT"
                                echo "          DEBUG: Total filter count: $CHILD_TOTAL_FILTER_COUNT"
                                echo "          DEBUG: Page size requested: $CHILD_PAGE_SIZE"

                                # Additional debugging for empty responses
                                if [ "${CHILD_PAGE_COUNT:-0}" -eq 0 ]; then
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        echo "          DEBUG: Empty child response ($(wc -c < "$CHILD_OBJECTS_BODY_FILE") chars): $(head -c 300 "$CHILD_OBJECTS_BODY_FILE")"
                                    else
                                        echo "          DEBUG: Empty child response (body file missing)"
                                    fi
                                fi

                                # Save response to file for manual inspection if it's large or problematic
                                if [ "$CHILD_PAGE_NUM" -eq 1 ] || [ "${CHILD_PAGE_COUNT:-0}" -eq 0 ]; then
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ] && ([ "$(wc -c < "$CHILD_OBJECTS_BODY_FILE")" -gt 100000 ] || [ "${CHILD_PAGE_COUNT:-0}" -eq 0 ]); then
                                        echo "          DEBUG: Saving detailed debug file due to size or empty response..."
                                        DEBUG_FILENAME="/tmp/debug_response_${CHILD_TYPE_ID}_${CHILD_TYPE_NAME}_page${CHILD_PAGE_NUM}.json"
                                        cp "$CHILD_OBJECTS_BODY_FILE" "$DEBUG_FILENAME"
                                        echo "          DEBUG: Saved to $DEBUG_FILENAME (size: $(wc -c < "$DEBUG_FILENAME") bytes)"
                                    elif [ ! -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        echo "          DEBUG: Cannot save debug file - body file is missing"
                                    fi
                                fi

                                if [ "${CHILD_PAGE_COUNT:-0}" -eq 0 ]; then
                                    # Check if this is the first page with totalFilterCount = 0 (truly empty)
                                    if [ -f "$CHILD_OBJECTS_BODY_FILE" ]; then
                                        CHILD_TOTAL_FILTER_COUNT=$(jq -r '.totalFilterCount // 0' "$CHILD_OBJECTS_BODY_FILE" 2>/dev/null)
                                    else
                                        CHILD_TOTAL_FILTER_COUNT=0
                                    fi

                                    if [ "$CHILD_PAGE_NUM" -eq 1 ] && [ "$CHILD_TOTAL_FILTER_COUNT" -eq 0 ]; then
                                        echo "          INFO: Child type '$CHILD_TYPE_NAME' is empty (0 objects) - this is valid"
                                        echo "          Will check for grandchild types that may contain the actual data..."
                                        # Create empty array in temp file for consistency
                                        echo "[]" | jq -c '.[]' > "$CHILD_TEMP_FILE"
                                    else
                                        echo "          DEBUG: No objects found on page $CHILD_PAGE_NUM, breaking loop"
                                    fi
                                    break
                                fi

                                # Append objects to temp file (one per line for efficiency)
                                if [ -f "$CHILD_PAGE_OBJECTS_FILE" ]; then
                                    jq -c '.[]' "$CHILD_PAGE_OBJECTS_FILE" >> "$CHILD_TEMP_FILE"
                                else
                                    # Fallback for cases where CHILD_PAGE_OBJECTS is still used (fallback strategies)
                                    echo "$CHILD_PAGE_OBJECTS" | jq -c '.[]' >> "$CHILD_TEMP_FILE"
                                fi
                                CHILD_TOTAL_FETCHED=$((CHILD_TOTAL_FETCHED + CHILD_PAGE_COUNT))

                                echo "          DEBUG: Wrote $CHILD_PAGE_COUNT objects (total: $CHILD_TOTAL_FETCHED)"

                                # Clean up response and temporary files after successful processing
                                rm -f "$CHILD_OBJECTS_RESPONSE_FILE" "$CHILD_OBJECTS_BODY_FILE"
                                [ -f "$CHILD_PAGE_OBJECTS_FILE" ] && rm -f "$CHILD_PAGE_OBJECTS_FILE"

                                if [ "${CHILD_PAGE_COUNT:-0}" -lt "${CHILD_PAGE_SIZE:-2000}" ]; then
                                    break
                                fi

                                if [ -n "$CHILD_TOTAL_FILTER_COUNT" ] && [ "$CHILD_TOTAL_FILTER_COUNT" -gt 0 ] && [ "$CHILD_TOTAL_FETCHED" -ge "$CHILD_TOTAL_FILTER_COUNT" ]; then
                                    break
                                fi

                                echo "          Fetched $CHILD_PAGE_COUNT objects (page $CHILD_PAGE_NUM), total: $CHILD_TOTAL_FETCHED/$CHILD_TOTAL_FILTER_COUNT..."

                                CHILD_PAGE_NUM=$((CHILD_PAGE_NUM + 1))

                                if [ "$CHILD_PAGE_NUM" -gt 50 ]; then
                                    echo "          Warning: Reached page limit for child type."
                                    break
                                fi
                            done

                            # Save all collected objects for this child type
                            CHILD_OBJECTS_FILE="$CHILD_TYPE_DIR/objects.json"
                            finalize_temp_file "$CHILD_TEMP_FILE" "$CHILD_OBJECTS_FILE" "child type '$CHILD_TYPE_NAME'" "          " "$CHILD_TYPE_DIR"

                            # Track that this child type was successfully processed
                            SUCCESSFULLY_PROCESSED_CHILDREN="$SUCCESSFULLY_PROCESSED_CHILDREN $CHILD_TYPE_ID"
                            if [ "$CHILD_TOTAL_FETCHED" -eq 0 ]; then
                                echo "          INFO: Successfully processed EMPTY child type '$CHILD_TYPE_NAME' (ID: $CHILD_TYPE_ID)"
                            else
                                echo "          DEBUG: Successfully processed child type '$CHILD_TYPE_NAME' (ID: $CHILD_TYPE_ID) - added to processed list"
                            fi

                            # Update child statistics
                            TOTAL_CHILD_TYPES_PROCESSED=$((TOTAL_CHILD_TYPES_PROCESSED + 1))
                            TOTAL_CHILD_OBJECTS_SUCCESS=$((TOTAL_CHILD_OBJECTS_SUCCESS + CHILD_TOTAL_FETCHED))

                            # Update detailed per-schema child statistics
                            CURRENT_CHILD_TYPES=$(get_schema_stat "$SCHEMA_ID" "child_types")
                            CURRENT_CHILD_OBJECTS=$(get_schema_stat "$SCHEMA_ID" "child_objects")
                            set_schema_stat "$SCHEMA_ID" "child_types" "$((CURRENT_CHILD_TYPES + 1))"
                            set_schema_stat "$SCHEMA_ID" "child_objects" "$((CURRENT_CHILD_OBJECTS + CHILD_TOTAL_FETCHED))"

                            # Check if this child type has its own children (grandchildren) - especially if it has 0 objects
                            if [ "$CHILD_TOTAL_FETCHED" -eq 0 ]; then
                                echo "          Child type '$CHILD_TYPE_NAME' has 0 objects - checking for grandchild types..."

                                # Find grandchild types where parentObjectTypeId matches this child type
                                GRANDCHILD_TYPES=$(echo "$OBJECT_TYPES" | jq -c ". | select(.parentObjectTypeId == $CHILD_TYPE_ID)" 2>/dev/null)

                                if [ -n "$GRANDCHILD_TYPES" ]; then
                                    GRANDCHILD_COUNT=$(echo "$GRANDCHILD_TYPES" | wc -l | tr -d ' ')
                                    echo "          Found $GRANDCHILD_COUNT grandchild type(s) under empty child '$CHILD_TYPE_NAME'"

                                    while IFS= read -r grandchild_type; do
                                        GRANDCHILD_TYPE_ID=$(echo "$grandchild_type" | jq -r '.id')
                                        GRANDCHILD_TYPE_NAME=$(echo "$grandchild_type" | jq -r '.name')

                                        # NOTE: We do NOT add grandchildren to SUCCESSFULLY_PROCESSED_CHILDREN here
                                        # because they haven't been processed yet - they'll be processed when encountered
                                        # as standalone types or as children of the abstract parent

                                        echo "            NOTE: Grandchild type '$GRANDCHILD_TYPE_NAME' (ID: $GRANDCHILD_TYPE_ID) found"
                                        echo "            It will be processed when encountered in the hierarchy"
                                    done <<< "$GRANDCHILD_TYPES"
                                else
                                    echo "          No grandchild types found for empty child '$CHILD_TYPE_NAME'"
                                fi
                            fi
                        done <<< "$CHILD_TYPES"

                        # Skip normal processing for abstract type
                        echo "      Completed processing child types of abstract type '$OBJECT_TYPE_NAME'"
                        echo "      DEBUG: Successfully processed children: $SUCCESSFULLY_PROCESSED_CHILDREN"
                        continue
                else
                    echo "      No child types found for abstract type '$OBJECT_TYPE_NAME'"
                    continue
                fi
            else
                echo "      Failed to fetch child types (HTTP $CHILD_TYPES_STATUS)"
            fi
        fi
    done < <(echo "$OBJECT_TYPES")
done < <(echo "$SCHEMAS")

# Calculate script end time and duration
SCRIPT_END_TIME=$(date '+%H:%M:%S')
SCRIPT_END_TIMESTAMP=$(date)

echo ""
echo "=========================================="
echo "ASSET EXTRACTION COMPLETE!"
echo "=========================================="
echo "Start time: $SCRIPT_START_TIME"
echo "End time: $SCRIPT_END_TIME"
echo "Completed at: $SCRIPT_END_TIMESTAMP"
echo ""
# Print comprehensive statistics breakdown
print_detailed_statistics() {
    echo "COMPREHENSIVE EXTRACTION STATISTICS:"
    echo "===================================="
    echo ""

    # Overall summary
    echo "OVERALL SUMMARY:"
    echo "==============="
    echo "Schemas:"
    echo "  - Total processed: $TOTAL_SCHEMAS_PROCESSED"
    echo "  - Successfully extracted: $TOTAL_SCHEMAS_SUCCESS"
    echo "  - Schema attributes extracted: $TOTAL_SCHEMA_ATTRIBUTES_SUCCESS"
    echo ""
    echo "Object Types:"
    echo "  - Total processed: $TOTAL_OBJECT_TYPES_PROCESSED"
    echo "  - Successfully extracted: $TOTAL_OBJECT_TYPES_SUCCESS"
    echo ""
    echo "Objects:"
    echo "  - Total processed: $TOTAL_OBJECTS_PROCESSED"
    echo "  - Parent objects extracted: $TOTAL_OBJECTS_SUCCESS"
    echo "  - Child objects extracted: $TOTAL_CHILD_OBJECTS_SUCCESS"
    echo "  - TOTAL UNIQUE OBJECTS: $((TOTAL_OBJECTS_SUCCESS + TOTAL_CHILD_OBJECTS_SUCCESS))"
    echo ""
    echo "Child Types:"
    echo "  - Child types processed: $TOTAL_CHILD_TYPES_PROCESSED"
    echo ""

    # Detailed per-schema breakdown
    echo "DETAILED BREAKDOWN BY SCHEMA:"
    echo "============================"
    echo ""

    # Sort schemas by name for consistent output
    for schema_id in $(get_all_schema_ids); do
        schema_name=$(get_schema_name "$schema_id")
        attr_count=$(get_schema_stat "$schema_id" "attributes")
        ot_count=$(get_schema_stat "$schema_id" "object_types")
        obj_count=$(get_schema_stat "$schema_id" "objects")
        child_types=$(get_schema_stat "$schema_id" "child_types")
        child_objects=$(get_schema_stat "$schema_id" "child_objects")
        # Calculate REAL total (with deduplication fix, this should be accurate)
        real_total=$((obj_count + child_objects))

        echo "Schema: $schema_name (ID: $schema_id)"
        echo "  ├─ Attributes extracted: $attr_count"
        echo "  ├─ Object types found: $ot_count"
        echo "  ├─ Total objects extracted: $real_total"
        echo "  ├─   • Parent objects: $obj_count"
        echo "  └─   • Child objects: $child_objects"

        # Show object type breakdown for this schema
        if [ "$ot_count" -gt 0 ]; then
            echo "     Object Type Details:"
            # Find all object types for this schema
            get_object_type_details_for_schema "$schema_id" | while IFS= read -r line; do
                if [ -n "$line" ]; then
                    # Extract details from line: schema_id:object_type_id:name:object_count
                    ot_details="${line#*:*:}" # Remove schema_id:object_type_id:
                    ot_name="${ot_details%:*}"
                    ot_obj_count="${ot_details##*:}"
                    echo "       • $ot_name: $ot_obj_count objects"
                fi
            done
        fi
        echo ""
    done
}

# Call the detailed statistics function
print_detailed_statistics

# Add troubleshooting summary
echo "TROUBLESHOOTING SUMMARY:"
echo "======================="
failed_schemas=0
empty_schemas=0
successful_schemas=0

for schema_id in $(get_all_schema_ids); do
    schema_name=$(get_schema_name "$schema_id")
    attr_count=$(get_schema_stat "$schema_id" "attributes")
    ot_count=$(get_schema_stat "$schema_id" "object_types")
    obj_count=$(get_schema_stat "$schema_id" "objects")
    child_obj_count=$(get_schema_stat "$schema_id" "child_objects")
    # IMPORTANT: The REAL total includes both parent objects and child objects
    # But with deduplication fix, child objects should NOT be double-counted
    total_obj_count=$((obj_count + child_obj_count))

    if [ "$attr_count" -eq 0 ] && [ "$ot_count" -eq 0 ] && [ "$total_obj_count" -eq 0 ]; then
        echo "❌ FAILED: $schema_name - No data extracted"
        failed_schemas=$((failed_schemas + 1))
    elif [ "$total_obj_count" -eq 0 ]; then
        echo "⚠️  PARTIAL: $schema_name - Schema/types extracted but no objects"
        empty_schemas=$((empty_schemas + 1))
    else
        if [ "$child_obj_count" -gt 0 ]; then
            echo "✅ SUCCESS: $schema_name - $total_obj_count objects extracted (parent: $obj_count, child: $child_obj_count)"
        else
            echo "✅ SUCCESS: $schema_name - $total_obj_count objects extracted"
        fi
        successful_schemas=$((successful_schemas + 1))
    fi
done

echo ""
echo "Summary: $successful_schemas successful, $empty_schemas partial, $failed_schemas failed"
echo ""

# Show custom field identification statistics if enabled
# Ticket association statistics are shown inline during Phase 2 extraction
# No need for separate summary here since we process per-field, not per-object

echo "FALLBACK STRATEGY USAGE:"
echo "========================"
echo "Strategy 1 (includeAttributesDeep=1): $STRATEGY_1_SUCCESS times"
echo "Strategy 2 (includeAttributesDeep=0): $STRATEGY_2_SUCCESS times"
echo "Strategy 2 + Individual attributes: $STRATEGY_2_INDIVIDUAL_SUCCESS objects"
echo "Strategy 3 (no extended info): $STRATEGY_3_SUCCESS times"
echo "Strategy 4 (smaller page size): $STRATEGY_4_SUCCESS times"
echo "Strategy 5 (individual fetching): $STRATEGY_5_SUCCESS times"
echo ""

# Rate limiting section removed - no more retries means no rate limit tracking needed

echo "=========================================="
echo "Export completed successfully!"
echo "=========================================="
echo "All data saved in: $OUTPUT_DIR"
echo "Log file: $LOG_FILE"
echo ""
echo "Custom field cache preserved at: $CUSTOM_FIELD_CACHE_FILE"
if [ -f "$FAILED_ATTACHMENTS_LOG" ] && [ -s "$FAILED_ATTACHMENTS_LOG" ]; then
    echo "Failed attachments log: $FAILED_ATTACHMENTS_LOG"
fi
echo ""

# Clean up HTTP optimization files and statistics temp files
echo "Cleaning up temporary files..."
rm -f "$SCHEMA_STATS_FILE" "$SCHEMA_NAMES_FILE" "$SCHEMA_OBJECT_TYPE_DETAILS_FILE"
# Keep custom field cache file for user reference - don't delete it

echo "=========================================="
echo "Script execution completed"
echo "Duration: Start: $SCRIPT_START_TIMESTAMP, End: $(date)"
echo ""
echo "NOTE: Attachments are no longer processed by this script."
echo "To download attachments, run:"
echo "  ./get_datacenter_attachments.sh"
echo "=========================================="

# Only execute main logic if script is run directly (not sourced)
fi
