import json
import boto3
import os
from decimal import Decimal

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb')

# Table name from environment variable or default
TABLE_NAME = os.environ.get('GROUPS_TABLE', 'SBRPortalGroups')

def lambda_handler(event, context):
    """
    Handle group permission management (GET, POST, PUT, DELETE)
    """
    
    # CORS headers
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Content-Type': 'application/json'
    }
    
    # Handle OPTIONS preflight
    if 'httpMethod' in event and event['httpMethod'] == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': headers,
            'body': ''
        }
    
    try:
        http_method = event.get('httpMethod', 'GET')
        path = event.get('path', '')
        query_params = event.get('queryStringParameters') or {}
        region = query_params.get('region', 'us-east-1')
        
        # Parse path parameters for group name (e.g., /api/groups/{groupName})
        path_params = event.get('pathParameters') or {}
        group_name = path_params.get('groupName')
        
        # Get the table for the specified region
        table_name = f'SBRPortalGroups-{region}'
        table = dynamodb.Table(table_name)
        
        if http_method == 'GET':
            # List all groups
            response = table.scan()
            items = response.get('Items', [])
            
            # Convert Decimal to regular numbers for JSON serialization
            items = json.loads(json.dumps(items, default=decimal_default))
            
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({'groups': items})
            }
            
        elif http_method == 'POST':
            # Create new group
            body = json.loads(event.get('body', '{}'))
            
            group_name = body.get('GroupName')
            if not group_name:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'GroupName is required'})
                }
            
            # Check if group already exists
            try:
                existing = table.get_item(Key={'GroupName': group_name})
                if 'Item' in existing:
                    return {
                        'statusCode': 400,
                        'headers': headers,
                        'body': json.dumps({'error': f'Group {group_name} already exists'})
                    }
            except Exception:
                pass
            
            item = {
                'GroupName': group_name,
                'AllowedProficiencies': body.get('AllowedProficiencies', []),
                'Region': region
            }
            
            table.put_item(Item=item)
            
            return {
                'statusCode': 201,
                'headers': headers,
                'body': json.dumps({'message': 'Group created successfully', 'group': item})
            }
            
        elif http_method == 'PUT':
            # Update existing group
            if not group_name:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'GroupName is required'})
                }
            
            body = json.loads(event.get('body', '{}'))
            
            # Check if group exists
            try:
                existing = table.get_item(Key={'GroupName': group_name})
                if 'Item' not in existing:
                    return {
                        'statusCode': 404,
                        'headers': headers,
                        'body': json.dumps({'error': f'Group {group_name} not found'})
                    }
            except Exception as e:
                return {
                    'statusCode': 404,
                    'headers': headers,
                    'body': json.dumps({'error': f'Group {group_name} not found'})
                }
            
            # Update the group
            item = {
                'GroupName': group_name,
                'AllowedProficiencies': body.get('AllowedProficiencies', []),
                'Region': region
            }
            
            table.put_item(Item=item)
            
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({'message': 'Group updated successfully', 'group': item})
            }
            
        elif http_method == 'DELETE':
            # Delete group
            if not group_name:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'GroupName is required'})
                }
            
            # Check if group exists
            try:
                existing = table.get_item(Key={'GroupName': group_name})
                if 'Item' not in existing:
                    return {
                        'statusCode': 404,
                        'headers': headers,
                        'body': json.dumps({'error': f'Group {group_name} not found'})
                    }
            except Exception:
                return {
                    'statusCode': 404,
                    'headers': headers,
                    'body': json.dumps({'error': f'Group {group_name} not found'})
                }
            
            table.delete_item(Key={'GroupName': group_name})
            
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({'message': f'Group {group_name} deleted successfully'})
            }
        
        else:
            return {
                'statusCode': 405,
                'headers': headers,
                'body': json.dumps({'error': 'Method not allowed'})
            }
            
    except Exception as e:
        print(f'Error: {str(e)}')
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(e)})
        }

def decimal_default(obj):
    """Helper function to convert Decimal to float for JSON serialization"""
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError
