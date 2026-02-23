#!/bin/bash

# =============================================================================
# Jira Datacenter Ticket-to-Asset Association Extractor
# =============================================================================
# This script extracts all ticket-to-asset associations from Jira custom fields
# It creates one JSON file per custom field containing all tickets that reference assets
# =============================================================================

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/datacenter_common.sh"

# Initialize logging
setup_logging "datacenter_ticket_associations"

echo "=========================================="
echo "Extracting ticket-to-asset associations..."
echo "=========================================="

# Step 1: Fetch ALL custom fields from Jira (single request with maxResults=600)
echo "Step 1: Fetching all custom fields..."
ALL_FIELDS_FILE=$(mktemp)

cf_url="$JIRA_URL/rest/api/2/customFields?maxResults=600"
echo "API: Fetching custom fields from: $cf_url"
cf_response_file=$(api_call "$cf_url")
cf_status=$(get_response_status "$cf_response_file")

if [ "$cf_status" != "200" ]; then
    echo "ERROR: Failed to fetch custom fields (HTTP $cf_status) from $cf_url"
    rm -f "$cf_response_file"
    exit 1
fi

cf_body_file=$(get_response_body_to_file "$cf_response_file")

# Extract custom fields from response
all_fields=$(jq -r '.values[]? | "\(.id)|\(.name)|\(.type)"' "$cf_body_file" 2>/dev/null)

# If '.values[]' gives no result, try direct array response
if [ -z "$all_fields" ]; then
    all_fields=$(jq -r '.[]? | "\(.id)|\(.name)|\(.type)"' "$cf_body_file" 2>/dev/null)
fi

if [ -n "$all_fields" ]; then
    echo "$all_fields" > "$ALL_FIELDS_FILE"
    cf_total_fetched=$(echo "$all_fields" | wc -l | tr -d ' ')
    echo "INFO: Fetched $cf_total_fetched custom fields"
else
    echo "ERROR: No custom fields found in response"
    rm -f "$cf_body_file" "$cf_response_file"
    exit 1
fi

rm -f "$cf_body_file" "$cf_response_file"

echo "  Total custom fields fetched: $cf_total_fetched"

# Now filter for ONLY CMDB/Asset fields
echo "  Filtering for CMDB/Asset fields..."
CMDB_FIELDS_FILE=$(mktemp)

while IFS='|' read -r field_id field_name field_type; do
    # Filter by type - keep only fields with "insight", "assets", or "cmdb" in the type
    if echo "$field_type" | grep -iE "insight|assets|cmdb" > /dev/null 2>&1; then
        echo "$field_id|$field_name|$field_type" >> "$CMDB_FIELDS_FILE"
    fi
done < "$ALL_FIELDS_FILE"

rm -f "$ALL_FIELDS_FILE"

cmdb_fields_count=$(wc -l < "$CMDB_FIELDS_FILE" 2>/dev/null || echo "0")
echo "  Filtered to $cmdb_fields_count CMDB/Asset fields"

# Step 2: For each custom field, fetch all tickets and save to separate files
echo ""
echo "Step 2: Fetching tickets for each custom field..."

# Create connectedTickets directory
CONNECTED_TICKETS_DIR="$OUTPUT_DIR/connectedTickets"
mkdir -p "$CONNECTED_TICKETS_DIR"
echo "  Created directory: $CONNECTED_TICKETS_DIR"

field_num=0
total_fields=$(wc -l < "$CMDB_FIELDS_FILE" 2>/dev/null || echo "0")
total_field_files_created=0

