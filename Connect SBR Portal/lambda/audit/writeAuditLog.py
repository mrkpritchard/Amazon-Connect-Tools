import json
import boto3
import os
from datetime import datetime
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
table_name = os.environ.get('AUDIT_TABLE_NAME', 'SBRPortalAuditLog')
table = dynamodb.Table(table_name)

def lambda_handler(event, context):
    # Handle OPTIONS preflight FIRST
    if 'httpMethod' in event and event['httpMethod'] == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'POST,OPTIONS'
            },
            'body': ''
        }
    
    print(f"Event received: {json.dumps(event)}")
    
    # CORS headers
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Content-Type': 'application/json'
    }
    
    try:
        # Parse request body
        body = json.loads(event['body']) if isinstance(event['body'], str) else event['body']
        
        # Validate required fields
        required_fields = ['timestamp', 'userId', 'userName', 'modifiedBy', 'changes', 'region']
        for field in required_fields:
            if field not in body:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': f'Missing required field: {field}'})
                }
        
        # Create audit log item
        audit_item = {
            'timestamp': body['timestamp'],
            'userId': body['userId'],
            'userName': body['userName'],
            'modifiedBy': body['modifiedBy'],
            'changes': body['changes'],
            'region': body['region']
        }
        
        # Write to DynamoDB
        table.put_item(Item=audit_item)
        
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({
                'message': 'Audit log entry created successfully',
                'timestamp': body['timestamp']
            })
        }
        
    except Exception as e:
        print(f"Error writing audit log: {str(e)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(e)})
        }
