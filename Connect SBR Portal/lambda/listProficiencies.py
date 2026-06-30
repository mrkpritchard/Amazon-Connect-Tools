import boto3
import json
import os
from datetime import datetime, timedelta

# Get region from environment
REGION = os.environ.get('AWS_REGION', os.environ.get('AWS_DEFAULT_REGION', 'us-east-1'))

# Initialize Connect and S3 clients
connect = boto3.client('connect', region_name=REGION)
s3 = boto3.client('s3')

# Amazon Connect Instance ID - set via environment variable
INSTANCE_ID = os.environ.get('CONNECT_INSTANCE_ID')
CACHE_BUCKET = os.environ.get('CACHE_BUCKET')
CACHE_KEY = f'sbr-portal/cache/all-proficiencies-{REGION}.json'
CACHE_DURATION_MINUTES = 60

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
    
    print('Fetching all available proficiencies from Amazon Connect...')
    
    try:
        # Check if we have valid cached data
        try:
            cache_obj = s3.get_object(Bucket=CACHE_BUCKET, Key=CACHE_KEY)
            cache_data = json.loads(cache_obj['Body'].read().decode('utf-8'))
            cache_time = datetime.fromisoformat(cache_data['timestamp'])
            
            if datetime.now() - cache_time < timedelta(minutes=CACHE_DURATION_MINUTES):
                print(f"Returning cached proficiencies ({len(cache_data['proficiencies'])} items)")
                return {
                    'statusCode': 200,
                    'headers': {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                        'Access-Control-Allow-Methods': 'GET,OPTIONS',
                        'X-Cache': 'HIT'
                    },
                    'body': json.dumps(cache_data['proficiencies'])
                }
        except Exception as e:
            print(f"No valid cache found: {str(e)}")
        
        # Fetch all predefined attributes from Amazon Connect
        all_attributes = []
        next_token = None
        
        while True:
            params = {
                'InstanceId': INSTANCE_ID,
                'MaxResults': 100
            }
            
            if next_token:
                params['NextToken'] = next_token
            
            response = connect.search_predefined_attributes(**params)
            
            for attr in response.get('PredefinedAttributes', []):
                attr_name = attr.get('Name', '')
                
                if 'Values' in attr and attr['Values'].get('StringList'):
                    for value in attr['Values']['StringList']:
                        all_attributes.append({
                            'name': attr_name,
                            'value': value,
                            'displayName': f"{attr_name} - {value}"
                        })
                else:
                    all_attributes.append({
                        'name': attr_name,
                        'value': attr_name,
                        'displayName': attr_name
                    })
            
            next_token = response.get('NextToken')
            if not next_token:
                break
        
        all_attributes.sort(key=lambda x: x['displayName'])
        
        print(f"Found {len(all_attributes)} total proficiency options")
        
        # Cache the results
        cache_data = {
            'timestamp': datetime.now().isoformat(),
            'proficiencies': all_attributes
        }
        
        s3.put_object(
            Bucket=CACHE_BUCKET,
            Key=CACHE_KEY,
            Body=json.dumps(cache_data),
            ContentType='application/json'
        )
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,OPTIONS',
                'X-Cache': 'MISS'
            },
            'body': json.dumps(all_attributes)
        }
        
    except Exception as error:
        print('Error:', str(error))
        import traceback
        traceback.print_exc()
        
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
