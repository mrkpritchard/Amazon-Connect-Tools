import json
import boto3
from boto3.dynamodb.conditions import Key
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')

def lambda_handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Content-Type': 'application/json'
    }
    
    # Handle OPTIONS for CORS preflight
    if event.get('httpMethod') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': headers,
            'body': ''
        }
    
    try:
        http_method = event.get('httpMethod')
        path_parameters = event.get('pathParameters') or {}
        query_parameters = event.get('queryStringParameters') or {}
        
        # Get region from query parameter
        region = query_parameters.get('region', 'us-east-1')
        
        # Determine table name based on region
        if region == 'us-east-1':
            table_name = 'SBRPortalUsers-us-east-1'
        elif region == 'eu-central-1':
            table_name = 'SBRPortalUsers-eu-central-1'
        else:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({'error': f'Invalid region: {region}'})
            }
        
        table = dynamodb.Table(table_name)
        
        # Get email from path parameters (API Gateway uses userId as the path param name)
        email = path_parameters.get('userId') or path_parameters.get('email')
        
        if http_method == 'GET':
            # List all users
            response = table.scan()
            users = response.get('Items', [])
            
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({'users': users}, default=decimal_default)
            }
            
        elif http_method == 'POST':
            # Create new user permission
            body = json.loads(event.get('body', '{}'))
            
            user_email = body.get('Email')
            if not user_email:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'Email is required'})
                }
            
            # Check if user already exists
            try:
                existing = table.get_item(Key={'Email': user_email})
                if 'Item' in existing:
                    return {
                        'statusCode': 400,
                        'headers': headers,
                        'body': json.dumps({'error': f'User {user_email} already exists'})
                    }
            except Exception:
                pass
            
            item = {
                'Email': user_email,
                'AllowedRegions': body.get('AllowedRegions', []),
                'AllowedProficiencies': body.get('AllowedProficiencies', []),
                'Region': region
            }
            
            table.put_item(Item=item)
            
            return {
                'statusCode': 201,
                'headers': headers,
                'body': json.dumps({'message': 'User created successfully', 'user': item})
            }
            
        elif http_method == 'PUT':
            # Update existing user
            if not email:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'Email is required'})
                }
            
            body = json.loads(event.get('body', '{}'))
            
            # Check if user exists
            try:
                existing = table.get_item(Key={'Email': email})
                if 'Item' not in existing:
                    return {
                        'statusCode': 404,
                        'headers': headers,
                        'body': json.dumps({'error': f'User {email} not found'})
                    }
            except Exception as e:
                return {
                    'statusCode': 404,
                    'headers': headers,
                    'body': json.dumps({'error': f'User {email} not found'})
                }
            
            # Update the user
            item = {
                'Email': email,
                'AllowedRegions': body.get('AllowedRegions', []),
                'AllowedProficiencies': body.get('AllowedProficiencies', []),
                'Region': region
            }
            
            table.put_item(Item=item)
            
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({'message': 'User updated successfully', 'user': item})
            }
            
        elif http_method == 'DELETE':
            # Delete user
            if not email:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'Email is required'})
                }
            
            try:
                table.delete_item(Key={'Email': email})
                return {
                    'statusCode': 200,
                    'headers': headers,
                    'body': json.dumps({'message': f'User {email} deleted successfully'})
                }
            except Exception as e:
                print(f"Error deleting user: {str(e)}")
                return {
                    'statusCode': 500,
                    'headers': headers,
                    'body': json.dumps({'error': f'Failed to delete user: {str(e)}'})
                }
        
        else:
            return {
                'statusCode': 405,
                'headers': headers,
                'body': json.dumps({'error': f'Method {http_method} not allowed'})
            }
            
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(e)})
        }

def decimal_default(obj):
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError
