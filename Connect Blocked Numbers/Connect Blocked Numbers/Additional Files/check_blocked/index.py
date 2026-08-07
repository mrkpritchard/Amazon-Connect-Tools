import os
import boto3
from datetime import datetime, timezone, timedelta
TABLE_NAME = os.environ['TABLE_NAME']
TABLE_REGION = os.environ.get('TABLE_REGION', os.environ.get('AWS_REGION', 'us-east-1'))
# Amazon Connect can invoke this Lambda several times for what is really one
# call (e.g. while the caller is still connecting / hearing ringback, or on
# flow retries). Treat repeat blocks of the same number within this window as
# a single attempt so the counter doesn't inflate.
DEBOUNCE_SECONDS = 20
dynamodb = boto3.resource('dynamodb', region_name=TABLE_REGION)
table = dynamodb.Table(TABLE_NAME)
def record_block_hit(region, phone_number, existing_item=None):
    """Increment the block counter (total + per-day) and update the last-blocked timestamp.
    Debounced: if this same number was already recorded as blocked within the
    last DEBOUNCE_SECONDS, skip the counter update (still reports BLOCKED to
    the call flow either way).
    """
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    today = now.strftime('%Y-%m-%d')
    last_blocked_at = existing_item.get('LastBlockedAt') if existing_item else None
    if last_blocked_at:
        try:
            last_dt = datetime.fromisoformat(last_blocked_at)
            if now - last_dt < timedelta(seconds=DEBOUNCE_SECONDS):
                print(f"Debounced duplicate block hit for {phone_number} ({region})")
                return
        except ValueError:
            pass  # malformed timestamp — fall through and record normally
    has_daily_counts = bool(existing_item and existing_item.get('DailyCounts'))
    try:
        if has_daily_counts:
            # DailyCounts map already exists — increment today's entry in place
            table.update_item(
                Key={'Region': region, 'PhoneNumber': phone_number},
                UpdateExpression='ADD BlockCount :inc, DailyCounts.#today :inc SET LastBlockedAt = :now',
                ExpressionAttributeNames={'#today': today},
                ExpressionAttributeValues={':inc': 1, ':now': now_iso}
            )
        else:
            # First time tracking daily counts for this number — create the map
            table.update_item(
                Key={'Region': region, 'PhoneNumber': phone_number},
                UpdateExpression='SET DailyCounts = :initMap, LastBlockedAt = :now ADD BlockCount :inc',
                ExpressionAttributeValues={':initMap': {today: 1}, ':now': now_iso, ':inc': 1}
            )
    except Exception as e:
        # Never fail the call flow because a stats update failed
        print(f"Error recording block hit for {phone_number} ({region}): {e}")
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
            record_block_hit(connect_region, phone_number, response['Item'])
            return {'result': 'BLOCKED'}
        # Check if number is globally blocked (Region = ALL)
        response = table.get_item(
            Key={'Region': 'ALL', 'PhoneNumber': phone_number}
        )
        if 'Item' in response:
            print(f"BLOCKED (global): {phone_number}")
            record_block_hit('ALL', phone_number, response['Item'])
            return {'result': 'BLOCKED'}
        return {'result': 'ALLOWED'}
    except Exception as e:
        print(f"Error checking blocked number {phone_number}: {e}")
        # Fail open — never block callers due to a lookup error
        return {'result': 'ALLOWED'}