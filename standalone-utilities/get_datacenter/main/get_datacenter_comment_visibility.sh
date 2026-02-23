#!/bin/bash

# =============================================================================
# Get Datacenter Comment Visibility
# =============================================================================
# Extracts comment visibility data from Jira Datacenter for all issues.
# Outputs JSON file to be consumed by Node.js script for Cloud sync.
#
# Uses parallel workers for speed (same pattern as get_datacenter_attachments.sh)
#
# Output format (optimized for Cloud sync):
# {
#   "extractedAt": "2024-01-15T10:30:00Z",
#   "totalIssues": 1000,
#   "totalComments": 5000,
#   "commentsWithVisibility": 500,
#   "comments": [
#     {
#       "issueKey": "PROJ-123",
#       "commentId": "10001",
#       "created": "2024-01-01T10:00:00.000+0000",
#       "visibility": {"type": "role", "value": "Administrators"}
#     }
#   ]
# }
# =============================================================================

set -euo pipefail

# =============================================================================
# Source Datacenter Common Utilities
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/datacenter_common.sh"

# =============================================================================
# Script Settings
# =============================================================================
SCRIPT_NAME="get_datacenter_comment_visibility"
DC_MAX_RESULTS="${DC_MAX_RESULTS:-1000}"
COMMENT_MAX_RESULTS="${COMMENT_MAX_RESULTS:-100}"
PARALLEL_WORKERS="${PARALLEL_WORKERS:-10}"
JSM_ONLY="${JSM_ONLY:-true}"  # Default to JSM projects only
EXCLUDE_PROJECTS="${EXCLUDE_PROJECTS:-}"  # Comma-separated list of project keys to exclude (e.g., "PROJ1,PROJ2")

# Output files
VISIBILITY_OUTPUT_DIR="${OUTPUT_DIR}/comment_visibility"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_FILE="${VISIBILITY_OUTPUT_DIR}/dc_comment_visibility_${TIMESTAMP}.json"
TEMP_DIR="${VISIBILITY_OUTPUT_DIR}/.temp_${TIMESTAMP}"
PROGRESS_FILE="${VISIBILITY_OUTPUT_DIR}/progress_${TIMESTAMP}.txt"

# =============================================================================
# Initialize
# =============================================================================
mkdir -p "$VISIBILITY_OUTPUT_DIR"
mkdir -p "$TEMP_DIR"

# Setup logging from datacenter_common.sh
setup_logging "$SCRIPT_NAME"

# =============================================================================
# Build JQL Query
# =============================================================================
if [ -n "${JQL_QUERY:-}" ]; then
    # User provided custom JQL - use it directly
    echo "Using custom JQL query provided by user"
else
    if [ "$JSM_ONLY" = "true" ]; then
        # Auto-detect JSM projects
        # Note: The /rest/api/2/project endpoint automatically excludes archived projects
        # (archived projects are not returned by this API at all)
        echo "Fetching all projects to identify JSM (service_desk) projects..."
        echo "(Note: Archived projects are automatically excluded by the API)"

        jsm_response_file=$(api_call "${BASE_API_URL}/api/2/project" "GET")

        if [ $? -ne 0 ]; then
            echo "ERROR: Failed to fetch projects"
            rm -f "$jsm_response_file"
            exit 1
        fi

        jsm_body=$(get_response_body "$jsm_response_file")
        rm -f "$jsm_response_file"

        # Debug: Show total projects returned
        total_projects=$(echo "$jsm_body" | jq 'length')
        echo "Total projects returned by API: $total_projects"

        # Debug: Show project types breakdown
        echo "Projects by type:"
        echo "$jsm_body" | jq -r 'group_by(.projectTypeKey) | .[] | "  \(.[0].projectTypeKey): \(length)"'

        # Filter for service_desk projects only
        # The API already excludes archived projects, so we just filter by projectTypeKey
        JSM_PROJECT_KEYS=$(echo "$jsm_body" | jq -r '.[] | select(.projectTypeKey == "service_desk") | .key')

        if [ -z "$JSM_PROJECT_KEYS" ]; then
            echo "ERROR: No JSM (service_desk) projects found and JSM_ONLY=true"
            echo "Set JSM_ONLY=false to process all projects, or provide custom JQL_QUERY"
            exit 1
        fi

        # Apply manual exclusions if specified
        if [ -n "$EXCLUDE_PROJECTS" ]; then
            echo ""
            echo "Applying manual project exclusions: $EXCLUDE_PROJECTS"
            # Convert comma-separated exclusions to newline-separated for filtering
            EXCLUDE_LIST=$(echo "$EXCLUDE_PROJECTS" | tr ',' '\n')
            # Filter out excluded projects
            FILTERED_KEYS=""
            while IFS= read -r pkey; do
                if [ -n "$pkey" ]; then
                    # Check if this key is in the exclusion list
                    if ! echo "$EXCLUDE_LIST" | grep -qx "$pkey"; then
                        if [ -z "$FILTERED_KEYS" ]; then
                            FILTERED_KEYS="$pkey"
                        else
                            FILTERED_KEYS="$FILTERED_KEYS"$'\n'"$pkey"
                        fi
                    else
                        echo "  Excluding: $pkey"
                    fi
                fi
            done <<< "$JSM_PROJECT_KEYS"
            JSM_PROJECT_KEYS="$FILTERED_KEYS"
        fi

        if [ -z "$JSM_PROJECT_KEYS" ]; then
            echo "ERROR: No JSM projects remaining after exclusions"
            exit 1
        fi

        # Count and display found projects
        jsm_count=$(echo "$JSM_PROJECT_KEYS" | wc -l | tr -d ' ')
        echo ""
        echo "Found $jsm_count JSM (service_desk) project(s) to process:"
        echo "$JSM_PROJECT_KEYS" | while read -r pkey; do
            echo "  - $pkey"
        done

        # Build JQL: project in (KEY1, KEY2, KEY3) AND has comments
        # The comment filter trick ensures we only get issues with comments
        PROJECT_LIST=$(echo "$JSM_PROJECT_KEYS" | tr '\n' ',' | sed 's/,$//')
        JQL_QUERY="project in ($PROJECT_LIST) AND (comment ~ \"anything*\" OR comment !~ \"anything*\") ORDER BY key ASC"

        echo ""
        echo "Auto-generated JQL for JSM projects only:"
        echo "  $JQL_QUERY"
    else
        # Process all projects
        JQL_QUERY="project IS NOT EMPTY ORDER BY key ASC"
        echo "Processing ALL projects (JSM_ONLY=false)"
    fi
