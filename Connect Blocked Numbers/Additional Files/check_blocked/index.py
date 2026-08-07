import os
import boto3

TABLE_NAME = os.environ['TABLE_NAME']
TABLE_REGION = os.environ.get('TABLE_REGION', os.environ.get('AWS_REGION', 'us-east-1'))

dynamodb = boto3.resource('dynamodb', region_name=TABLE_REGION)
table = dynamodb.Table(TABLE_NAME)


def handler(event, context):
    """
    Invoked by Amazon Connect flows to check if an inbound caller is blocked.

    Connect event includes Details.ContactData.CustomerEndpoint.Address (phone number)
    and Details.ContactData.InstanceARN (to determine the Connect region).

    Returns:
        { "result": "BLOCKED" } or { "result": "ALLOWED" }
    The flow checks $.External.result and routes accordingly.
    """
    contact_data = event.get('Details', {}).get('ContactData', {})
    customer_endpoint = contact_data.get('CustomerEndpoint', {})
    phone_number = customer_endpoint.get('Address', '')

    if not phone_number:
        return {'result': 'ALLOWED'}

    # Normalize phone number
    phone_number = phone_number.strip()
    if not phone_number.startswith('+'):
        phone_number = '+' + phone_number

    # Determine the Connect instance region from the InstanceARN
    # Format: arn:aws:connect:REGION:ACCOUNT:instance/ID
    instance_arn = contact_data.get('InstanceARN', '')
    connect_region = ''
    if instance_arn:
        arn_parts = instance_arn.split(':')
        if len(arn_parts) >= 4:
            connect_region = arn_parts[3]
    if not connect_region:
        connect_region = os.environ.get('AWS_REGION', 'us-east-1')

    try:
        # Check if number is blocked for this specific region
        response = table.get_item(
            Key={'Region': connect_region, 'PhoneNumber': phone_number}
        )
        if 'Item' in response:
            print(f"BLOCKED: {phone_number} (region: {connect_region})")
            return {'result': 'BLOCKED'}

        # Check if number is globally blocked (Region = ALL)
        response = table.get_item(
            Key={'Region': 'ALL', 'PhoneNumber': phone_number}
        )
        if 'Item' in response:
            print(f"BLOCKED (global): {phone_number}")
            return {'result': 'BLOCKED'}

        return {'result': 'ALLOWED'}

    except Exception as e:
        print(f"Error checking blocked number {phone_number}: {e}")
        # Fail open — never block callers due to a lookup error
        return {'result': 'ALLOWED'}
