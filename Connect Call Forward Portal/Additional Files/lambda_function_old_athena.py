import json
import os
import time
from datetime import datetime, timedelta
from typing import Dict, List, Set, Optional, Any

import boto3

# Initialize AWS clients
athena_client = boto3.client('athena')
connect_client = boto3.client('connect')

ATHENA_DATABASE = 'connect_ctr'
ATHENA_TABLE = 'contact_trace_records'
ATHENA_OUTPUT_LOCATION = f"s3://aws-athena-query-results-{os.environ.get('AWS_REGION', 'us-east-1')}-YOUR_AWS_ACCOUNT_ID/forward-heatmap/"


def lambda_handler(event, context):
    """Lambda handler for Forward Heatmap Portal"""
    print('Event:', json.dumps(event, indent=2))
    
    # CORS headers for Function URL - must allow CloudFront origin
    headers = {
        'Access-Control-Allow-Origin': 'https://your-portal-domain.example.com',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Credentials': 'false',
        'Content-Type': 'application/json'
    }
    
    # Handle different event formats (API Gateway vs Function URL)
    http_method = event.get('httpMethod') or event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    path = event.get('path') or event.get('rawPath') or event.get('requestContext', {}).get('http', {}).get('path', '')
    
    if http_method == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers, 'body': ''}
    
    try:
        if 'flow-data' in path or http_method == 'GET':
            return handle_flow_data(event, headers)
        else:
            return {'statusCode': 404, 'headers': headers, 'body': json.dumps({'error': 'Endpoint not found'})}
    except Exception as error:
        print(f"Error: {str(error)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': 'Internal server error', 'message': str(error)})
        }


def handle_flow_data(event: Dict[str, Any], headers: Dict[str, str]) -> Dict[str, Any]:
    """Handle flow data request - returns agent forward statistics"""
    instance_id = os.environ.get('CONNECT_INSTANCE_ID')
    params = event.get('queryStringParameters') or {}
    
    # Parse queue IDs - handle empty string case
    queue_ids_param = params.get('queueIds', '').strip()
    queue_ids = [qid.strip() for qid in queue_ids_param.split(',') if qid.strip()] if queue_ids_param else []
    
    start_time = params.get('startTime')
    end_time = params.get('endTime')
    
    if not start_time or not end_time:
        return {
            'statusCode': 400,
            'headers': headers,
            'body': json.dumps({'error': 'startTime and endTime required'})
        }
    
    print(f"Querying CTR for agent forwards: {start_time} to {end_time}")
    print(f"Selected queue IDs: {queue_ids}")
    
    # Get all CTR records including transfers
    all_results = fetch_all_ctr_records(start_time, end_time, queue_ids)
    
    if not all_results:
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({
                'totalCalls': 0,
                'agentsWhoForwarded': [],
                'forwardSummary': [],
                'queueStats': []
            })
        }
    
    # Process results to find agents who forwarded calls
    result_data = process_agent_forwards(all_results, queue_ids)
    
    return {
        'statusCode': 200,
        'headers': headers,
        'body': json.dumps(result_data)
    }


