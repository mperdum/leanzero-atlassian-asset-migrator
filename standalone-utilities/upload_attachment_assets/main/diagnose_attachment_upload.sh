#!/bin/bash

################################################################################
# Attachment Upload Diagnostic Script
#
# This script runs all diagnostic tests to identify why attachment uploads
# are failing with "TCS 404" errors.
#
# Usage: ./diagnose_attachment_upload.sh
################################################################################

set -e  # Exit on error

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DIAGNOSTIC_LOG="$LOG_DIR/diagnostic_$TIMESTAMP.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

################################################################################
# Helper Functions
################################################################################

print_header() {
    echo ""
    echo "========================================"
    echo "$1"
    echo "========================================"
    echo ""
}

print_section() {
    echo ""
    echo "--- $1 ---"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

################################################################################
# Pre-flight Checks
################################################################################

check_node() {
    print_section "Checking Node.js Installation"

    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed"
        print_info "Please install Node.js from https://nodejs.org/"
        exit 1
    fi

    NODE_VERSION=$(node --version)
    print_success "Node.js is installed: $NODE_VERSION"
}

check_scripts_exist() {
    print_section "Checking Diagnostic Scripts"

    local config_check="$SCRIPT_DIR/check_config.js"
    local endpoint_test="$SCRIPT_DIR/test_attachment_endpoint.js"

    if [ ! -f "$config_check" ]; then
        print_error "Configuration check script not found: $config_check"
        exit 1
    fi

    if [ ! -f "$endpoint_test" ]; then
        print_error "Endpoint test script not found: $endpoint_test"
        exit 1
    fi

    print_success "All diagnostic scripts found"
}

create_log_dir() {
    if [ ! -d "$LOG_DIR" ]; then
        mkdir -p "$LOG_DIR"
        print_success "Created log directory: $LOG_DIR"
    fi
}

################################################################################
# Main Diagnostic Steps
################################################################################

run_configuration_check() {
    print_header "STEP 1: Configuration Check"
    print_info "Running check_config.js..."
    echo ""

    cd "$SCRIPT_DIR"
    if node check_config.js 2>&1 | tee -a "$DIAGNOSTIC_LOG"; then
        print_success "Configuration check completed"
        return 0
    else
        print_error "Configuration check failed"
        return 1
    fi
}

run_endpoint_test() {
    print_header "STEP 2: Attachment Endpoint Test"
    print_info "Running test_attachment_endpoint.js..."
    echo ""

    cd "$SCRIPT_DIR"
    if node test_attachment_endpoint.js 2>&1 | tee -a "$DIAGNOSTIC_LOG"; then
        print_success "Endpoint test completed"
        return 0
    else
        print_error "Endpoint test failed"
        return 1
    fi
}

check_mapping_file() {
    print_header "STEP 3: Verify Mapping File"

    local mapping_file="$SCRIPT_DIR/../../../asset-migration-script/logs/created_objects_mapping.json"

    if [ ! -f "$mapping_file" ]; then
        print_error "Mapping file not found: $mapping_file"
        print_info "Please run the main migration script first"
        return 1
    fi

    local object_count=$(grep -c "\"cloudId\":" "$mapping_file" || echo "0")
    print_success "Mapping file exists with $object_count object mappings"

    # Check that mapping has valid entries
    if [ "$object_count" -gt 0 ]; then
        print_success "Mapping file contains valid object entries"
    else
        print_warning "No object mappings found in mapping file"
    fi

    return 0
}

check_datacenter_assets() {
    print_header "STEP 4: Verify Datacenter Assets"

    local dc_path="$SCRIPT_DIR/../../../datacenter_assets"

    if [ ! -d "$dc_path" ]; then
        print_error "Datacenter assets directory not found: $dc_path"
        return 1
    fi

    print_success "Datacenter assets directory exists"

    # Check for attachments
    local attachment_count=$(find "$dc_path" -type f -name "*.pdf" -o -name "*.doc*" -o -name "*.msg" 2>/dev/null | wc -l | tr -d ' ')

    if [ "$attachment_count" -gt 0 ]; then
        print_success "Found $attachment_count potential attachment files"
    else
        print_warning "No attachment files found"
    fi

    return 0
}

analyze_results() {
    print_header "DIAGNOSIS SUMMARY"

    echo ""
    echo "Check the diagnostic log file for detailed results:"
    echo "  $DIAGNOSTIC_LOG"
    echo ""

    print_section "Common Issues and Solutions"

    echo ""
    echo "If all checks pass but you still get 'TCS 404' errors:"
    echo "  1. The attachment endpoint may not be available for your workspace"
    echo "  2. Atlassian may have changed or deprecated the endpoint"
    echo "  3. Your workspace/plan may not support attachment uploads"
    echo ""
    echo "Next steps:"
    echo "  1. Review the diagnostic log: cat $DIAGNOSTIC_LOG"
    echo "  2. Check ATTACHMENT_UPLOAD_DEBUG.md for detailed solutions"
    echo "  3. Try manually uploading an attachment through Jira Cloud UI"
    echo "  4. Contact Atlassian Support about attachment API availability"
    echo ""

    print_section "Quick Commands"

    echo ""
    echo "View diagnostic log:"
    echo "  cat $DIAGNOSTIC_LOG"
    echo ""
    echo "View recent logs:"
    echo "  ls -lt $LOG_DIR/"
    echo ""
    echo "Run upload script (if diagnostics pass):"
    echo "  cd $SCRIPT_DIR"
    echo "  node upload_attachments_to_existing_objects.js"
    echo ""
}

################################################################################
# Main Execution
################################################################################

main() {
    print_header "ATTACHMENT UPLOAD DIAGNOSTIC TOOL"

    print_info "This script will run all diagnostic tests to identify"
    print_info "why attachment uploads are failing."
    echo ""
    print_info "Diagnostic log will be saved to: $DIAGNOSTIC_LOG"
    echo ""

    # Pre-flight checks
    check_node
    check_scripts_exist
    create_log_dir

    # Initialize diagnostic log
    echo "Attachment Upload Diagnostic Log - $TIMESTAMP" > "$DIAGNOSTIC_LOG"
    echo "=========================================" >> "$DIAGNOSTIC_LOG"
    echo "" >> "$DIAGNOSTIC_LOG"

    # Run diagnostic steps
    local config_result=0
    local endpoint_result=0
    local mapping_result=0
    local assets_result=0

    run_configuration_check || config_result=1
    run_endpoint_test || endpoint_result=1
    check_mapping_file || mapping_result=1
    check_datacenter_assets || assets_result=1

    # Analyze and report results
    analyze_results

    print_header "FINAL STATUS"

    if [ $config_result -eq 0 ] && [ $endpoint_result -eq 0 ] && [ $mapping_result -eq 0 ] && [ $assets_result -eq 0 ]; then
        print_success "All diagnostic checks passed!"
        print_info "You can proceed with the attachment upload script."
        echo ""
        echo "Run: cd $SCRIPT_DIR && node upload_attachments_to_existing_objects.js"
        exit 0
    else
        print_error "Some diagnostic checks failed."
        print_info "Please review the errors above and the diagnostic log."
        print_info "See ATTACHMENT_UPLOAD_DEBUG.md for solutions."
        echo ""
        echo "View diagnostic log:"
        echo "  cat $DIAGNOSTIC_LOG"
        exit 1
    fi
}

# Run main function
main