fi

echo ""
echo "=========================================="
echo "Datacenter Comment Visibility Extractor"
echo "=========================================="
echo "JSM Only: $JSM_ONLY"
if [ -n "$EXCLUDE_PROJECTS" ]; then
echo "Excluded Projects: $EXCLUDE_PROJECTS"
fi
echo "JQL: $JQL_QUERY"
echo "Parallel Workers: $PARALLEL_WORKERS"
echo "Output: $OUTPUT_FILE"
echo "=========================================="

# =============================================================================
# Process Single Issue - Extract Comments with Visibility
# =============================================================================
process_issue_comments() {
    local issue_key="$1"
    local output_file="$2"

    local start_at=0
    local issue_comments_file=$(mktemp)
    echo "[]" > "$issue_comments_file"

    while true; do
        local endpoint="/api/2/issue/${issue_key}/comment?startAt=${start_at}&maxResults=${COMMENT_MAX_RESULTS}&expand=properties"
        local response_file=$(api_call "${BASE_API_URL}${endpoint}" "GET")

        if [ $? -ne 0 ]; then
            rm -f "$response_file" "$issue_comments_file"
            return 1
        fi

        local body=$(get_response_body "$response_file")
        rm -f "$response_file"

        if [ -z "$body" ] || [ "$body" = "null" ]; then
            break
        fi

        local total=$(echo "$body" | jq -r '.total // 0')
        local comments_json=$(echo "$body" | jq -c --arg key "$issue_key" '
            .comments // [] | map(
                {
                    issueKey: $key,
                    commentId: .id,
                    created: .created,
                    internal: (
                        # sd.public.comment with internal:true = INTERNAL (true)
                        # sd.allow.public.comment with allow:true = PUBLIC (false)
                        if (.properties // []) | any(.key == "sd.public.comment" and .value.internal == true) then
                            true
                        else
                            false
                        end
                    )
                }
            )
        ')

        local count=$(echo "$comments_json" | jq 'length')

        if [ "$count" -eq 0 ]; then
            break
        fi

        # Merge comments
        local current=$(cat "$issue_comments_file")
        echo "$current" "$comments_json" | jq -s 'add' > "$issue_comments_file"

        start_at=$((start_at + COMMENT_MAX_RESULTS))

        if [ $start_at -ge $total ]; then
            break
        fi
    done

    # Output comments to result file (one JSON array per issue)
    cat "$issue_comments_file" >> "$output_file"
    echo "" >> "$output_file"  # Newline separator

    local final_count=$(cat "$issue_comments_file" | jq 'length')
    rm -f "$issue_comments_file"

    echo "$final_count"
}

# Export for parallel execution
export -f process_issue_comments
export BASE_API_URL USERNAME PASSWORD COMMENT_MAX_RESULTS
export -f api_call get_response_body get_response_status

# =============================================================================
# Main Processing Loop
# =============================================================================
echo ""
echo "Starting issue search..."

TOTAL_ISSUES=0
TOTAL_COMMENTS=0
TOTAL_WITH_VISIBILITY=0
START_AT=0

# Create temp file for collecting all comments
ALL_COMMENTS_FILE="$TEMP_DIR/all_comments.jsonl"
> "$ALL_COMMENTS_FILE"

while true; do
    # Fetch batch of issues
    encoded_jql=$(printf '%s' "$JQL_QUERY" | jq -sRr @uri)
    endpoint="/api/2/search?jql=${encoded_jql}&startAt=${START_AT}&maxResults=${DC_MAX_RESULTS}&fields=key"

    response_file=$(api_call "${BASE_API_URL}${endpoint}" "GET")

    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to fetch issues at startAt=$START_AT"
        rm -f "$response_file"
        exit 1
    fi

    body=$(get_response_body "$response_file")
    rm -f "$response_file"

    total=$(echo "$body" | jq -r '.total // 0')
    issues=$(echo "$body" | jq -r '.issues[].key' 2>/dev/null || echo "")
    batch_count=$(echo "$issues" | grep -c . || echo "0")

    if [ "$batch_count" -eq 0 ]; then
        break
    fi

    TOTAL_ISSUES=$((TOTAL_ISSUES + batch_count))
    echo "Fetched issues $START_AT to $((START_AT + batch_count)) of $total"

    # Process issues in parallel
    echo "Processing $batch_count issues with $PARALLEL_WORKERS parallel workers..."

    batch_idx=0
    while IFS= read -r issue_key; do
        if [ -z "$issue_key" ]; then
            continue
        fi

        batch_idx=$((batch_idx + 1))

        # Create output file for this issue
        issue_output="$TEMP_DIR/issue_${issue_key}.json"

        # Launch worker in background
        (
            comment_count=$(process_issue_comments "$issue_key" "$issue_output" 2>/dev/null || echo "0")
            echo "$issue_key:$comment_count" >> "$TEMP_DIR/completed.txt"
        ) &

        # Limit parallel workers
        while [ $(jobs -r | wc -l) -ge "$PARALLEL_WORKERS" ]; do
            sleep 0.1
        done

        # Progress every 100 issues
        if [ $((batch_idx % 100)) -eq 0 ]; then
            echo "  Launched workers for $batch_idx/$batch_count issues..."
        fi

    done <<< "$issues"

    # Wait for all workers in this batch
    echo "  Waiting for batch to complete..."
    wait

    # Update progress
    echo "Processed $TOTAL_ISSUES / $total issues at $(date)" > "$PROGRESS_FILE"

    START_AT=$((START_AT + DC_MAX_RESULTS))

    if [ $START_AT -ge $total ]; then
        break
    fi
done

echo ""
echo "All issues processed. Combining results..."

# =============================================================================
# Combine Results into Final JSON
# =============================================================================

# Collect all issue results
echo "Merging comment data from all issues..."

# Combine all issue JSON files into one array
ALL_COMMENTS="$TEMP_DIR/combined_comments.json"
echo "[" > "$ALL_COMMENTS"

first=true
for issue_file in "$TEMP_DIR"/issue_*.json; do
    if [ -f "$issue_file" ]; then
        # Read the JSON array from this issue file
        content=$(cat "$issue_file" 2>/dev/null || echo "[]")

        # Skip empty arrays
        if [ "$content" = "[]" ] || [ -z "$content" ]; then
            continue
        fi

        # Add comma separator after first entry
        if [ "$first" = true ]; then
            first=false
        else
            echo "," >> "$ALL_COMMENTS"
        fi

        # Extract individual comments and add to combined file (strip outer brackets)
        echo "$content" | jq -c '.[]' | while read -r comment; do
            if [ "$first" = true ]; then
                first=false
                echo "$comment" >> "$ALL_COMMENTS"
            else
                echo ",$comment" >> "$ALL_COMMENTS"
            fi
        done
    fi
done

echo "]" >> "$ALL_COMMENTS"

# Calculate statistics and create final output
echo "Generating final output..."

jq -n \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson totalIssues "$TOTAL_ISSUES" \
    --slurpfile comments "$ALL_COMMENTS" '
{
    extractedAt: $timestamp,
    dcUrl: env.JIRA_URL,
    jqlQuery: env.JQL_QUERY,
    totalIssues: $totalIssues,
    totalComments: ($comments[0] | length),
    commentsInternal: ($comments[0] | map(select(.internal == true)) | length),
    commentsPublic: ($comments[0] | map(select(.internal == false)) | length),
    comments: $comments[0]
}
' > "$OUTPUT_FILE"

# Get final stats
FINAL_STATS=$(jq '{totalComments, commentsInternal, commentsPublic}' "$OUTPUT_FILE")

echo ""
echo "=========================================="
echo "EXTRACTION COMPLETE"
echo "=========================================="
echo "Total Issues Processed: $TOTAL_ISSUES"
echo "$FINAL_STATS" | jq -r 'to_entries | .[] | "  \(.key): \(.value)"'
echo "=========================================="
echo "Output File: $OUTPUT_FILE"
echo "File Size: $(du -h "$OUTPUT_FILE" | cut -f1)"
echo "=========================================="

# Cleanup temp directory
rm -rf "$TEMP_DIR"

echo ""
echo "Done! Use the Node.js script to sync this data to Cloud:"
echo "  node sync_comment_visibility_to_cloud.js --input $OUTPUT_FILE"
