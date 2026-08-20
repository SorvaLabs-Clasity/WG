#!/bin/bash

# Script to enforce HTTPS-only access on S3 buckets
# Reads bucket names from buckets.txt file

set -e  # Exit on any error

# Use the working Homebrew AWS CLI instead of the broken system one
AWS_CLI="/opt/homebrew/bin/aws"
if [[ ! -f "$AWS_CLI" ]]; then
    echo "Error: AWS CLI not found at $AWS_CLI. Please install via: brew install awscli"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUCKETS_FILE="$SCRIPT_DIR/buckets.txt"
LOG_FILE="$SCRIPT_DIR/https_enforcement.log"

# Check if buckets.txt exists
if [[ ! -f "$BUCKETS_FILE" ]]; then
    echo "Error: buckets.txt file not found in $SCRIPT_DIR"
    exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed. Please install jq first."
    echo "On macOS: brew install jq"
    exit 1
fi

# Function to log messages
log_message() {
    local message="$1"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $message" | tee -a "$LOG_FILE"
}

# Function to create HTTPS-only policy statement
create_https_statement() {
    local bucket_name="$1"
    cat <<EOF
{
    "Sid": "DenyNonSSLRequests",
    "Effect": "Deny",
    "Principal": "*",
    "Action": "s3:*",
    "Resource": [
        "arn:aws:s3:::$bucket_name",
        "arn:aws:s3:::$bucket_name/*"
    ],
    "Condition": {
        "Bool": {
            "aws:SecureTransport": "false"
        }
    }
}
EOF
}

# Function to check if HTTPS policy already exists
has_https_policy() {
    local policy="$1"
    echo "$policy" | jq -r '.Statement[]? | select(.Sid == "DenyNonSSLRequests" or (.Condition.Bool."aws:SecureTransport" == "false" and .Effect == "Deny")) | .Sid' | grep -q "DenyNonSSLRequests" 2>/dev/null
}

# Function to process a single bucket
process_bucket() {
    local bucket="$1"
    
    log_message "Processing bucket: $bucket"
    
    # Check if bucket exists and is accessible
    if ! "$AWS_CLI" s3api head-bucket --bucket "$bucket" 2>/dev/null; then
        log_message "ERROR: Cannot access bucket $bucket. Skipping..."
        return 1
    fi
    
    # Try to get existing bucket policy
    local existing_policy
    existing_policy=$("$AWS_CLI" s3api get-bucket-policy --bucket "$bucket" --query Policy --output text 2>/dev/null) || {
        log_message "No existing policy found for bucket $bucket"
        existing_policy=""
    }
    
    if [[ -n "$existing_policy" && "$existing_policy" != "None" ]]; then
        # Bucket has existing policy
        log_message "Found existing policy for bucket $bucket"
        
        # Check if HTTPS policy already exists
        if has_https_policy "$existing_policy"; then
            log_message "HTTPS-only policy already exists for bucket $bucket. Skipping..."
            return 0
        fi
        
        # Add HTTPS statement to existing policy
        local https_statement
        https_statement=$(create_https_statement "$bucket")
        
        local updated_policy
        updated_policy=$(echo "$existing_policy" | jq --argjson new_statement "$https_statement" '.Statement += [$new_statement]')
        
        log_message "Adding HTTPS-only statement to existing policy for bucket $bucket"
        
        # Apply updated policy
        echo "$updated_policy" | "$AWS_CLI" s3api put-bucket-policy --bucket "$bucket" --policy file:///dev/stdin
        
    else
        # No existing policy, create new one
        log_message "Creating new HTTPS-only policy for bucket $bucket"
        
        local new_policy
        new_policy=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        $(create_https_statement "$bucket")
    ]
}
EOF
)
        
        # Apply new policy
        echo "$new_policy" | "$AWS_CLI" s3api put-bucket-policy --bucket "$bucket" --policy file:///dev/stdin
    fi
    
    log_message "Successfully applied HTTPS-only policy to bucket $bucket"
    return 0
}

# Main execution
main() {
    log_message "Starting HTTPS enforcement for S3 buckets"
    log_message "Reading buckets from: $BUCKETS_FILE"
    
    local success_count=0
    local error_count=0
    local total_count=0
    
    # Read buckets from file and process each one
    while IFS= read -r bucket || [[ -n "$bucket" ]]; do
        # Skip empty lines and comments
        if [[ -z "$bucket" || "$bucket" =~ ^[[:space:]]*# ]]; then
            continue
        fi
        
        # Remove leading/trailing whitespace
        bucket=$(echo "$bucket" | xargs)
        
        if [[ -n "$bucket" ]]; then
            ((total_count++))
            if process_bucket "$bucket"; then
                ((success_count++))
            else
                ((error_count++))
            fi
            echo  # Add blank line for readability
        fi
    done < "$BUCKETS_FILE"
    
    log_message "=== Summary ==="
    log_message "Total buckets processed: $total_count"
    log_message "Successfully updated: $success_count"
    log_message "Errors encountered: $error_count"
    
    if [[ $error_count -gt 0 ]]; then
        log_message "Some buckets failed to update. Check the log above for details."
        exit 1
    else
        log_message "All buckets successfully updated with HTTPS-only policies!"
    fi
}

# Run main function
main "$@"