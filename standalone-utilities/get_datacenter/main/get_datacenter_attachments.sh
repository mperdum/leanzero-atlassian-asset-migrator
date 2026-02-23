#!/bin/bash

# =============================================================================
# Jira Datacenter Attachment Extractor
# =============================================================================
# This script extracts attachment metadata and downloads files for all assets
# It runs independently and in parallel with get_datacenter_assets.sh
# Creates separate attachment JSON files per object type (similar to ticket associations)
# =============================================================================

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/datacenter_common.sh"

# --- Attachment-Specific Configuration ---
DEFAULT_PAGE_SIZE=250

# Attachment extraction settings
MAX_ATTACHMENT_SIZE_MB=45         # Maximum attachment size to download (in MB)
ATTACHMENTS_PER_OBJECT=10         # Maximum number of attachments to process per object
SEQUENTIAL_ATTACHMENTS=false      # Allow parallel attachment downloads
DEBUG_ATTACHMENTS=true            # Enable detailed debugging for attachments

# Parallel processing configuration
PARALLEL_WORKERS=${PARALLEL_WORKERS:-10}  # Number of parallel workers

# Initialize logging
setup_logging "datacenter_attachments"

echo "Configuration:"
echo "  PARALLEL_WORKERS: $PARALLEL_WORKERS"
echo "  MAX_ATTACHMENT_SIZE_MB: $MAX_ATTACHMENT_SIZE_MB"
echo "  ATTACHMENTS_PER_OBJECT: $ATTACHMENTS_PER_OBJECT"
echo "  SEQUENTIAL_ATTACHMENTS: $SEQUENTIAL_ATTACHMENTS"
echo "  DEBUG_ATTACHMENTS: $DEBUG_ATTACHMENTS"
echo "=========================================="

# Create the output directory if it doesn't exist
ATTACHMENTS_OUTPUT_DIR="$OUTPUT_DIR/attachments"
mkdir -p "$ATTACHMENTS_OUTPUT_DIR"

# Global statistics counters
TOTAL_SCHEMAS_PROCESSED=0
TOTAL_OBJECT_TYPES_PROCESSED=0
TOTAL_OBJECTS_PROCESSED=0
TOTAL_OBJECTS_WITH_ATTACHMENTS=0
TOTAL_ATTACHMENTS_FOUND=0
TOTAL_ATTACHMENTS_DOWNLOADED=0
TOTAL_ATTACHMENT_ERRORS=0

# Failed attachment tracking
FAILED_ATTACHMENTS_LOG="$ATTACHMENTS_OUTPUT_DIR/failed_attachments.log"

echo "Starting attachment extraction from $JIRA_URL..."
echo "Start time: $SCRIPT_START_TIME ($SCRIPT_START_TIMESTAMP)"
echo "Configuration:"
echo "  - Parallel workers: $PARALLEL_WORKERS"
echo "  - Max attachment size: ${MAX_ATTACHMENT_SIZE_MB}MB"
echo "  - Max attachments per object: $ATTACHMENTS_PER_OBJECT"
echo "  - Sequential attachments: $SEQUENTIAL_ATTACHMENTS"
echo "  - Debug attachments: $DEBUG_ATTACHMENTS"
echo "=========================================="

# Function to sanitize filenames
sanitize_filename() {
    local filename="$1"
    # Replace problematic characters with underscores
    echo "$filename" | sed 's/[^a-zA-Z0-9._-]/_/g' | sed 's/__*/_/g' | sed 's/^_\|_$//g'
}

# Function to download a single attachment
download_attachment() {
    local attachment_url="$1"
    local filename="$2"
    local object_id="$3"
    local attachment_id="$4"
    local filesize="$5"
    local attachments_dir="$6"
    local object_key="${7:-}"

    # Convert filesize to MB for comparison
    local filesize_mb=0
    if [ -n "$filesize" ] && [ "$filesize" != "null" ] && [[ "$filesize" =~ ^[0-9]+$ ]]; then
        filesize_mb=$((filesize / 1024 / 1024))
    fi

    # Check file size limit
    local object_display="${object_key:-$object_id}"
    if [ -n "$object_key" ] && [ "$object_key" != "$object_id" ]; then
        object_display="$object_key (ID: $object_id)"
    fi

    if [ "$filesize_mb" -gt "$MAX_ATTACHMENT_SIZE_MB" ]; then
        echo "                    SKIPPED: File too large (${filesize_mb}MB > ${MAX_ATTACHMENT_SIZE_MB}MB): $filename [Object: $object_display]" >&2
        return 1
    fi

    # Sanitize filename
    local safe_filename=$(sanitize_filename "$filename")
    if [ -z "$safe_filename" ]; then
        safe_filename="attachment_${attachment_id}"
    fi

    # Add attachment ID prefix to avoid conflicts
    local final_filename="${attachment_id}_${safe_filename}"
    local output_path="$attachments_dir/$final_filename"

    # Skip if already downloaded
    if [ -f "$output_path" ]; then
        if [ "$DEBUG_ATTACHMENTS" = "true" ]; then
            echo "                    ALREADY EXISTS: $filename [Object: $object_display]" >&2
        fi
        # Return the relative path
        echo "attachments/${attachments_dir#$ATTACHMENTS_OUTPUT_DIR/}/$(basename "$output_path")"
        return 0
    fi

    # Build full URL
    local full_url=""
    if [[ "$attachment_url" == http://* ]] || [[ "$attachment_url" == https://* ]]; then
        full_url="$attachment_url"
    else
        local base_url="${JIRA_URL%/}"
        if [[ "$attachment_url" != /* ]]; then
            attachment_url="/$attachment_url"
        fi
        full_url="${base_url}${attachment_url}"
    fi

    # URL encode special characters
    local url_base="${full_url%/*}/"
    local url_filename="${full_url##*/}"
    local encoded_filename=$(printf '%s' "$url_filename" | jq -sRr @uri)
    local encoded_url="${url_base}${encoded_filename}"

    if [ "$DEBUG_ATTACHMENTS" = "true" ]; then
        echo "                    DEBUG: Downloading from: $encoded_url" >&2
        echo "                    DEBUG: Output path: $output_path" >&2
        echo "                    Downloading: $filename (${filesize_mb}MB) -> $final_filename [Object: $object_display]" >&2
    fi

    # Download the file
    if curl -s -u "$USERNAME:$PASSWORD" -o "$output_path" "$encoded_url"; then
        if [ -f "$output_path" ] && [ -s "$output_path" ]; then
            local actual_size=$(wc -c < "$output_path")
            local actual_size_mb=$((actual_size / 1024 / 1024))
            if [ "$DEBUG_ATTACHMENTS" = "true" ]; then
                echo "                    SUCCESS: Downloaded $filename ($actual_size bytes = ${actual_size_mb}MB) [Object: $object_display]" >&2
            fi
            # Return the relative path
            echo "attachments/${attachments_dir#$ATTACHMENTS_OUTPUT_DIR/}/$(basename "$output_path")"
            return 0
        else
            echo "                    ERROR: Downloaded file is empty: $filename [Object: $object_display]" >&2
            rm -f "$output_path"
            echo "$object_display|$filename|Empty file" >> "$FAILED_ATTACHMENTS_LOG"
            return 1
        fi
    else
        echo "                    ERROR: Failed to download $filename [Object: $object_display]" >&2
        rm -f "$output_path"
        echo "$object_display|$filename|Download failed" >> "$FAILED_ATTACHMENTS_LOG"
        return 1
    fi
}

# Function to fetch attachments for an object
fetch_object_attachments() {
    local object_id="$1"
    local object_key="${2:-}"
    local object_label="${3:-}"
    local attachments_base_dir="${4:-}"

    ATTACHMENTS_URL="$BASE_API_URL/assets/1.0/attachments/object/$object_id"
    ATTACHMENTS_RESPONSE_FILE=$(api_call "$ATTACHMENTS_URL")
    ATTACHMENTS_STATUS=$(get_response_status "$ATTACHMENTS_RESPONSE_FILE")

    if [ "$ATTACHMENTS_STATUS" = "200" ]; then
        ATTACHMENTS_BODY=$(get_response_body "$ATTACHMENTS_RESPONSE_FILE")
        ATTACHMENTS_DATA=$(echo "$ATTACHMENTS_BODY" | jq '.' 2>/dev/null)

        if [ -n "$ATTACHMENTS_DATA" ] && [ "$ATTACHMENTS_DATA" != "null" ] && [ "$ATTACHMENTS_DATA" != "[]" ]; then
            ATTACHMENT_COUNT=$(echo "$ATTACHMENTS_DATA" | jq 'length' 2>/dev/null || echo "0")

            if [ "$ATTACHMENT_COUNT" -gt 0 ]; then
                local obj_display="${object_key:-$object_id}"
                if [ -n "$object_key" ] && [ "$object_key" != "$object_id" ]; then
                    obj_display="$object_key (ID: $object_id)"
                fi

                # Only show detailed progress if DEBUG is enabled, otherwise just a summary
                if [ "$DEBUG_ATTACHMENTS" = "true" ]; then
                    echo "                  Processing $ATTACHMENT_COUNT attachment(s) for object: $obj_display" >&2
                fi

                # Limit number of attachments processed
                local max_attachments=$ATTACHMENTS_PER_OBJECT
                if [ "$ATTACHMENT_COUNT" -gt "$max_attachments" ]; then
                    echo "                  Found $ATTACHMENT_COUNT attachments, processing first $max_attachments" >&2
                    ATTACHMENTS_DATA=$(echo "$ATTACHMENTS_DATA" | jq ".[0:$max_attachments]" 2>/dev/null)
                    ATTACHMENT_COUNT=$max_attachments
                fi

                # Update statistics
                TOTAL_OBJECTS_WITH_ATTACHMENTS=$((TOTAL_OBJECTS_WITH_ATTACHMENTS + 1))
                TOTAL_ATTACHMENTS_FOUND=$((TOTAL_ATTACHMENTS_FOUND + ATTACHMENT_COUNT))

                # Create attachments directory
                local attachments_dir=""
                if [ -n "$attachments_base_dir" ]; then
                    attachments_dir="$attachments_base_dir/attachments"
                    mkdir -p "$attachments_dir"
                fi

                # Process each attachment
                local enhanced_attachments=$(mktemp)
                local attachment_temp_list=$(mktemp)
                echo "$ATTACHMENTS_DATA" | jq -c '.[]' > "$attachment_temp_list"

                local attachment_num=0
                while IFS= read -r attachment; do
                    attachment_num=$((attachment_num + 1))
                    if [ -n "$attachment" ] && [ "$attachment" != "null" ]; then
                        local att_id=$(echo "$attachment" | jq -r '.id // ""' 2>/dev/null)
                        local att_filename=$(echo "$attachment" | jq -r '.filename // ""' 2>/dev/null)
                        local att_url=$(echo "$attachment" | jq -r '.url // ""' 2>/dev/null)
                        local att_filesize=$(echo "$attachment" | jq -r '.filesize // ""' 2>/dev/null)

                        local enhanced_attachment="$attachment"

                        # Download the attachment file
                        if [ -n "$attachments_dir" ] && [ -n "$att_url" ]; then
                            local downloaded_path=$(download_attachment "$att_url" "$att_filename" "$object_id" "$att_id" "$att_filesize" "$attachments_dir" "$object_key")
                            if [ $? -eq 0 ] && [ -n "$downloaded_path" ]; then
                                local jq_result=$(echo "$enhanced_attachment" | jq --arg path "$downloaded_path" '. + {localFilePath: $path}' 2>/dev/null)
                                if [ $? -eq 0 ] && [ -n "$jq_result" ]; then
                                    enhanced_attachment="$jq_result"
                                    TOTAL_ATTACHMENTS_DOWNLOADED=$((TOTAL_ATTACHMENTS_DOWNLOADED + 1))
                                else
                                    TOTAL_ATTACHMENT_ERRORS=$((TOTAL_ATTACHMENT_ERRORS + 1))
                                fi
                            else
                                TOTAL_ATTACHMENT_ERRORS=$((TOTAL_ATTACHMENT_ERRORS + 1))
                            fi
                        fi

                        # Validate JSON before writing
                        if echo "$enhanced_attachment" | jq empty 2>/dev/null; then
                            printf '%s\n' "$enhanced_attachment" >> "$enhanced_attachments"
                        else
                            TOTAL_ATTACHMENT_ERRORS=$((TOTAL_ATTACHMENT_ERRORS + 1))
                        fi

                        if [ "$SEQUENTIAL_ATTACHMENTS" = "true" ] && [ "$attachment_num" -lt "$ATTACHMENT_COUNT" ]; then
                            sleep 0.1
                        fi
                    fi
                done < "$attachment_temp_list"

                rm -f "$attachment_temp_list"

                # Combine enhanced attachments into array
                if [ -f "$enhanced_attachments" ] && [ -s "$enhanced_attachments" ]; then
                    jq -s '.' "$enhanced_attachments"
                else
                    echo "$ATTACHMENTS_DATA"
                fi
                rm -f "$enhanced_attachments"
            else
                echo "[]"
            fi
        else
            echo "[]"
        fi
    elif [ "$ATTACHMENTS_STATUS" = "404" ]; then
        echo "[]"
    else
        echo "[]"
    fi

    rm -f "$ATTACHMENTS_RESPONSE_FILE"
}

# Function to process a single object's attachments (for parallel execution)
process_object_attachments() {
    local object="$1"
    local object_type_output_dir="$2"
    local output_file="$3"

    OBJECT_ID=$(echo "$object" | jq -r '.id')
    OBJECT_KEY=$(echo "$object" | jq -r '.objectKey // ""')
    OBJECT_LABEL=$(echo "$object" | jq -r '.label // .name // ""')

    # Fetch attachments for this object
    ATTACHMENTS_INFO=$(fetch_object_attachments "$OBJECT_ID" "$OBJECT_KEY" "$OBJECT_LABEL" "$object_type_output_dir")

    if [ -n "$ATTACHMENTS_INFO" ] && [ "$ATTACHMENTS_INFO" != "[]" ]; then
        ATTACHMENT_COUNT=$(echo "$ATTACHMENTS_INFO" | jq 'length' 2>/dev/null || echo "0")
        if [ "$ATTACHMENT_COUNT" -gt 0 ]; then
            # Store object with attachments to output file
            jq -n \
                --arg oid "$OBJECT_ID" \
                --arg okey "$OBJECT_KEY" \
                --arg olabel "$OBJECT_LABEL" \
                --argjson atts "$ATTACHMENTS_INFO" \
                '{
                    objectId: $oid,
                    objectKey: $okey,
                    label: $olabel,
                    attachments: $atts
                }' >> "$output_file"
        fi
    fi
}

# Export functions for parallel execution
export -f sanitize_filename download_attachment fetch_object_attachments process_object_attachments api_call get_response_status get_response_body validate_json
export BASE_API_URL JIRA_URL USERNAME PASSWORD CURL_API_OPTS MAX_ATTACHMENT_SIZE_MB ATTACHMENTS_PER_OBJECT SEQUENTIAL_ATTACHMENTS DEBUG_ATTACHMENTS FAILED_ATTACHMENTS_LOG ATTACHMENTS_OUTPUT_DIR

echo "Fetching object schemas..."
SCHEMAS_URL="$BASE_API_URL/assets/1.0/objectschema/list"
SCHEMAS_RESPONSE_FILE=$(api_call "$SCHEMAS_URL")
SCHEMAS_STATUS=$(get_response_status "$SCHEMAS_RESPONSE_FILE")

if [ "$SCHEMAS_STATUS" != "200" ]; then
    echo "ERROR: Failed to fetch schemas (HTTP $SCHEMAS_STATUS)"
    exit 1
fi

SCHEMAS_BODY=$(get_response_body "$SCHEMAS_RESPONSE_FILE")
SCHEMAS=$(echo "$SCHEMAS_BODY" | jq -c '.objectschemas[]?' 2>/dev/null)
rm -f "$SCHEMAS_RESPONSE_FILE"

SCHEMA_COUNT=$(echo "$SCHEMAS" | wc -l | tr -d ' ')
echo "Found $SCHEMA_COUNT schemas"

# Process each schema
while IFS= read -r schema; do
    if [ -z "$schema" ] || [ "$schema" = "null" ]; then
        continue
    fi

    SCHEMA_ID=$(echo "$schema" | jq -r '.id')
    SCHEMA_NAME=$(echo "$schema" | jq -r '.name')
    SCHEMA_KEY=$(echo "$schema" | jq -r '.objectSchemaKey')

    # Sanitize schema name for directory
    SCHEMA_DIR_NAME=$(echo "$SCHEMA_NAME" | sed 's/[^a-zA-Z0-9_-]/_/g')

    echo ""
    echo "Processing schema: '$SCHEMA_NAME' (ID: $SCHEMA_ID)"
    TOTAL_SCHEMAS_PROCESSED=$((TOTAL_SCHEMAS_PROCESSED + 1))

    # Fetch object types for this schema
    echo "  Fetching object types for schema '$SCHEMA_NAME'..."
    OBJECT_TYPES_URL="$BASE_API_URL/assets/1.0/objectschema/$SCHEMA_ID/objecttypes/flat"
    OBJECT_TYPES_RESPONSE_FILE=$(api_call "$OBJECT_TYPES_URL")
    OBJECT_TYPES_STATUS=$(get_response_status "$OBJECT_TYPES_RESPONSE_FILE")

    if [ "$OBJECT_TYPES_STATUS" != "200" ]; then
        echo "  ERROR: Failed to fetch object types (HTTP $OBJECT_TYPES_STATUS)"
        rm -f "$OBJECT_TYPES_RESPONSE_FILE"
        continue
    fi

    OBJECT_TYPES_BODY=$(get_response_body "$OBJECT_TYPES_RESPONSE_FILE")
    OBJECT_TYPES=$(echo "$OBJECT_TYPES_BODY" | jq -c '.[]?' 2>/dev/null)
    rm -f "$OBJECT_TYPES_RESPONSE_FILE"

    OBJECT_TYPE_COUNT=$(echo "$OBJECT_TYPES" | wc -l | tr -d ' ')
    echo "  Found $OBJECT_TYPE_COUNT object types"

    # Process each object type
    while IFS= read -r object_type; do
        if [ -z "$object_type" ] || [ "$object_type" = "null" ]; then
            continue
        fi

        OBJECT_TYPE_ID=$(echo "$object_type" | jq -r '.id')
        OBJECT_TYPE_NAME=$(echo "$object_type" | jq -r '.name')

        echo "    Processing object type: '$OBJECT_TYPE_NAME' (ID: $OBJECT_TYPE_ID)"
        TOTAL_OBJECT_TYPES_PROCESSED=$((TOTAL_OBJECT_TYPES_PROCESSED + 1))

        # Define output directory path (but don't create it yet - only create if attachments exist)
        OBJECT_TYPE_OUTPUT_DIR="$ATTACHMENTS_OUTPUT_DIR/$SCHEMA_DIR_NAME/$OBJECT_TYPE_NAME"

        # Fetch objects for this object type using AQL
        echo "      Fetching objects for object type '$OBJECT_TYPE_NAME'..."

        AQL_QUERY="objectTypeId = $OBJECT_TYPE_ID"
        ENCODED_AQL=$(printf '%s' "$AQL_QUERY" | jq -s -R -r @uri)

        PAGE=1
        TOTAL_OBJECTS_FOR_TYPE=0
        ALL_OBJECT_ATTACHMENTS=$(mktemp)

        while true; do
            OBJECTS_URL="$BASE_API_URL/assets/1.0/aql/objects?qlQuery=$ENCODED_AQL&objectSchemaId=$SCHEMA_ID&page=$PAGE&resultPerPage=$DEFAULT_PAGE_SIZE&includeAttributes=false"
            OBJECTS_RESPONSE_FILE=$(api_call "$OBJECTS_URL")
            OBJECTS_STATUS=$(get_response_status "$OBJECTS_RESPONSE_FILE")

            if [ "$OBJECTS_STATUS" != "200" ]; then
                echo "      ERROR: Failed to fetch objects (HTTP $OBJECTS_STATUS)"
                rm -f "$OBJECTS_RESPONSE_FILE"
                break
            fi

            OBJECTS_BODY=$(get_response_body "$OBJECTS_RESPONSE_FILE")

            # Extract pagination metadata
            TOTAL_FILTER_COUNT=$(echo "$OBJECTS_BODY" | jq -r '.totalFilterCount // 0' 2>/dev/null)

            OBJECTS=$(echo "$OBJECTS_BODY" | jq -c '.objectEntries[]?' 2>/dev/null)
            rm -f "$OBJECTS_RESPONSE_FILE"

            if [ -z "$OBJECTS" ]; then
                echo "      No more objects found, ending pagination"
                break
            fi

            OBJECTS_IN_PAGE=$(echo "$OBJECTS" | wc -l | tr -d ' ')
            TOTAL_OBJECTS_FOR_TYPE=$((TOTAL_OBJECTS_FOR_TYPE + OBJECTS_IN_PAGE))

            echo "      Fetched $OBJECTS_IN_PAGE objects (page $PAGE), total: $TOTAL_OBJECTS_FOR_TYPE/$TOTAL_FILTER_COUNT..."
            echo "      Processing attachments for $OBJECTS_IN_PAGE objects in parallel (workers: $PARALLEL_WORKERS)..."

            # Process each object to fetch attachments IN PARALLEL
            obj_num=0
            while IFS= read -r object; do
                if [ -z "$object" ] || [ "$object" = "null" ]; then
                    continue
                fi

                obj_num=$((obj_num + 1))
                TOTAL_OBJECTS_PROCESSED=$((TOTAL_OBJECTS_PROCESSED + 1))

                # Launch parallel worker
                process_object_attachments "$object" "$OBJECT_TYPE_OUTPUT_DIR" "$ALL_OBJECT_ATTACHMENTS" &

                # Limit number of parallel workers
                while [ $(jobs -r | wc -l) -ge "$PARALLEL_WORKERS" ]; do
                    sleep 0.1
                done

                # Show progress every 50 objects
                if [ $((obj_num % 50)) -eq 0 ]; then
                    echo "        Launched workers for $obj_num/$OBJECTS_IN_PAGE objects on page $PAGE..."
                fi
            done <<< "$OBJECTS"

            # Wait for all background jobs to complete for this page
            echo "      Waiting for all attachment workers to complete..."
            wait

            # Check if there are more pages
            if [ "$OBJECTS_IN_PAGE" -lt "$DEFAULT_PAGE_SIZE" ]; then
                echo "      Last page reached (fewer objects than page size)"
                break
            fi

            # Check if we've fetched all objects according to totalFilterCount
            if [ -n "$TOTAL_FILTER_COUNT" ] && [ "$TOTAL_FILTER_COUNT" -gt 0 ] && [ "$TOTAL_OBJECTS_FOR_TYPE" -ge "$TOTAL_FILTER_COUNT" ]; then
                echo "      All objects fetched according to totalFilterCount"
                break
            fi

            PAGE=$((PAGE + 1))

            # Safety limit to prevent infinite loops
            if [ "$PAGE" -gt 100 ]; then
                echo "      WARNING: Reached page limit (100), stopping pagination"
                break
            fi
        done

        # Save attachments for this object type (only create directory if attachments exist)
        if [ -f "$ALL_OBJECT_ATTACHMENTS" ] && [ -s "$ALL_OBJECT_ATTACHMENTS" ]; then
            # Create directory only when we have attachments to save
            mkdir -p "$OBJECT_TYPE_OUTPUT_DIR"

            OBJECT_TYPE_ATTACHMENTS_FILE="$OBJECT_TYPE_OUTPUT_DIR/attachments.json"
            jq -s \
                --arg ot_name "$OBJECT_TYPE_NAME" \
                --arg ot_id "$OBJECT_TYPE_ID" \
                --arg schema_name "$SCHEMA_NAME" \
                --arg schema_id "$SCHEMA_ID" \
                '{
                    objectTypeName: $ot_name,
                    objectTypeId: $ot_id,
                    schemaName: $schema_name,
                    schemaId: $schema_id,
                    objects: .
                }' "$ALL_OBJECT_ATTACHMENTS" > "$OBJECT_TYPE_ATTACHMENTS_FILE"

            OBJECTS_WITH_ATTACHMENTS=$(jq '.objects | length' "$OBJECT_TYPE_ATTACHMENTS_FILE" 2>/dev/null || echo "0")
            echo "      → Saved attachments for $OBJECTS_WITH_ATTACHMENTS objects to attachments.json"
        else
            echo "      ℹ️  No attachments found for this object type - skipping directory creation"
        fi

        rm -f "$ALL_OBJECT_ATTACHMENTS"

    done <<< "$OBJECT_TYPES"

done <<< "$SCHEMAS"

# Calculate script end time
SCRIPT_END_TIME=$(date '+%H:%M:%S')
SCRIPT_END_TIMESTAMP=$(date)

echo ""
echo "=========================================="
echo "ATTACHMENT EXTRACTION SUMMARY"
echo "=========================================="
echo "Start time: $SCRIPT_START_TIME"
echo "End time: $SCRIPT_END_TIME"
echo ""
echo "Statistics:"
echo "  Schemas processed: $TOTAL_SCHEMAS_PROCESSED"
echo "  Object types processed: $TOTAL_OBJECT_TYPES_PROCESSED"
echo "  Total objects scanned: $TOTAL_OBJECTS_PROCESSED"
echo "  Objects with attachments: $TOTAL_OBJECTS_WITH_ATTACHMENTS"
echo "  Total attachments found: $TOTAL_ATTACHMENTS_FOUND"
echo "  Attachments downloaded: $TOTAL_ATTACHMENTS_DOWNLOADED"
echo "  Attachment errors: $TOTAL_ATTACHMENT_ERRORS"
echo ""
echo "Output directory: $ATTACHMENTS_OUTPUT_DIR"

if [ -f "$FAILED_ATTACHMENTS_LOG" ] && [ -s "$FAILED_ATTACHMENTS_LOG" ]; then
    echo "Failed attachments log: $FAILED_ATTACHMENTS_LOG"
fi

echo ""
echo "=========================================="
echo "Script execution completed"
echo "=========================================="
