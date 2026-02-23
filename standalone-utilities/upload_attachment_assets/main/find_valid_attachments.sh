#!/bin/bash

# Script to find objects with valid attachments in the current Jira system
# This helps identify objects that actually have downloadable attachments

echo "=========================================="
echo "FIND OBJECTS WITH VALID ATTACHMENTS"
echo "=========================================="
echo ""

# Credentials
USERNAME="your_username"
PASSWORD="your_password_or_api_token"
JIRA_URL="https://your-datacenter-instance.example.com"
BASE_API_URL="$JIRA_URL/rest"

# Test a range of object IDs to find ones with attachments
echo "Scanning objects for valid attachments..."
echo "This will test multiple object IDs to find ones with current attachments"
echo ""

# Array of object IDs to test - from your extracted data
OBJECT_IDS=(
    "55431"  # AM-55431
    "17863"  # AM-17863 
    "60920"  # AM-60920
    "54537"  # AM-54537
    "17899"  # Your original test
    "55432"  # Try next ID
    "55433"
    "55434"
    "55435"
    "17864"
    "17865"
    "60921"
    "60922"
)

# You can also specify a range to scan
if [ "$1" = "scan" ]; then
    START_ID="${2:-55430}"
    END_ID="${3:-55440}"
    echo "Scanning range: $START_ID to $END_ID"
    OBJECT_IDS=()
    for ((i=START_ID; i<=END_ID; i++)); do
        OBJECT_IDS+=("$i")
    done
fi

FOUND_COUNT=0
VALID_OBJECTS=()

for OBJECT_ID in "${OBJECT_IDS[@]}"; do
    echo -n "Testing object $OBJECT_ID... "
    
    # Call the API
    RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
         -u "$USERNAME:$PASSWORD" \
         -H "Accept: application/json" \
         "$BASE_API_URL/assets/1.0/attachments/object/$OBJECT_ID" 2>/dev/null)
    
    HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)
    JSON_BODY=$(echo "$RESPONSE" | grep -v "HTTP_CODE:")
    
    # Check if we got a valid response
    if [ "$HTTP_CODE" = "200" ]; then
        # Check if response has error messages
        HAS_ERROR=$(echo "$JSON_BODY" | jq 'has("errorMessages")' 2>/dev/null || echo "false")
        
        if [ "$HAS_ERROR" = "false" ]; then
            # Check attachment count
            COUNT=$(echo "$JSON_BODY" | jq 'length' 2>/dev/null || echo "0")
            
            if [ "$COUNT" -gt 0 ] && [ "$COUNT" != "null" ]; then
                echo "✅ Found $COUNT attachment(s)!"
                FOUND_COUNT=$((FOUND_COUNT + 1))
                
                # Get attachment details
                ATTACHMENTS=$(echo "$JSON_BODY" | jq -r '.[] | "     - \(.filename) (ID: \(.id), Size: \(.filesize))"' 2>/dev/null)
                echo "$ATTACHMENTS"
                
                VALID_OBJECTS+=("$OBJECT_ID")
            else
                echo "No attachments"
            fi
        else
            ERROR_MSG=$(echo "$JSON_BODY" | jq -r '.errorMessages[0]' 2>/dev/null)
            echo "Error: $ERROR_MSG"
        fi
    elif [ "$HTTP_CODE" = "404" ]; then
        echo "Not found"
    elif [ "$HTTP_CODE" = "000" ]; then
        echo "Connection failed - check network access!"
        break
    else
        echo "HTTP $HTTP_CODE"
    fi
done

echo ""
echo "=========================================="
echo "SUMMARY"
echo "=========================================="
echo "Found $FOUND_COUNT object(s) with valid attachments:"
for obj_id in "${VALID_OBJECTS[@]}"; do
    echo "  - Object ID: $obj_id"
done

if [ $FOUND_COUNT -gt 0 ]; then
    echo ""
    echo "You can test with any of these object IDs:"
    echo "  ./test_single_attachment.sh ${VALID_OBJECTS[0]}"
else
    echo ""
    echo "No objects with valid attachments found in the tested range."
    echo "The attachments in your extracted data appear to be stale."
    echo ""
    echo "This likely means:"
    echo "1. Attachments were deleted after your data extraction"
    echo "2. The object IDs have changed"
    echo "3. You need to re-run the extraction to get current data"
fi

echo ""
echo "To scan a custom range, use:"
echo "  ./find_valid_attachments.sh scan START_ID END_ID"
echo "  Example: ./find_valid_attachments.sh scan 55430 55450"