while IFS='|' read -r field_id field_name _; do
    if [ -z "$field_id" ]; then
        continue
    fi

    field_num=$((field_num + 1))

    # Use JQL to find all tickets where this custom field is not empty
    # Extract field number from customfield_12345 -> 12345
    field_number=$(echo "$field_id" | sed 's/customfield_//')
    jql_query="cf[${field_number}] is not EMPTY"
    encoded_jql=$(printf %s "$jql_query" | jq -s -R -r @uri)

    echo -n "  [$field_num/$total_fields] $field_name ($field_id)... "

    # Create temp file for this field's relationships
    FIELD_RELATIONSHIPS_TEMP=$(mktemp)

    jql_start=0
    jql_max=100
    field_ticket_count=0

    while true; do
        search_url="$JIRA_URL/rest/api/2/search?jql=$encoded_jql&startAt=$jql_start&maxResults=$jql_max&fields=$field_id,key,id"
        search_response_file=$(api_call "$search_url")
        search_status=$(get_response_status "$search_response_file")

        if [ "$search_status" != "200" ]; then
            echo "DEBUG: Field $field_id returned HTTP $search_status (might be unused or restricted)"
            rm -f "$search_response_file"
            break
        fi

        search_body_file=$(get_response_body_to_file "$search_response_file")

        # Get pagination info from API response
        total_results=$(jq -r '.total // 0' "$search_body_file" 2>/dev/null)
        current_start=$(jq -r '.startAt // 0' "$search_body_file" 2>/dev/null)
        current_max=$(jq -r '.maxResults // 0' "$search_body_file" 2>/dev/null)
        issues_in_page=$(jq -r '.issues | length' "$search_body_file" 2>/dev/null)

        # Extract tickets and parse field values for asset references
        page_tickets=$(jq -c --arg fid "$field_id" --arg fname "$field_name" '
            .issues[]? |
            {
                key: .key,
                id: .id,
                fieldId: $fid,
                fieldName: $fname,
                fieldValue: .fields[$fid]
            } |
            select(.fieldValue != null)
        ' "$search_body_file" 2>/dev/null)

        if [ -n "$page_tickets" ]; then
            # Store each ticket with its field value
            echo "$page_tickets" | while IFS= read -r ticket; do
                ticket_key=$(echo "$ticket" | jq -r '.key')
                ticket_id=$(echo "$ticket" | jq -r '.id')
                field_value=$(echo "$ticket" | jq -c '.fieldValue')

                # Store ticket with field value (field metadata will be at file level)
                if [ -n "$ticket_key" ] && [ "$ticket_key" != "null" ]; then
                    jq -n \
                        --arg tkey "$ticket_key" \
                        --arg tid "$ticket_id" \
                        --argjson fval "$field_value" \
                        '{
                            ticket: {
                                key: $tkey,
                                id: $tid,
                                fieldValue: $fval
                            }
                        }' >> "$FIELD_RELATIONSHIPS_TEMP"
                fi
            done

            page_count=$(echo "$page_tickets" | wc -l | tr -d ' ')
            field_ticket_count=$((field_ticket_count + page_count))
        fi

        rm -f "$search_body_file" "$search_response_file"

        # Check pagination - stop if we got 0 issues or if we've fetched everything
        if [ "${issues_in_page:-0}" -eq 0 ]; then
            echo "DEBUG: No more issues in page, stopping pagination"
            break
        fi

        # Calculate how many we've fetched so far
        fetched_so_far=$((jql_start + issues_in_page))

        # If we've fetched all available results, stop
        if [ "$fetched_so_far" -ge "$total_results" ]; then
            echo "DEBUG: Fetched all $total_results results for field $field_id"
            break
        fi

        # Move to next page
        jql_start=$((jql_start + jql_max))

        # Progress indicator for large datasets
        if [ "$total_results" -gt 1000 ]; then
            echo "    Progress: $fetched_so_far / $total_results tickets fetched..."
        fi

        # Safety limit per field
        if [ "$jql_start" -gt 500000 ]; then
            echo "WARNING: Reached ticket pagination limit for field $field_id (fetched $fetched_so_far of $total_results)"
            break
        fi
    done

    if [ "$field_ticket_count" -gt 0 ]; then
        echo "found $field_ticket_count ticket(s)"
    else
        echo "no tickets"
    fi

    # Save this field's relationships to a file
    if [ -f "$FIELD_RELATIONSHIPS_TEMP" ] && [ -s "$FIELD_RELATIONSHIPS_TEMP" ]; then
        # Save relationships with field metadata at top level
        FIELD_OUTPUT_FILE="$CONNECTED_TICKETS_DIR/${field_id}.json"
        jq -s --arg fid "$field_id" --arg fname "$field_name" \
            '{
                fieldId: $fid,
                fieldName: $fname,
                tickets: map(.ticket)
            }' \
            "$FIELD_RELATIONSHIPS_TEMP" > "$FIELD_OUTPUT_FILE"

        tickets_count=$(jq '.tickets | length' "$FIELD_OUTPUT_FILE" 2>/dev/null || echo "0")
        total_field_files_created=$((total_field_files_created + 1))

        echo "  → Saved ${tickets_count} tickets to ${field_id}.json"
        rm -f "$FIELD_RELATIONSHIPS_TEMP"
    else
        rm -f "$FIELD_RELATIONSHIPS_TEMP"
    fi

done < "$CMDB_FIELDS_FILE"

rm -f "$CMDB_FIELDS_FILE"

# Calculate script end time
SCRIPT_END_TIME=$(date '+%H:%M:%S')
SCRIPT_END_TIMESTAMP=$(date)

# Summary
echo ""
echo "=========================================="
echo "Ticket Association Extraction Complete!"
echo "=========================================="
echo "Start time: $SCRIPT_START_TIME"
echo "End time: $SCRIPT_END_TIME"
echo "Completed at: $SCRIPT_END_TIMESTAMP"
echo ""
echo "Summary:"
echo "  Total custom fields checked: $cf_total_fetched"
echo "  CMDB/Asset fields found: $cmdb_fields_count"
echo "  Files created: $total_field_files_created"
echo "  Output directory: $CONNECTED_TICKETS_DIR"
echo ""
echo "=========================================="
echo "Script execution completed"
echo "=========================================="