def fetch_all_ctr_records(start_time: str, end_time: str, queue_ids: List[str]) -> List[Dict[str, Any]]:
    """Fetch all CTR records including transfers"""
    # Extract year/month for partition filtering
    start_date = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
    end_date = datetime.fromisoformat(end_time.replace('Z', '+00:00'))
    start_year = str(start_date.year)
    start_month = str(start_date.month).zfill(2)
    end_year = str(end_date.year)
    end_month = str(end_date.month).zfill(2)
    
    # Build partition filter
    if start_year == end_year and start_month == end_month:
        partition_filter = f"AND year = '{start_year}' AND month = '{start_month}'"
    elif start_year == end_year:
        partition_filter = f"AND year = '{start_year}' AND month >= '{start_month}' AND month <= '{end_month}'"
    else:
        partition_filter = f"AND ((year = '{start_year}' AND month >= '{start_month}') OR (year = '{end_year}' AND month <= '{end_month}'))"
    
    # Build queue filter - use OR to match any of the selected queues
    queue_filter = ''
    if queue_ids:
        queue_arns = [f"queue.arn LIKE '%/{qid}'" for qid in queue_ids]
        queue_filter = f"AND ({' OR '.join(queue_arns)})"
    
    # Query for contacts in selected queues
    # Use initiationtimestamp to match the date range when calls started
    initial_query = f"""
        SELECT 
            contactid,
            initiationtimestamp,
            queue.arn as queue_arn,
            queue.name as queue_name,
            agent.arn as agent_arn,
            agent.username as agent_username,
            nextcontactid,
            previouscontactid,
            disconnectreason,
            initiationmethod
        FROM {ATHENA_DATABASE}.{ATHENA_TABLE}
        WHERE initiationtimestamp >= '{start_time}'
            AND initiationtimestamp <= '{end_time}'
            {partition_filter}
            {queue_filter}
        ORDER BY initiationtimestamp
        LIMIT 10000
    """
    
    print('Athena Initial Query:', initial_query)
    initial_query_id = start_athena_query(initial_query)
    initial_results = wait_for_query_results(initial_query_id)
    print(f"Retrieved {len(initial_results)} initial CTR records")
    
    # Log date range being queried
    print(f"Date range: {start_time} to {end_time}")
    print(f"Queue IDs: {queue_ids}")
    
    # Debug: Log sample records and distribution
    if initial_results:
        print(f"Sample CTR record: {json.dumps(initial_results[0], indent=2)}")
        
        # Show timestamp range of results
        timestamps = [r.get('initiationtimestamp') for r in initial_results if r.get('initiationtimestamp')]
        if timestamps:
            print(f"Timestamp range in results: {min(timestamps)} to {max(timestamps)}")
        
        # Log initiation method distribution
        initiation_methods = {}
        for r in initial_results:
            method = r.get('initiationmethod', 'UNKNOWN')
            initiation_methods[method] = initiation_methods.get(method, 0) + 1
        print(f"Initiation method distribution: {json.dumps(initiation_methods, indent=2)}")
        # Log all unique queue names found
        unique_queues = set(r.get('queue_name') for r in initial_results if r.get('queue_name'))
        print(f"Unique queues in results: {unique_queues}")
        # Log distribution of records with/without agent
        with_agent = sum(1 for r in initial_results if r.get('agent_username'))
        without_agent = len(initial_results) - with_agent
        print(f"Records with agent: {with_agent}, without agent: {without_agent}")
    
    # Collect all nextcontactid and previouscontactid to build the complete transfer chains
    all_results = initial_results.copy()
    processed_contact_ids = set(r['contactid'] for r in initial_results)
    next_contact_ids = set()
    
    for ctr in initial_results:
        if ctr.get('nextcontactid'):
            next_contact_ids.add(ctr['nextcontactid'])
    
    # Fetch transfer targets
    while next_contact_ids:
        print(f"Fetching {len(next_contact_ids)} transfer targets")
        
        contact_id_list = ', '.join([f"'{cid}'" for cid in next_contact_ids])
        
        # Expand partition filter for transfers (may be in different time periods)
        expanded_start_date = start_date - timedelta(days=60)
        expanded_end_date = end_date + timedelta(days=60)
        
        exp_start_year = str(expanded_start_date.year)
        exp_start_month = str(expanded_start_date.month).zfill(2)
        exp_end_year = str(expanded_end_date.year)
        exp_end_month = str(expanded_end_date.month).zfill(2)
        
        if exp_start_year == exp_end_year:
            expanded_partition_filter = f"AND year = '{exp_start_year}' AND month >= '{exp_start_month}' AND month <= '{exp_end_month}'"
        else:
            expanded_partition_filter = f"AND ((year = '{exp_start_year}' AND month >= '{exp_start_month}') OR (year = '{exp_end_year}' AND month <= '{exp_end_month}'))"
        
        transfer_query = f"""
            SELECT 
                contactid,
                initiationtimestamp,
                queue.arn as queue_arn,
                queue.name as queue_name,
                agent.arn as agent_arn,
                agent.username as agent_username,
                nextcontactid,
                previouscontactid,
                disconnectreason,
                initiationmethod
            FROM {ATHENA_DATABASE}.{ATHENA_TABLE}
            WHERE contactid IN ({contact_id_list})
                {expanded_partition_filter}
            LIMIT 10000
        """
        
        transfer_query_id = start_athena_query(transfer_query)
        transfer_results = wait_for_query_results(transfer_query_id)
        print(f"Retrieved {len(transfer_results)} transfer records")
        
        all_results.extend(transfer_results)
        processed_contact_ids.update(ctr['contactid'] for ctr in transfer_results)
        
        # Collect next level of transfers
        new_next_contact_ids = set()
        for ctr in transfer_results:
            next_id = ctr.get('nextcontactid')
            if next_id and next_id not in processed_contact_ids:
                new_next_contact_ids.add(next_id)
        
        next_contact_ids = new_next_contact_ids
    
    print(f"Total CTR records fetched: {len(all_results)}")
    return all_results


def get_root_contact_id(ctr: Dict[str, Any], contact_map: Dict[str, Dict[str, Any]]) -> str:
    """Walk back through previouscontactid chain to find the root/initial contact ID"""
    current = ctr
    visited = set()  # Prevent infinite loops
    
    while current.get('previouscontactid') and current['previouscontactid'] not in visited:
        visited.add(current['contactid'])
        prev_id = current['previouscontactid']
        prev_ctr = contact_map.get(prev_id)
        if not prev_ctr:
            # Can't find previous contact, return current
            break
        current = prev_ctr
    
    return current['contactid']


def process_agent_forwards(all_results: List[Dict[str, Any]], selected_queue_ids: List[str]) -> Dict[str, Any]:
    """
    Process CTR records to identify agents who forwarded calls.
    
    Logic:
    - Total Calls = ALL CTR records in the selected queue (any initiation method)
    - Forwarded Calls = CTR records where an agent has nextcontactid (agent transferred)
    - Agent who forwarded = The agent in the CTR record with nextcontactid
    """
    # Build contact map for lookup
    contact_map = {ctr['contactid']: ctr for ctr in all_results}
    
    # Filter to only CTRs in selected queues
    queue_contacts = []
    for ctr in all_results:
        if ctr.get('queue_arn'):
            queue_id = ctr['queue_arn'].split('/')[-1]
            if queue_id in selected_queue_ids:
                queue_contacts.append(ctr)
    
    print(f"Found {len(queue_contacts)} CTR records in selected queues")
    
    # Count by initiation method for debugging
    initiation_counts = {}
    for c in queue_contacts:
        method = c.get('initiationmethod', 'UNKNOWN')
        initiation_counts[method] = initiation_counts.get(method, 0) + 1
    print(f"Initiation methods: {initiation_counts}")
    
    # Count records with nextcontactid (these are forwards)
    records_with_next = [c for c in queue_contacts if c.get('nextcontactid')]
    print(f"Records with nextcontactid (forwards): {len(records_with_next)}")
    
    # Track agent forwards
    agent_forward_data = {}  # agent_username -> {forwardCount, forwardedTo: {target: count}}
    forward_summary = {}  # "Agent -> Target" -> count
    queue_misroute_stats = {}  # queue_name -> forward_count
    
    # Total calls = ALL records in the queue
    total_calls = len(queue_contacts)
    total_forwarded = 0
    
    # Process each CTR record that has nextcontactid (meaning it was forwarded)
    for ctr in queue_contacts:
        # Skip if no agent (abandoned calls, etc.)
        if not ctr.get('agent_username'):
            continue
        
        # Check if this agent forwarded the call
        if not ctr.get('nextcontactid'):
            continue
        
        agent_username = ctr['agent_username']
        queue_name = ctr.get('queue_name') or 'Unknown Queue'
        next_ctr = contact_map.get(ctr['nextcontactid'])
        
        total_forwarded += 1
        
        # Track queue misroute stats
        if queue_name not in queue_misroute_stats:
            queue_misroute_stats[queue_name] = 0
        queue_misroute_stats[queue_name] += 1
        
        # Determine forward target
        forward_target = None
        if next_ctr:
            # We found the target contact record
            if next_ctr.get('agent_username'):
                # Agent to Agent
                forward_target = f"Agent: {next_ctr['agent_username']}"
            elif next_ctr.get('queue_name'):
                # Agent to Queue
                forward_target = f"Queue: {next_ctr['queue_name']}"
            else:
                forward_target = "Unknown Target"
        else:
            # Target contact not in our dataset (likely transferred outside our query scope)
            forward_target = "External Transfer"
        
        # Track per-agent data
        if agent_username not in agent_forward_data:
            agent_forward_data[agent_username] = {
                'agentName': agent_username,
                'originQueue': queue_name,
                'forwardCount': 0,
                'forwardedTo': {}
            }
        
        agent_forward_data[agent_username]['forwardCount'] += 1
        
        if forward_target not in agent_forward_data[agent_username]['forwardedTo']:
            agent_forward_data[agent_username]['forwardedTo'][forward_target] = 0
        agent_forward_data[agent_username]['forwardedTo'][forward_target] += 1
        
        # Track summary
        summary_key = f"{agent_username} -> {forward_target}"
        if summary_key not in forward_summary:
            forward_summary[summary_key] = 0
        forward_summary[summary_key] += 1
    
    # Convert to arrays for frontend
    agents_who_forwarded = []
    for agent_username, data in agent_forward_data.items():
        forwarded_to_list = [
            {'target': target, 'count': count}
            for target, count in data['forwardedTo'].items()
        ]
        agents_who_forwarded.append({
            'agentName': data['agentName'],
            'originQueue': data['originQueue'],
            'forwardCount': data['forwardCount'],
            'forwardedTo': forwarded_to_list
        })
    
    # Sort by forward count descending
    agents_who_forwarded.sort(key=lambda x: x['forwardCount'], reverse=True)
    
    forward_summary_list = [
        {'from': key.split(' -> ')[0], 'to': key.split(' -> ')[1], 'count': count}
        for key, count in forward_summary.items()
    ]
    forward_summary_list.sort(key=lambda x: x['count'], reverse=True)
    
    queue_stats_list = [
        {'queueName': queue, 'forwardCount': count}
        for queue, count in queue_misroute_stats.items()
    ]
    queue_stats_list.sort(key=lambda x: x['forwardCount'], reverse=True)
    
    result = {
        'totalCalls': total_calls,
        'totalForwarded': total_forwarded,
        'forwardRate': round((total_forwarded / total_calls * 100), 2) if total_calls > 0 else 0,
        'agentsWhoForwarded': agents_who_forwarded,
        'forwardSummary': forward_summary_list,
        'queueStats': queue_stats_list
    }
    
    print(f"Processed: {len(agents_who_forwarded)} agents forwarded calls")
    return result


def start_athena_query(query: str) -> str:
    """Start an Athena query execution"""
    params = {
        'QueryString': query,
        'QueryExecutionContext': {'Database': ATHENA_DATABASE},
        'ResultConfiguration': {'OutputLocation': ATHENA_OUTPUT_LOCATION}
    }
    
    response = athena_client.start_query_execution(**params)
    return response['QueryExecutionId']


def wait_for_query_results(query_id: str, max_wait_seconds: int = 60) -> List[Dict[str, Any]]:
    """Wait for query to complete and return results"""
    start_time = time.time()
    
    while time.time() - start_time < max_wait_seconds:
        response = athena_client.get_query_execution(QueryExecutionId=query_id)
        state = response['QueryExecution']['Status']['State']
        
        print(f"Query state: {state}")
        
        if state == 'SUCCEEDED':
            return get_query_results(query_id)
        elif state in ['FAILED', 'CANCELLED']:
            reason = response['QueryExecution']['Status'].get('StateChangeReason', 'Unknown')
            raise Exception(f"Query {state}: {reason}")
        
        time.sleep(1)  # Wait 1 second
    
    raise Exception('Query timeout')


def get_query_results(query_id: str) -> List[Dict[str, Any]]:
    """Get results from completed Athena query"""
    response = athena_client.get_query_results(QueryExecutionId=query_id)
    
    rows = response['ResultSet']['Rows']
    if len(rows) <= 1:
        return []  # No data (only header row)
    
    headers = [col['VarCharValue'] for col in rows[0]['Data']]
    results = []
    
    for i in range(1, len(rows)):
        row = {}
        for index, col in enumerate(rows[i]['Data']):
            row[headers[index]] = col.get('VarCharValue')
        results.append(row)
    
    return results


# For local testing
if __name__ == '__main__':
    test_event = {
        'httpMethod': 'GET',
        'path': '/flow-data',
        'queryStringParameters': {
            'startTime': '2024-01-01T00:00:00Z',
            'endTime': '2024-01-31T23:59:59Z'
        }
    }
    result = lambda_handler(test_event, None)
    print(json.dumps(result, indent=2))
