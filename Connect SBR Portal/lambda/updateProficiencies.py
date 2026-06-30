import boto3
import json
import os

# Initialize clients
connect = boto3.client('connect', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
s3 = boto3.client('s3')

# Amazon Connect Instance ID - set via environment variable
INSTANCE_ID = os.environ.get('CONNECT_INSTANCE_ID')
CACHE_BUCKET = os.environ.get('CACHE_BUCKET')
CACHE_KEY = 'sbr-portal/cache/users.json'

def handler(event, context):
    print('Event:', json.dumps(event))
    
    # Handle OPTIONS request for CORS
    if event.get('httpMethod') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'PUT,OPTIONS'
            },
            'body': ''
        }
    
    try:
        body = json.loads(event.get('body', '{}'))
        proficiencies = body.get('proficiencies', [])
        
        user_id = event.get('pathParameters', {}).get('userId')
        
        if not user_id:
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps({'error': 'User ID is required'})
            }
        
        print(f"Updating proficiencies for user {user_id}...")
        
        # Get current proficiencies and remove them
        try:
            current_proficiencies = connect.list_user_proficiencies(
                InstanceId=INSTANCE_ID,
                UserId=user_id,
                MaxResults=100
            )
            
            if current_proficiencies.get('UserProficiencyList'):
                connect.disassociate_user_proficiencies(
                    InstanceId=INSTANCE_ID,
                    UserId=user_id,
                    UserProficiencies=[
                        {
                            'AttributeName': prof['AttributeName'],
                            'AttributeValue': prof['AttributeValue']
                        }
                        for prof in current_proficiencies['UserProficiencyList']
                    ]
                )
        except Exception as error:
            print(f"Error removing existing proficiencies: {str(error)}")
        
        # Add new proficiencies
        if proficiencies:
            user_proficiencies = [
                {
                    'AttributeName': prof['name'],
                    'AttributeValue': prof.get('value', prof['name']),
                    'Level': prof['level']
                }
                for prof in proficiencies
            ]
            
            connect.associate_user_proficiencies(
                InstanceId=INSTANCE_ID,
                UserId=user_id,
                UserProficiencies=user_proficiencies
            )
        
        # Fetch updated user data
        user_details = connect.describe_user(
            InstanceId=INSTANCE_ID,
            UserId=user_id
        )
        
        updated_proficiencies = []
        
        try:
            attributes = connect.list_user_proficiencies(
                InstanceId=INSTANCE_ID,
                UserId=user_id,
                MaxResults=100
            )
            
            if attributes.get('UserProficiencyList'):
                updated_proficiencies = [
                    {
                        'name': prof['AttributeName'],
                        'level': prof['Level'],
                        'value': prof['AttributeValue']
                    }
                    for prof in attributes['UserProficiencyList']
                ]
        except Exception as error:
            print(f"Error fetching updated proficiencies: {str(error)}")
        
        identity_info = user_details['User'].get('IdentityInfo', {})
        first_name = identity_info.get('FirstName', '')
        last_name = identity_info.get('LastName', '')
        
        updated_user = {
            'id': user_id,
            'name': f"{first_name} {last_name}".strip() if first_name or last_name else user_details['User'].get('Username', ''),
            'email': identity_info.get('Email', ''),
            'username': user_details['User'].get('Username', ''),
            'proficiencies': updated_proficiencies
        }
        
        # Invalidate cache to force refresh on next load
        try:
            s3.delete_object(Bucket=CACHE_BUCKET, Key=CACHE_KEY)
            print("Cache invalidated successfully")
        except Exception as cache_error:
            print(f"Warning: Could not invalidate cache: {str(cache_error)}")
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'PUT,OPTIONS'
            },
            'body': json.dumps(updated_user)
        }
        
    except Exception as error:
        print('Error:', str(error))
        
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({
                'error': str(error)
            })
        }
