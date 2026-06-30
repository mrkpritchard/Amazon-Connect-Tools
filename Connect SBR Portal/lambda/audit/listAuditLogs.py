import json
import boto3
import os
from datetime import datetime, timedelta
from boto3.dynamodb.conditions import Key
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
table_name = os.environ.get('AUDIT_TABLE_NAME', 'SBRPortalAuditLog')
table = dynamodb.Table(table_name)

def lambda_handler(event, context):
    # CORS headers
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Content-Type': 'application/json'
    }
    
    # Handle OPTIONS preflight
    if event.get('httpMethod') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': headers,
            'body': ''
        }
    
    try:
        # Get query parameters
        params = event.get('queryStringParameters', {}) or {}
        limit = int(params.get('limit', 1000))  # Default to last 1000 entries
        
        # Scan the table (for small datasets this is fine)
        # For production with large datasets, consider using DynamoDB Streams or time-based partitions
        response = table.scan(Limit=limit)
        
        items = response.get('Items', [])
        
        # Sort by timestamp descending (newest first)
        items.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
        
        # Convert any Decimal types to float for JSON serialization
        items = json.loads(json.dumps(items, default=decimal_default))
        
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps(items)
        }
        
    except Exception as e:
        print(f"Error reading audit log: {str(e)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(e)})
        }

def decimal_default(obj):
    """Helper to convert Decimal to float"""
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError
