"""
Connect Flow Content Search - Lambda Function v1.0.0
Indexes Amazon Connect contact flows and flow modules into DynamoDB,
then provides free-text search across all flow content.
"""

import json
import os
import re
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

dynamodb = boto3.resource('dynamodb')

TABLE_NAME = os.environ.get('FLOW_INDEX_TABLE', 'FlowSearchIndex')
ACCOUNT_ID = os.environ.get('AWS_ACCOUNT_ID', 'YOUR_AWS_ACCOUNT_ID')

INSTANCE_IDS = {
    'us-east-1': os.environ.get('CONNECT_INSTANCE_ID_US', 'YOUR_CONNECT_INSTANCE_ID'),
    'eu-central-1': os.environ.get('CONNECT_INSTANCE_ID_EU', 'YOUR_CONNECT_INSTANCE_ID'),
    'ap-northeast-1': os.environ.get('CONNECT_INSTANCE_ID_JP', 'YOUR_CONNECT_INSTANCE_ID'),
    'ap-southeast-1': os.environ.get('CONNECT_INSTANCE_ID_SG', 'YOUR_CONNECT_INSTANCE_ID'),
    'eu-central-1-dev': os.environ.get('CONNECT_INSTANCE_ID_DEV', 'YOUR_CONNECT_INSTANCE_ID'),
}

REGION_LABELS = {
    'us-east-1': 'US',
    'eu-central-1': 'EU',
    'ap-northeast-1': 'Tokyo',
    'ap-southeast-1': 'Singapore',
    'eu-central-1-dev': 'Dev',
}

HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json'
}


def handler(event, context):
    """Main Lambda handler"""
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': HEADERS, 'body': ''}

    try:
        path = event.get('path', '')
        method = event.get('httpMethod', '')

        if path.endswith('/index') and method == 'POST':
            return handle_index(event)
        elif path.endswith('/search') and method == 'GET':
            return handle_search(event)
        elif path.endswith('/status') and method == 'GET':
            return handle_status(event)
        else:
            return response(404, {'error': f'Not found: {method} {path}'})
    except Exception as e:
        return response(500, {'error': str(e)})


def handle_index(event):
    """Index flows from one or all regions into DynamoDB"""
    body = json.loads(event.get('body', '{}'))
    region_key = body.get('region', '')

    if not region_key:
        return response(400, {'error': 'Missing region parameter'})

    if region_key == 'all':
        regions_to_index = list(INSTANCE_IDS.keys())
    elif region_key in INSTANCE_IDS:
        regions_to_index = [region_key]
    else:
        return response(400, {'error': f'Invalid region: {region_key}'})

    table = dynamodb.Table(TABLE_NAME)
    results = {}

    for reg in regions_to_index:
        instance_id = INSTANCE_IDS[reg]
        # Dev instance uses eu-central-1 as the actual AWS region
        aws_region = 'eu-central-1' if reg == 'eu-central-1-dev' else reg
        connect = boto3.client('connect', region_name=aws_region)

        flow_count = 0
        module_count = 0

        # Index contact flows
        try:
            paginator = connect.get_paginator('list_contact_flows')
            for page in paginator.paginate(InstanceId=instance_id):
                for flow_summary in page.get('ContactFlowSummaryList', []):
                    flow_id = flow_summary['Id']
                    try:
                        detail = connect.describe_contact_flow(
                            InstanceId=instance_id,
                            ContactFlowId=flow_id
                        )
                        flow = detail.get('ContactFlow', {})
                        content = flow.get('Content', '{}')

                        table.put_item(Item={
                            'Region': reg,
                            'FlowId': f"CONTACT_FLOW#{flow_id}",
                            'FlowName': flow.get('Name', flow_summary.get('Name', 'Unknown')),
                            'FlowType': flow_summary.get('ContactFlowType', 'UNKNOWN'),
                            'ItemType': 'CONTACT_FLOW',
                            'Content': content,
                            'LastIndexed': datetime.now(timezone.utc).isoformat(),
                            'FlowArn': flow.get('Arn', ''),
                        })
                        flow_count += 1
                    except ClientError as e:
                        if e.response['Error']['Code'] == 'AccessDeniedException':
                            continue
                        raise
        except ClientError as e:
            results[reg] = {'error': f'ListContactFlows failed: {str(e)}'}
            continue

        # Index contact flow modules
        try:
            paginator = connect.get_paginator('list_contact_flow_modules')
            for page in paginator.paginate(InstanceId=instance_id):
                for mod_summary in page.get('ContactFlowModulesSummaryList', []):
                    mod_id = mod_summary['Id']
                    try:
                        detail = connect.describe_contact_flow_module(
                            InstanceId=instance_id,
                            ContactFlowModuleId=mod_id
                        )
                        mod = detail.get('ContactFlowModule', {})
                        content = mod.get('Content', '{}')

                        table.put_item(Item={
                            'Region': reg,
                            'FlowId': f"FLOW_MODULE#{mod_id}",
                            'FlowName': mod.get('Name', mod_summary.get('Name', 'Unknown')),
                            'FlowType': 'MODULE',
                            'ItemType': 'FLOW_MODULE',
                            'Content': content,
                            'LastIndexed': datetime.now(timezone.utc).isoformat(),
                            'FlowArn': mod.get('Arn', ''),
                        })
                        module_count += 1
                    except ClientError as e:
                        if e.response['Error']['Code'] == 'AccessDeniedException':
                            continue
                        raise
        except ClientError as e:
            # Some instances may not have modules — not fatal
            pass

        results[reg] = {
            'flows': flow_count,
            'modules': module_count,
            'total': flow_count + module_count,
            'label': REGION_LABELS.get(reg, reg),
            'timestamp': datetime.now(timezone.utc).isoformat()
        }

    return response(200, {'results': results})


def handle_search(event):
    """Search indexed flows for a query string"""
    params = event.get('queryStringParameters') or {}
    query = params.get('q', '').strip()
    region_filter = params.get('region', 'all')

    if not query or len(query) < 2:
        return response(400, {'error': 'Query must be at least 2 characters'})

    table = dynamodb.Table(TABLE_NAME)
    pattern = re.compile(re.escape(query), re.IGNORECASE)

    # Query by region or scan all
    if region_filter and region_filter != 'all':
        items = query_by_region(table, region_filter)
    else:
        items = scan_all(table)

    matches = []
    for item in items:
        content = item.get('Content', '')
        if not pattern.search(content):
            continue

        # Parse flow JSON to find matching blocks
        context_matches = extract_match_context(content, pattern)

        matches.append({
            'flowName': item.get('FlowName', 'Unknown'),
            'flowType': item.get('FlowType', 'UNKNOWN'),
            'itemType': item.get('ItemType', 'CONTACT_FLOW'),
            'region': item.get('Region', ''),
            'regionLabel': REGION_LABELS.get(item.get('Region', ''), item.get('Region', '')),
            'flowArn': item.get('FlowArn', ''),
            'lastIndexed': item.get('LastIndexed', ''),
            'matches': context_matches,
            'matchCount': len(context_matches),
        })

    matches.sort(key=lambda m: (-m['matchCount'], m['flowName']))

    return response(200, {
        'query': query,
        'region': region_filter,
        'totalMatches': len(matches),
        'results': matches
    })


def handle_status(event):
    """Return index status per region"""
    table = dynamodb.Table(TABLE_NAME)
    status = {}

    for reg in INSTANCE_IDS:
        try:
            items = query_by_region(table, reg)
            if items:
                latest = max(item.get('LastIndexed', '') for item in items)
                flow_count = sum(1 for i in items if i.get('ItemType') == 'CONTACT_FLOW')
                module_count = sum(1 for i in items if i.get('ItemType') == 'FLOW_MODULE')
                status[reg] = {
                    'label': REGION_LABELS.get(reg, reg),
                    'flows': flow_count,
                    'modules': module_count,
                    'total': len(items),
                    'lastIndexed': latest,
                }
            else:
                status[reg] = {
                    'label': REGION_LABELS.get(reg, reg),
                    'flows': 0,
                    'modules': 0,
                    'total': 0,
                    'lastIndexed': None,
                }
        except Exception:
            status[reg] = {
                'label': REGION_LABELS.get(reg, reg),
                'flows': 0,
                'modules': 0,
                'total': 0,
                'lastIndexed': None,
            }

    return response(200, {'regions': status})


def query_by_region(table, region):
    """Query DynamoDB for all flows in a specific region"""
    items = []
    resp = table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key('Region').eq(region)
    )
    items.extend(resp.get('Items', []))
    while resp.get('LastEvaluatedKey'):
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key('Region').eq(region),
            ExclusiveStartKey=resp['LastEvaluatedKey']
        )
        items.extend(resp.get('Items', []))
    return items


def scan_all(table):
    """Scan all items from DynamoDB (used for cross-region search)"""
    items = []
    resp = table.scan()
    items.extend(resp.get('Items', []))
    while resp.get('LastEvaluatedKey'):
        resp = table.scan(ExclusiveStartKey=resp['LastEvaluatedKey'])
        items.extend(resp.get('Items', []))
    return items


def extract_match_context(content_str, pattern):
    """Parse flow JSON and find which blocks contain the search term"""
    context_matches = []
    try:
        flow_data = json.loads(content_str)
    except (json.JSONDecodeError, TypeError):
        # If content isn't valid JSON, do raw string matching with context
        for m in pattern.finditer(content_str):
            start = max(0, m.start() - 50)
            end = min(len(content_str), m.end() + 50)
            snippet = content_str[start:end]
            context_matches.append({
                'blockName': '(raw content)',
                'blockType': 'Unknown',
                'snippet': snippet,
            })
            if len(context_matches) >= 20:
                break
        return context_matches

    # Walk the flow actions/blocks structure
    actions = flow_data.get('Actions', [])
    if not actions and 'modules' in flow_data:
        # Older flow format
        actions = []
        for module in flow_data.get('modules', []):
            actions.append(module)

    for action in actions:
        action_str = json.dumps(action)
        if pattern.search(action_str):
            block_name = (
                action.get('Identifier', '') or
                action.get('id', '') or
                'Unknown Block'
            )
            block_type = (
                action.get('Type', '') or
                action.get('type', '') or
                'Unknown'
            )

            # Extract specific parameter context
            params = action.get('Parameters', action.get('parameters', {}))
            params_str = json.dumps(params, indent=2)

            # Find the matching line(s) in params
            snippets = []
            for line in params_str.split('\n'):
                if pattern.search(line):
                    snippets.append(line.strip())

            # If match is not in params, check metadata or other fields
            if not snippets:
                for key, val in action.items():
                    val_str = json.dumps(val) if not isinstance(val, str) else val
                    if pattern.search(val_str):
                        snippets.append(f'{key}: {val_str[:200]}')

            context_matches.append({
                'blockName': block_name,
                'blockType': block_type,
                'snippet': ' | '.join(snippets[:5]) if snippets else '(match in block metadata)',
            })

    # Also check top-level metadata fields
    metadata = flow_data.get('Metadata', {})
    if metadata:
        meta_str = json.dumps(metadata)
        if pattern.search(meta_str):
            for key, val in metadata.items():
                val_str = json.dumps(val) if not isinstance(val, str) else val
                if pattern.search(val_str):
                    context_matches.append({
                        'blockName': f'Metadata: {key}',
                        'blockType': 'Metadata',
                        'snippet': val_str[:200],
                    })

    # Deduplicate and limit
    seen = set()
    unique = []
    for cm in context_matches:
        key = (cm['blockName'], cm['snippet'])
        if key not in seen:
            seen.add(key)
            unique.append(cm)
        if len(unique) >= 30:
            break

    return unique


def response(status_code, body):
    """Build API Gateway response"""
    return {
        'statusCode': status_code,
        'headers': HEADERS,
        'body': json.dumps(body, default=str)
    }
