import json
import boto3
import os
import base64

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb')

def lambda_handler(event, context):
    """
    Return allowed proficiencies for the current user based on their Cognito groups.
    Similar to Callback Admin's /user/queues endpoint.
    """
    
    # CORS headers
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
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
        # Get region from query parameters
        query_params = event.get('queryStringParameters') or {}
        region = query_params.get('region', 'us-east-1')
        
        # Extract user groups from JWT token
        auth_header = event.get('headers', {}).get('Authorization') or event.get('headers', {}).get('authorization')
        if not auth_header:
            return {
                'statusCode': 401,
                'headers': headers,
                'body': json.dumps({'error': 'No authorization header'})
            }
        
        # Remove 'Bearer ' prefix if present
        token = auth_header.replace('Bearer ', '').replace('bearer ', '')
        
        # Decode JWT to get groups (just decode, don't verify - API Gateway can handle verification)
        try:
            # JWT is base64 encoded, split by '.' and decode the payload (middle part)
            payload_encoded = token.split('.')[1]
            # Add padding if needed
            padding = 4 - len(payload_encoded) % 4
            if padding != 4:
                payload_encoded += '=' * padding
            payload = json.loads(base64.b64decode(payload_encoded))
            user_groups = payload.get('cognito:groups', [])
            username = payload.get('cognito:username') or payload.get('username') or payload.get('email', 'unknown')
        except Exception as e:
            print(f'Error decoding JWT: {str(e)}')
            return {
                'statusCode': 401,
                'headers': headers,
                'body': json.dumps({'error': 'Invalid token'})
            }
        
        print(f'User {username} has groups: {user_groups}')
        
        # Check if user is admin
        is_admin = 'SBR-Admin' in user_groups or 'Callback-Admin' in user_groups
        
        if is_admin:
            # Admin users see all proficiencies
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({
                    'isAdmin': True,
                    'allowedProficiencies': None,  # null means all proficiencies
                    'groups': user_groups
                })
            }
        
        # For non-admin users, look up their group permissions in DynamoDB
        table_name = f'SBRPortalGroups-{region}'
        table = dynamodb.Table(table_name)
        
        allowed_proficiencies = []
        
        # Query each group the user belongs to
        for group_name in user_groups:
            try:
                response = table.get_item(Key={'GroupName': group_name})
                if 'Item' in response:
                    group_permissions = response['Item']
                    group_proficiencies = group_permissions.get('AllowedProficiencies', [])
                    
                    # If empty array, it means all proficiencies
                    if isinstance(group_proficiencies, list) and len(group_proficiencies) == 0:
                        print(f'Group {group_name} has access to ALL proficiencies')
                        return {
                            'statusCode': 200,
                            'headers': headers,
                            'body': json.dumps({
                                'isAdmin': False,
                                'allowedProficiencies': None,  # null means all proficiencies
                                'groups': user_groups
                            })
                        }
                    
                    # Add proficiencies from this group
                    for prof in group_proficiencies:
                        if prof not in allowed_proficiencies:
                            allowed_proficiencies.append(prof)
                    
                    print(f'Group {group_name} allows proficiencies: {group_proficiencies}')
            except Exception as e:
                print(f'Error fetching group {group_name}: {str(e)}')
                continue
        
        print(f'User {username} has access to proficiencies: {allowed_proficiencies}')
        
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({
                'isAdmin': False,
                'allowedProficiencies': allowed_proficiencies,
                'groups': user_groups
            })
        }
        
    except Exception as e:
        print(f'Error: {str(e)}')
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(e)})
        }
