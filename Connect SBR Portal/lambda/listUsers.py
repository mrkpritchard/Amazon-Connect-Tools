import boto3
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

# Get region from environment - Lambda provides AWS_REGION
REGION = os.environ.get('AWS_REGION', os.environ.get('AWS_DEFAULT_REGION', 'us-east-1'))

# Initialize clients with correct region
connect = boto3.client('connect', region_name=REGION)
s3 = boto3.client('s3')

# Amazon Connect Instance ID - set via environment variable
INSTANCE_ID = os.environ.get('CONNECT_INSTANCE_ID')
CACHE_BUCKET = os.environ.get('CACHE_BUCKET')
CACHE_KEY = f'sbr-portal/cache/users-{REGION}.json'
CACHE_DURATION_MINUTES = 10

def fetch_user_with_proficiencies(user):
    """Fetch proficiencies and routing profile - only return if has proficiencies."""
    try:
        time.sleep(0.2)
        
        user_details = connect.describe_user(
            InstanceId=INSTANCE_ID,
            UserId=user['Id']
        )
        
        routing_profile_name = ''
        try:
            routing_profile_id = user_details['User'].get('RoutingProfileId')
            if routing_profile_id:
                routing_profile = connect.describe_routing_profile(
                    InstanceId=INSTANCE_ID,
                    RoutingProfileId=routing_profile_id
                )
                routing_profile_name = routing_profile['RoutingProfile'].get('Name', '')
        except Exception as e:
            print(f"Could not fetch routing profile for user {user['Id']}: {str(e)}")
        
        max_retries = 3
        for attempt in range(max_retries):
            try:
                prof_response = connect.list_user_proficiencies(
                    InstanceId=INSTANCE_ID,
                    UserId=user['Id'],
                    MaxResults=100
                )
                break
            except connect.exceptions.TooManyRequestsException:
                if attempt < max_retries - 1:
                    time.sleep(1 * (attempt + 1))
                else:
                    raise
        
        if not prof_response.get('UserProficiencyList'):
            return None
        
        proficiencies = [
            {
                'name': prof['AttributeName'],
                'level': prof['Level'],
                'value': prof['AttributeValue']
            }
            for prof in prof_response['UserProficiencyList']
        ]
        
        identity_info = user_details['User'].get('IdentityInfo', {})
        first_name = identity_info.get('FirstName', '')
        last_name = identity_info.get('LastName', '')
        
        return {
            'id': user['Id'],
            'name': f"{first_name} {last_name}".strip() if first_name or last_name else user.get('Username', ''),
            'email': identity_info.get('Email', ''),
            'username': user.get('Username', ''),
            'routingProfile': routing_profile_name,
            'proficiencies': proficiencies
        }
    except Exception as e:
        print(f"Error fetching user {user.get('Id', 'unknown')}: {str(e)}")
        return None

def handler(event, context):
    # Handle OPTIONS request for CORS
    if event.get('httpMethod') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,OPTIONS'
            },
            'body': ''
        }
    
    print('Starting user fetch...')
    print(f'Region: {REGION}')
    print(f'Instance ID: {INSTANCE_ID}')
    print(f'Cache Key: {CACHE_KEY}')
    
    try:
        # Check if we have valid cached data
        try:
            cache_obj = s3.get_object(Bucket=CACHE_BUCKET, Key=CACHE_KEY)
            cache_data = json.loads(cache_obj['Body'].read().decode('utf-8'))
            cache_time = datetime.fromisoformat(cache_data['timestamp'])
            
            if datetime.now() - cache_time < timedelta(minutes=CACHE_DURATION_MINUTES):
                print(f"Returning cached data from {cache_time}")
                return {
                    'statusCode': 200,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                        'Access-Control-Allow-Methods': 'GET,OPTIONS',
                        'X-Cache': 'HIT'
                    },
                    'body': json.dumps(cache_data['users'])
                }
        except Exception as e:
            print(f"No valid cache found: {str(e)}")
        
        # Fetch fresh data
        users = []
        user_list = []
        next_token = None
        
        while True:
            params = {
                'InstanceId': INSTANCE_ID,
                'MaxResults': 100
            }
            
            if next_token:
                params['NextToken'] = next_token
            
            response = connect.list_users(**params)
            user_list.extend(response.get('UserSummaryList', []))
            
            next_token = response.get('NextToken')
            if not next_token:
                break
        
        print(f"Found {len(user_list)} total users, checking for proficiencies...")
        
        # Fetch proficiencies in parallel (3 workers to avoid rate limits)
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {executor.submit(fetch_user_with_proficiencies, user): user for user in user_list}
            
            for future in as_completed(futures):
                result = future.result()
                if result:
                    users.append(result)
        
        print(f"Found {len(users)} users with proficiencies")
        
        # Cache the results in S3
        try:
            cache_data = {
                'timestamp': datetime.now().isoformat(),
                'users': users
            }
            s3.put_object(
                Bucket=CACHE_BUCKET,
                Key=CACHE_KEY,
                Body=json.dumps(cache_data),
                ContentType='application/json'
            )
            print(f"Cached {len(users)} users to S3")
        except Exception as e:
            print(f"Failed to cache data: {str(e)}")
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,OPTIONS',
                'X-Cache': 'MISS'
            },
            'body': json.dumps(users)
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
