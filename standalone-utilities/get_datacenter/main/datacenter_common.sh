#!/bin/bash

# =============================================================================
# Datacenter Common Utilities
# =============================================================================
# Shared configuration and utility functions for Jira Datacenter scripts
# Source this file at the beginning of any datacenter extraction script
# =============================================================================

# --- Configuration ---
# Replace with your Jira Datacenter credentials
JIRA_URL="https://your-datacenter-instance.example.com"
USERNAME="your_username"
PASSWORD="your_password_or_api_token"

# Base settings
BASE_API_URL="$JIRA_URL/rest"
OUTPUT_DIR="datacenter_assets"
CURL_API_OPTS="-s"  # Simple options for API calls (no timeouts)

# Create output directory
mkdir -p "$OUTPUT_DIR"

# =============================================================================
# Logging Setup
# =============================================================================

# Initialize comprehensive logging - redirect ALL output to both terminal and log file
setup_logging() {
    local script_name="$1"
    LOG_FILE="$OUTPUT_DIR/${script_name}_$(date +%Y%m%d_%H%M%S).log"
    mkdir -p "$(dirname "$LOG_FILE")"

    echo "=========================================="
    echo "$script_name Started"
    echo "=========================================="
    echo "Logging all output to: $LOG_FILE"
    echo "=========================================="

    # Redirect ALL stdout and stderr to both terminal and log file
    exec > >(tee -a "$LOG_FILE")
    exec 2>&1

    # Initialize statistics tracking
    SCRIPT_START_TIME=$(date '+%H:%M:%S')
    SCRIPT_START_TIMESTAMP=$(date)

    echo "Start time: $SCRIPT_START_TIME ($SCRIPT_START_TIMESTAMP)"
    echo "Configuration:"
    echo "  JIRA_URL: $JIRA_URL"
    echo "  OUTPUT_DIR: $OUTPUT_DIR"
    echo "  LOG_FILE: $LOG_FILE"
    echo "=========================================="
}

# =============================================================================
# JSON Validation & Processing
# =============================================================================

# Function to validate JSON integrity (simplified)
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

# Function to extract objects with robust error handling
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

    # Single jq call to try all extraction methods at once
    local objects=$(echo "$json_data" | jq -c '.objectEntries // .objects // (if type == "array" then . else [] end)' 2>/dev/null)

    if [ -n "$objects" ] && [ "$objects" != "null" ]; then
        echo "$objects"
        return 0
    fi

    echo "[]"
    return 1
}

# =============================================================================
# API Call Functions
# =============================================================================

