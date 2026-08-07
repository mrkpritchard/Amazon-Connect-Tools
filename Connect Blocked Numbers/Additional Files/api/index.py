import os
import json
import boto3
from datetime import datetime, timezone
from decimal import Decimal

TABLE_NAME = os.environ['TABLE_NAME']

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)

HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
}


def handler(event, context):
    method = event.get('httpMethod', '')

    if method == 'OPTIONS':
        return respond(200, '')

    try:
        if method == 'GET':
            return get_blocked_numbers(event)
        elif method == 'POST':
            return add_blocked_numbers(event)
        elif method == 'DELETE':
            return delete_blocked_number(event)
        else:
            return respond(405, {'error': f'Method {method} not allowed'})
    except Exception as e:
        print(f"Error: {e}")
        return respond(500, {'error': 'Internal server error'})


def get_blocked_numbers(event):
    params = event.get('queryStringParameters') or {}
    region = params.get('region', '')

    if not region:
        return respond(400, {'error': 'region query parameter is required'})

    result = table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key('Region').eq(region)
    )

    items = [convert_decimals(item) for item in result.get('Items', [])]

    return respond(200, {'numbers': items, 'count': len(items)})


def add_blocked_numbers(event):
    body = json.loads(event.get('body', '{}'))

    # Get caller identity from Cognito claims
    claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
    blocked_by = claims.get('email', claims.get('cognito:username', 'unknown'))

    # Support bulk add: body can have "numbers" array or a single "phoneNumber"
    numbers = body.get('numbers', [])
    if not numbers:
        phone_number = body.get('phoneNumber', '')
        description = body.get('description', '')
        region = body.get('region', '')
        if not phone_number or not region:
            return respond(400, {'error': 'region and phoneNumber are required'})
        numbers = [{'phoneNumber': phone_number, 'description': description}]
        region = body.get('region', '')
    else:
        region = body.get('region', '')
        if not region:
            return respond(400, {'error': 'region is required'})

    now = datetime.now(timezone.utc).isoformat()
    added = []
    errors = []

    for entry in numbers:
        phone = entry.get('phoneNumber', '').strip()
        desc = entry.get('description', '').strip()

        if not phone:
            errors.append({'phoneNumber': phone, 'error': 'empty phone number'})
            continue

        # Normalize: ensure + prefix
        if not phone.startswith('+'):
            phone = '+' + phone

        try:
            table.put_item(
                Item={
                    'Region': region,
                    'PhoneNumber': phone,
                    'Description': desc,
                    'BlockedAt': now,
                    'BlockedBy': blocked_by
                }
            )
            added.append(phone)
        except Exception as e:
            errors.append({'phoneNumber': phone, 'error': str(e)})

    return respond(201, {
        'message': f'{len(added)} number(s) blocked in {region}',
        'added': added,
        'errors': errors
    })


def delete_blocked_number(event):
    params = event.get('queryStringParameters') or {}
    region = params.get('region', '')
    phone_number = params.get('phoneNumber', '')

    if not region or not phone_number:
        return respond(400, {'error': 'region and phoneNumber query parameters are required'})

    table.delete_item(
        Key={
            'Region': region,
            'PhoneNumber': phone_number
        }
    )

    return respond(200, {'message': f'{phone_number} unblocked in {region}'})


def convert_decimals(obj):
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    elif isinstance(obj, dict):
        return {k: convert_decimals(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_decimals(i) for i in obj]
    return obj


def respond(status_code, body):
    return {
        'statusCode': status_code,
        'headers': HEADERS,
        'body': json.dumps(body) if body else ''
    }