# Function to make API call with automatic retry on rate limiting (429) and server errors (503)
# This prevents data loss by retrying failed requests with exponential backoff
api_call() {
    local url="$1"
    local method="${2:-GET}"
    local output_file="${3:-$(mktemp)}"

    # Retry configuration
    local max_retries=10
    local attempt=1      # Current attempt number (starts at 1)
    local base_wait=5    # Start with 5 seconds
    local max_wait=300   # Cap at 5 minutes

    while [ $attempt -le $((max_retries + 1)) ]; do
        # Make the API call
        local response_temp=$(mktemp)
        local headers_temp=$(mktemp)

        # Capture both headers and response with status code
        curl $CURL_API_OPTS -D "$headers_temp" -w "\\n%{http_code}" -u "$USERNAME:$PASSWORD" -X "$method" "$url" > "$response_temp" 2>/dev/null
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

        # Check if we got a successful response
        if [ "$http_status" = "200" ] || [ "$http_status" = "201" ] || [ "$http_status" = "204" ]; then
            # Success! Write output and return
            {
                echo "STATUS:$http_status"
                echo "BODY_START"
                cat "$body_temp"
                echo "BODY_END"
            } > "$output_file"

            # Clean up temp files
            rm -f "$response_temp" "$body_temp" "$headers_temp"

            # Log retry success if we retried
            if [ $attempt -gt 1 ]; then
                echo "✅ SUCCESS after $((attempt - 1)) retries for URL: $url" >&2
            fi

            echo "$output_file"
            return 0
        fi

        # Handle rate limiting (429) and server errors (503, 502, 504)
        local should_retry=false
        local wait_time=$base_wait

        if [ "$http_status" = "429" ]; then
            should_retry=true

            # Try to extract Retry-After header from response
            local retry_after=$(grep -i "^Retry-After:" "$headers_temp" | cut -d' ' -f2- | tr -d '\r\n' | tr -d ' ' || echo "")

            # Check if retry_after is a number (seconds) vs HTTP-date format
            if [ -n "$retry_after" ] && [ "$retry_after" -eq "$retry_after" ] 2>/dev/null; then
                # It's a number - use server-specified retry time in seconds
                wait_time=$retry_after
                # Cap at max_wait for safety
                if [ $wait_time -gt $max_wait ]; then
                    wait_time=$max_wait
                fi
                echo "⏸️  RATE LIMITED (HTTP 429) - Server requested wait: ${wait_time}s" >&2
            else
                # Either no header or HTTP-date format (not supported) - use exponential backoff
                # Calculate: base_wait * 2^(attempt-1) (capped at max_wait)
                local exponent=$((attempt - 1))
                wait_time=$((base_wait * (1 << exponent)))
                if [ $wait_time -gt $max_wait ]; then
                    wait_time=$max_wait
                fi
                echo "⏸️  RATE LIMITED (HTTP 429) - Attempt $attempt/$((max_retries + 1)) - Waiting ${wait_time}s before retry" >&2
            fi

        elif [ "$http_status" = "503" ] || [ "$http_status" = "502" ] || [ "$http_status" = "504" ]; then
            should_retry=true
            # Server error - use exponential backoff
            local exponent=$((attempt - 1))
            wait_time=$((base_wait * (1 << exponent)))
            if [ $wait_time -gt $max_wait ]; then
                wait_time=$max_wait
            fi
            echo "⚠️  SERVER ERROR (HTTP $http_status) - Attempt $attempt/$((max_retries + 1)) - Waiting ${wait_time}s before retry" >&2

        elif [ "$http_status" = "000" ]; then
            should_retry=true
            # Connection error - use exponential backoff
            local exponent=$((attempt - 1))
            wait_time=$((base_wait * (1 << exponent)))
            if [ $wait_time -gt $max_wait ]; then
                wait_time=$max_wait
            fi
            echo "⚠️  CONNECTION FAILED (HTTP 000) - Attempt $attempt/$((max_retries + 1)) - Waiting ${wait_time}s before retry" >&2
        fi

        # If we should retry and haven't exceeded max attempts
        if [ "$should_retry" = "true" ] && [ $attempt -lt $((max_retries + 1)) ]; then
            # Wait before retrying (with progress indicator)
            echo "   ⏳ Waiting ${wait_time}s... (Next attempt: $((attempt + 1)) of $((max_retries + 1)))" >&2
            sleep "$wait_time"

            # Increment attempt counter
            attempt=$((attempt + 1))

            # Clean up temp files and retry
            rm -f "$response_temp" "$body_temp" "$headers_temp"
            continue
        else
            # Either not retryable or max retries exceeded
            if [ "$should_retry" = "true" ]; then
                echo "❌ FATAL: Max retries ($max_retries) exceeded for URL: $url" >&2
                echo "   Final HTTP status: $http_status" >&2
            else
                # Non-retryable error (4xx client errors except 429)
                echo "ERROR: HTTP $http_status for URL: $url (not retrying client error)" >&2
            fi

            # Write error response to output file
            {
                echo "STATUS:$http_status"
                echo "BODY_START"
                cat "$body_temp"
                echo "BODY_END"
            } > "$output_file"

            # Clean up temp files
            rm -f "$response_temp" "$body_temp" "$headers_temp"

            echo "$output_file"
            return 1
        fi
    done

    # Should never reach here, but just in case
    echo "❌ FATAL: Unexpected error in retry loop for URL: $url" >&2
    echo "$output_file"
    return 1
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

# Helper function to extract body from response file directly to a temp file
get_response_body_to_file() {
    local response_file="$1"
    local output_file="${2:-$(mktemp)}"

    # Ensure the response file exists
    if [ ! -f "$response_file" ]; then
        echo "ERROR: Response file $response_file does not exist" >&2
        echo "" > "$output_file"
        echo "$output_file"
        return 1
    fi

    # Extract body content
    awk '/^BODY_START/{flag=1;next}/^BODY_END/{flag=0}flag' "$response_file" > "$output_file"

    # Verify the output file was created and has content
    if [ ! -f "$output_file" ]; then
        echo "ERROR: Failed to create output file $output_file" >&2
        echo "" > "$output_file"
    elif [ ! -s "$output_file" ]; then
        echo "WARNING: Output file $output_file is empty" >&2
        cat "$response_file" > "$output_file" 2>/dev/null || echo "" > "$output_file"
    fi

    echo "$output_file"
}

# =============================================================================
# Exports for compatibility
# =============================================================================

# Export all functions so they're available to child processes
export -f validate_json extract_objects_robust api_call get_response_status get_response_body get_response_body_to_file

# Export variables
export JIRA_URL USERNAME PASSWORD BASE_API_URL OUTPUT_DIR CURL_API_OPTS LOG_FILE

echo "Common utilities loaded successfully"
