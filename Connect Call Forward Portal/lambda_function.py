import json
import os
import gzip
import io
from datetime import datetime, timedelta
from typing import Dict, List, Any
from concurrent.futures import ThreadPoolExecutor, as_completed
import boto3

# Initialize AWS clients
athena_client = boto3.client('athena')
connect_client = boto3.client('connect')
s3_client = boto3.client('s3')

# S3 bucket where raw CTR JSON files are stored (by Kinesis Firehose)
CTR_S3_BUCKET = f"prod-your-org-connect-events-{os.environ.get('AWS_REGION', 'us-east-1')}-{os.environ.get('AWS_ACCOUNT_ID', 'YOUR_AWS_ACCOUNT_ID')}"
CTR_S3_PREFIX = 'ctr'

ATHENA_DATABASE = 'connect_ctr'
ATHENA_TABLE = 'contact_trace_records'
ATHENA_OUTPUT_LOCATION = f"s3://aws-athena-query-results-{os.environ.get('AWS_REGION', 'us-east-1')}-{os.environ.get('AWS_ACCOUNT_ID', 'YOUR_AWS_ACCOUNT_ID')}/forward-heatmap/"

# Connect instance IDs per region
CONNECT_INSTANCE_IDS = {
    'us-east-1': 'YOUR_CONNECT_INSTANCE_ID',
    'eu-central-1': 'YOUR_CONNECT_INSTANCE_ID',
    'ap-northeast-1': 'YOUR_CONNECT_INSTANCE_ID',
    'ap-southeast-1': 'YOUR_CONNECT_INSTANCE_ID',
}
CURRENT_REGION = os.environ.get('AWS_REGION', 'us-east-1')
CONNECT_INSTANCE_ID = CONNECT_INSTANCE_IDS.get(CURRENT_REGION, CONNECT_INSTANCE_IDS['us-east-1'])

# Quick Connect phone-to-name lookup (built on cold start, cached across invocations)
_qc_phone_cache = None


def _build_quick_connect_phone_map():
    """
    Build phone number -> Quick Connect name mapping by:
    1. List Quick Connects on the transfer queues
    2. Describe each PHONE_NUMBER type to get the configured phone number
    Cached globally so it only runs once per Lambda cold start.
    """
    global _qc_phone_cache
    if _qc_phone_cache is not None:
        return _qc_phone_cache

    phone_map = {}
    transfer_queue_names = os.environ.get('QC_TRANSFER_QUEUES', '').split(',')

    try:
        queue_ids = []
        paginator = connect_client.get_paginator('list_queues')
        for page in paginator.paginate(InstanceId=CONNECT_INSTANCE_ID):
            for q in page.get('QueueSummaryList', []):
                name = q.get('Name', '')
                if any(tq.strip() and tq.strip() in name for tq in transfer_queue_names if tq.strip()):
                    queue_ids.append(q['Id'])
                    print(f"QC lookup: found transfer queue '{name}' ({q['Id']})")

        if not queue_ids:
            print("QC lookup: no transfer queues found, phone map empty")
            _qc_phone_cache = phone_map
            return phone_map

        phone_qc_ids = []
        for qid in queue_ids:
            try:
                paginator_qc = connect_client.get_paginator('list_queue_quick_connects')
                for page in paginator_qc.paginate(InstanceId=CONNECT_INSTANCE_ID, QueueId=qid):
                    for qc in page.get('QuickConnectSummaryList', []):
                        if qc.get('QuickConnectType') == 'PHONE_NUMBER':
                            phone_qc_ids.append((qc['Id'], qc['Name']))
            except Exception as e:
                print(f"QC lookup: error listing QCs for queue {qid}: {e}")

        print(f"QC lookup: found {len(phone_qc_ids)} PHONE_NUMBER Quick Connects")

        for qc_id, qc_name in phone_qc_ids:
            try:
                desc = connect_client.describe_quick_connect(
                    InstanceId=CONNECT_INSTANCE_ID,
                    QuickConnectId=qc_id
                )
                phone = desc['QuickConnect']['QuickConnectConfig'].get('PhoneConfig', {}).get('PhoneNumber', '')
                if phone:
                    phone_map[phone] = qc_name
                    print(f"QC lookup: {phone} -> {qc_name}")
            except Exception as e:
                print(f"QC lookup: error describing {qc_name}: {e}")

        print(f"QC lookup: built phone map with {len(phone_map)} entries")
    except Exception as e:
        print(f"QC lookup: error building phone map: {e}")

    _qc_phone_cache = phone_map
    return phone_map


def lambda_handler(event, context):
    """
    Call Forward Report - Dual Athena Query Architecture
    Two Athena queries run in parallel during the polling phase:
      1. Main query: INBOUND calls handled by agents (with/without transfers)
      2. Transfer chain query: ALL TRANSFER + EXTERNAL_OUTBOUND contacts
    Results are joined in-memory - no DescribeContact calls needed.

    Endpoints:
    - POST /contact-search       -> Start both Athena queries (returns composite queryId)
    - GET  /status/{queryId}     -> Poll status (SUCCEEDED when both done)
    - GET  /results/{queryId}    -> Get results with transfer chain resolution
    """
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Content-Type': 'application/json'
    }

    http_method = event.get('httpMethod') or event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    path = event.get('path') or event.get('rawPath') or event.get('requestContext', {}).get('http', {}).get('path', '')

    if http_method == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers, 'body': ''}

    try:
        if 'status' in path and http_method == 'GET':
            return handle_query_status(event, headers)
        elif 'results' in path and http_method == 'GET':
            return handle_query_results(event, headers)
        elif 'contact-search' in path and http_method == 'POST':
            return handle_start_search(event, headers)
        else:
            return {'statusCode': 404, 'headers': headers, 'body': json.dumps({'error': 'Endpoint not found'})}
    except Exception as error:
        print(f"Error: {str(error)}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': 'Internal server error', 'message': str(error)})
        }


def build_partition_filter(start_time: str, end_time: str) -> str:
    try:
        start_dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
        end_dt = datetime.fromisoformat(end_time.replace('Z', '+00:00'))
    except ValueError:
        start_dt = datetime.fromisoformat(start_time.replace('Z', ''))
        end_dt = datetime.fromisoformat(end_time.replace('Z', ''))

    start_year = str(start_dt.year)
    end_year = str(end_dt.year)
    start_month = f"{start_dt.month:02d}"
    end_month = f"{end_dt.month:02d}"
    start_day = f"{start_dt.day:02d}"
    end_day = f"{end_dt.day:02d}"

    if start_year == end_year and start_month == end_month:
        partition = f"AND year = '{start_year}' AND month = '{start_month}'"
        if (end_dt - start_dt).days <= 7:
            partition += f" AND day BETWEEN '{start_day}' AND '{end_day}'"
        return partition
    elif start_year == end_year:
        return f"AND year = '{start_year}' AND month BETWEEN '{start_month}' AND '{end_month}'"
    else:
        return f"AND year BETWEEN '{start_year}' AND '{end_year}'"


def build_partition_filter_expanded(start_time: str, end_time: str) -> str:
    """Partition filter expanded by +/-1 month to catch transfer chain contacts
    that may land in adjacent partitions."""
    try:
        start_dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
        end_dt = datetime.fromisoformat(end_time.replace('Z', '+00:00'))
    except ValueError:
        start_dt = datetime.fromisoformat(start_time.replace('Z', ''))
        end_dt = datetime.fromisoformat(end_time.replace('Z', ''))

    start_month = max(1, start_dt.month - 1)
    end_month = min(12, end_dt.month + 1)

    if start_dt.year == end_dt.year:
        return f"AND year = '{start_dt.year}' AND month BETWEEN '{start_month:02d}' AND '{end_month:02d}'"
    else:
        return f"AND year BETWEEN '{start_dt.year}' AND '{end_dt.year}'"


def handle_start_search(event, headers):
    """
    POST /contact-search
    Starts TWO Athena queries in parallel:
    1. Main query: INBOUND agent-handled calls
    2. Transfer chain query: ALL TRANSFER + EXTERNAL_OUTBOUND contacts
    Returns composite queryId: "mainId,transferId"
    """
    try:
        body = json.loads(event.get('body', '{}'))
        queue_ids_param = body.get('queueIds', '').strip()
        queue_ids = [qid.strip() for qid in queue_ids_param.split(',') if qid.strip()] if queue_ids_param else []
        agent_usernames_param = body.get('agentUsernames', '').strip()
        agent_usernames = [a.strip() for a in agent_usernames_param.split(',') if a.strip()] if agent_usernames_param else []
        start_time = body.get('startTime')
        end_time = body.get('endTime')

        if not start_time or not end_time:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({'error': 'startTime and endTime required'})
            }

        print(f"Starting query: {start_time} to {end_time}, queues: {queue_ids}, agents: {agent_usernames}")

        # Build queue filter
        queue_filter = ''
        if queue_ids:
            queue_arns = [f"queue.arn LIKE '%/{qid}'" for qid in queue_ids]
            queue_filter = f"AND ({' OR '.join(queue_arns)})"

        # Build agent filter
        agent_filter = ''
        if agent_usernames:
            escaped = [a.replace("'", "''") for a in agent_usernames]
            agent_conditions = [f"agent.username = '{a}'" for a in escaped]
            agent_filter = f"AND ({' OR '.join(agent_conditions)})"

        partition_filter = build_partition_filter(start_time, end_time)

        # Query 1: Main query - INBOUND calls handled by agents
        main_query = f"""
            SELECT 
                contactid,
                initiationtimestamp,
                queue.name as queue_name,
                queue.arn as queue_arn,
                agent.username as agent_username,
                nextcontactid,
                disconnectreason
            FROM {ATHENA_DATABASE}.{ATHENA_TABLE}
            WHERE initiationtimestamp >= '{start_time}'
                AND initiationtimestamp <= '{end_time}'
                AND agent.username IS NOT NULL
                {queue_filter}
                {agent_filter}
                {partition_filter}
        """

        # Query 2: Transfer chain - all TRANSFER + EXTERNAL_OUTBOUND contacts
        # These are children of forwarded calls. We query broadly and filter in-memory.
        transfer_partition = build_partition_filter_expanded(start_time, end_time)
        transfer_query = f"""
            SELECT
                contactid,
                previouscontactid,
                nextcontactid,
                initiationmethod,
                customerendpoint.address as endpoint_phone,
                queue.name as queue_name,
                agent.username as agent_name
            FROM {ATHENA_DATABASE}.{ATHENA_TABLE}
            WHERE initiationmethod IN ('TRANSFER', 'EXTERNAL_OUTBOUND')
                AND previouscontactid IS NOT NULL
                {transfer_partition}
        """

        print(f"Main query:\n{main_query}")
        print(f"Transfer chain query:\n{transfer_query}")

        # Start both queries in parallel
        main_response = athena_client.start_query_execution(
            QueryString=main_query,
            QueryExecutionContext={'Database': ATHENA_DATABASE},
            ResultConfiguration={'OutputLocation': ATHENA_OUTPUT_LOCATION}
        )
        main_id = main_response['QueryExecutionId']

        transfer_response = athena_client.start_query_execution(
            QueryString=transfer_query,
            QueryExecutionContext={'Database': ATHENA_DATABASE},
            ResultConfiguration={'OutputLocation': ATHENA_OUTPUT_LOCATION}
        )
        transfer_id = transfer_response['QueryExecutionId']

        # Composite ID: "mainId,transferId"
        composite_id = f"{main_id},{transfer_id}"
        print(f"Queries started: main={main_id}, transfer={transfer_id}")

        return {
            'statusCode': 202,
            'headers': headers,
            'body': json.dumps({
                'queryId': composite_id,
                'status': 'RUNNING',
                'message': 'Queries started.'
            })
        }
    except Exception as error:
        print(f"Error starting search: {str(error)}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(error)})
        }


def handle_query_status(event, headers):
    """GET /contact-search/status/{queryId}
    Handles composite queryId (mainId,transferId). Returns SUCCEEDED only when both done."""
    try:
        path = event.get('path') or event.get('rawPath', '')
        composite_id = path.split('/')[-1]
        if not composite_id:
            return {'statusCode': 400, 'headers': headers, 'body': json.dumps({'error': 'queryId required'})}

        # Parse composite ID - supports both single and dual query IDs
        query_ids = composite_id.split(',')

        overall_status = 'SUCCEEDED'
        for qid in query_ids:
            qid = qid.strip()
            if not qid:
                continue
            response = athena_client.get_query_execution(QueryExecutionId=qid)
            status = response['QueryExecution']['Status']['State']
            if status in ('FAILED', 'CANCELLED'):
                return {
                    'statusCode': 200,
                    'headers': headers,
                    'body': json.dumps({
                        'queryId': composite_id,
                        'status': status,
                        'statusReason': response['QueryExecution']['Status'].get('StateChangeReason')
                    })
                }
            if status in ('RUNNING', 'QUEUED'):
                overall_status = status

        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({
                'queryId': composite_id,
                'status': overall_status,
                'statusReason': None
            })
        }
    except Exception as error:
        print(f"Error checking status: {str(error)}")
        return {'statusCode': 500, 'headers': headers, 'body': json.dumps({'error': str(error)})}


def fetch_athena_results(query_id: str) -> list:
    """Fetch all rows from an Athena query with pagination."""
    all_rows = []
    next_token = None
    page_count = 0
    while page_count < 20:
        page_count += 1
        kwargs = {'QueryExecutionId': query_id, 'MaxResults': 1000}
        if next_token:
            kwargs['NextToken'] = next_token
        results_response = athena_client.get_query_results(**kwargs)
        all_rows.extend(results_response['ResultSet']['Rows'])
        next_token = results_response.get('NextToken')
        if not next_token:
            break
    return all_rows


def parse_athena_rows(rows: list) -> list:
    """Parse Athena result rows into list of dicts."""
    if len(rows) <= 1:
        return []
    header = [col.get('VarCharValue', '') for col in rows[0]['Data']]
    records = []
    for i in range(1, len(rows)):
        row = {}
        for idx, col in enumerate(rows[i]['Data']):
            row[header[idx]] = col.get('VarCharValue')
        records.append(row)
    return records


def get_connect_total_count(selected_queue_ids: list, start_time: str, end_time: str) -> int:
    """Get accurate total inbound answered call count from Connect SearchContacts API.
    SearchContacts has a max time range of 1345 hours (~56 days). For longer ranges,
    split into chunks."""
    try:
        start_dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
        end_dt = datetime.fromisoformat(end_time.replace('Z', '+00:00'))

        # Max range is 1345 hours (~56 days). Use 50-day chunks for safety.
        max_chunk = timedelta(days=50)
        total = 0
        for qid in selected_queue_ids:
            chunk_start = start_dt
            while chunk_start < end_dt:
                chunk_end = min(chunk_start + max_chunk, end_dt)
                response = connect_client.search_contacts(
                    InstanceId=CONNECT_INSTANCE_ID,
                    TimeRange={
                        'Type': 'CONNECTED_TO_AGENT_TIMESTAMP',
                        'StartTime': chunk_start,
                        'EndTime': chunk_end
                    },
                    SearchCriteria={
                        'QueueIds': [qid],
                        'Channels': ['VOICE'],
                        'InitiationMethods': ['INBOUND']
                    },
                    MaxResults=1
                )
                count = response.get('TotalCount', 0)
                total += count
                chunk_start = chunk_end

            print(f"Connect SearchContacts: {total} inbound answered calls for queue {qid}")

        return total
    except Exception as e:
        print(f"SearchContacts failed: {str(e)} - falling back to Athena count")
        return None


def batch_lookup_ctr_from_s3(contact_time_pairs: list, time_budget_seconds: float = 20.0) -> dict:
    """
    Batch read raw CTR JSON from S3 for multiple contacts at once.
    Groups contacts by S3 hour partition, downloads each file ONCE,
    and searches for ALL contact IDs simultaneously using parallel threads.

    Args:
        contact_time_pairs: list of (contact_id, approximate_time_str) tuples
        time_budget_seconds: max seconds to spend on S3 lookups

    Returns: dict of contact_id -> parsed CTR dict
    """
    if not contact_time_pairs:
        return {}

    results = {}
    all_target_ids = set()

    # Group contacts by hour partitions to search
    partition_contacts = {}  # partition_prefix -> set of contact_ids
    for contact_id, approx_time in contact_time_pairs:
        all_target_ids.add(contact_id)
        try:
            try:
                dt = datetime.fromisoformat(approx_time.replace('Z', '+00:00'))
            except ValueError:
                dt = datetime.fromisoformat(approx_time.replace('Z', ''))

            # Search hour of timestamp, +1h, and +2h (CTR written after call ends)
            for offset in range(3):
                search_dt = dt + timedelta(hours=offset)
                prefix = f"{CTR_S3_PREFIX}/{search_dt.year}/{search_dt.month:02d}/{search_dt.day:02d}/{search_dt.hour:02d}/"
                if prefix not in partition_contacts:
                    partition_contacts[prefix] = set()
                partition_contacts[prefix].add(contact_id)
        except Exception:
            continue

    print(f"S3 batch lookup: {len(all_target_ids)} contacts across {len(partition_contacts)} partitions")

    def search_partition(prefix, target_ids):
        """List + download + search all files in one S3 hour partition."""
        found = {}
        try:
            list_resp = s3_client.list_objects_v2(
                Bucket=CTR_S3_BUCKET, Prefix=prefix, MaxKeys=200
            )
            for file_obj in list_resp.get('Contents', []):
                key = file_obj['Key']
                try:
                    obj = s3_client.get_object(Bucket=CTR_S3_BUCKET, Key=key)
                    body = obj['Body'].read()

                    with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
                        text = gz.read().decode('utf-8')

                    # Quick check: any target IDs in this file?
                    matched = [cid for cid in target_ids if cid in text]
                    if not matched:
                        continue

                    records_raw = text.replace('}{', '}\n{').split('\n')
                    for raw in records_raw:
                        raw = raw.strip()
                        if not raw:
                            continue
                        hit_ids = [cid for cid in matched if cid in raw]
                        if not hit_ids:
                            continue
                        try:
                            record = json.loads(raw)
                            rec_id = record.get('ContactId', '')
                            if rec_id in target_ids:
                                found[rec_id] = record
                        except json.JSONDecodeError:
                            continue
                except Exception:
                    continue
        except Exception:
            pass
        return found

    # Sort partitions by most target contacts first (resolve more contacts sooner)
    sorted_partitions = sorted(partition_contacts.items(), key=lambda x: len(x[1]), reverse=True)

    # Process partitions in parallel with time budget
    try:
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = {
                executor.submit(search_partition, prefix, ids): prefix
                for prefix, ids in sorted_partitions
            }
            for future in as_completed(futures, timeout=time_budget_seconds):
                try:
                    found = future.result()
                    for cid, ctr in found.items():
                        if cid in all_target_ids:
                            results[cid] = ctr
                            all_target_ids.discard(cid)
                            transferred = ctr.get('TransferredToEndpoint', {})
                            if transferred and transferred.get('Address'):
                                print(f"S3 CTR lookup: {cid} -> {transferred['Address']}")
                except Exception:
                    continue
    except TimeoutError:
        remaining = len(all_target_ids) - len(results)
        print(f"S3 batch: time budget ({time_budget_seconds}s) exceeded, {remaining} contacts unresolved")

    found_count = len(results)
    remaining_count = len(all_target_ids)
    print(f"S3 batch lookup: found {found_count}, remaining {remaining_count}")
    return results


def resolve_transfer_chain(forwarded_contacts: list, transfer_records: list) -> dict:
    """
    Resolve transfer destinations using in-memory chain joining.
    
    The transfer chain: INBOUND -> TRANSFER -> EXTERNAL_OUTBOUND
    - INBOUND.nextcontactid = TRANSFER.contactid  
    - TRANSFER.previouscontactid = INBOUND.contactid
    - EXTERNAL_OUTBOUND.previouscontactid = TRANSFER.contactid
    - EXTERNAL_OUTBOUND.endpoint_phone = the dialed number
    
    Returns: dict of nextcontactid -> {queue_name, agent_name, initiation_method}
    """
    # Build lookup maps from transfer chain records
    # Key: contactid -> record  (to find TRANSFER by its contactid)
    transfer_by_id = {}
    # Key: previouscontactid -> list of records  (to find children of a contact)
    children_by_parent = {}
    
    for rec in transfer_records:
        cid = rec.get('contactid', '')
        prev = rec.get('previouscontactid', '')
        if cid:
            transfer_by_id[cid] = rec
        if prev:
            if prev not in children_by_parent:
                children_by_parent[prev] = []
            children_by_parent[prev].append(rec)

    print(f"Transfer chain: {len(transfer_by_id)} records indexed, "
          f"{len(children_by_parent)} parent links")

    # Build QC phone->name map for labeling
    qc_name_map = _build_quick_connect_phone_map()

    # Resolve each forwarded call's transfer destination
    target_info = {}
    resolved_queue = 0
    resolved_agent = 0
    resolved_phone = 0
    unresolved = 0

    for contact in forwarded_contacts:
        next_id = contact.get('nextcontactid')
        if not next_id:
            continue
        
        inbound_id = contact.get('contactid', '')
        
        # Strategy 1: Find the TRANSFER child directly by contactid
        transfer_rec = transfer_by_id.get(next_id)
        
        # Strategy 2: Find children of the INBOUND contact via previouscontactid
        if not transfer_rec:
            children = children_by_parent.get(inbound_id, [])
            for child in children:
                if child.get('initiationmethod') == 'TRANSFER':
                    transfer_rec = child
                    break
        
        if transfer_rec:
            # Check if transfer went to a queue
            dest_queue = transfer_rec.get('queue_name')
            dest_agent = transfer_rec.get('agent_name')
            
            if dest_queue:
                target_info[next_id] = {
                    'queue_name': dest_queue,
                    'agent_name': dest_agent,
                    'initiation_method': 'TRANSFER'
                }
                resolved_queue += 1
                continue
            
            if dest_agent:
                target_info[next_id] = {
                    'queue_name': None,
                    'agent_name': dest_agent,
                    'initiation_method': 'TRANSFER'
                }
                resolved_agent += 1
                continue
            
            # No queue/agent on TRANSFER leg - look for EXTERNAL_OUTBOUND child
            transfer_cid = transfer_rec.get('contactid', '')
            ext_children = children_by_parent.get(transfer_cid, [])
            dialed_phone = None
            for ext in ext_children:
                if ext.get('initiationmethod') == 'EXTERNAL_OUTBOUND':
                    dialed_phone = ext.get('endpoint_phone')
                    break
            
            # Also check TRANSFER's nextcontactid -> EXTERNAL_OUTBOUND
            if not dialed_phone:
                ext_next = transfer_rec.get('nextcontactid')
                if ext_next:
                    ext_rec = transfer_by_id.get(ext_next)
                    if ext_rec and ext_rec.get('initiationmethod') == 'EXTERNAL_OUTBOUND':
                        dialed_phone = ext_rec.get('endpoint_phone')
            
            if dialed_phone:
                qc_name = qc_name_map.get(dialed_phone)
                if qc_name:
                    label = f'{qc_name} ({dialed_phone})'
                else:
                    label = f'External ({dialed_phone})'
                target_info[next_id] = {
                    'queue_name': label,
                    'agent_name': None,
                    'initiation_method': 'EXTERNAL_OUTBOUND'
                }
                resolved_phone += 1
                continue
            
            # TRANSFER with no queue/agent/phone - likely a USER-type Quick Connect
            target_info[next_id] = {
                'queue_name': 'Quick Connect / Direct Transfer',
                'agent_name': None,
                'initiation_method': 'TRANSFER'
            }
            unresolved += 1
        else:
            # No transfer record found in Athena at all
            target_info[next_id] = {
                'queue_name': 'Unknown Destination',
                'agent_name': None,
                'initiation_method': 'UNKNOWN'
            }
            unresolved += 1

    # Fallback Phase 1: DescribeContact ONLY for "Unknown Destination" contacts
    # (truly missing from Athena — could be queue/agent transfers in the data gap)
    unknown_contacts = [
        (c.get('nextcontactid'), c)
        for c in forwarded_contacts
        if c.get('nextcontactid') and
        target_info.get(c['nextcontactid'], {}).get('queue_name') == 'Unknown Destination'
    ]

    if unknown_contacts:
        print(f"DescribeContact for {len(unknown_contacts)} truly-unknown transfers...")
        for next_id, inbound in unknown_contacts:
            try:
                desc = connect_client.describe_contact(
                    InstanceId=CONNECT_INSTANCE_ID, ContactId=next_id
                )
                contact = desc['Contact']

                # Queue transfer
                if contact.get('QueueInfo') and contact['QueueInfo'].get('Id'):
                    try:
                        q = connect_client.describe_queue(
                            InstanceId=CONNECT_INSTANCE_ID,
                            QueueId=contact['QueueInfo']['Id']
                        )
                        target_info[next_id] = {
                            'queue_name': q['Queue']['Name'],
                            'agent_name': None,
                            'initiation_method': 'TRANSFER'
                        }
                        resolved_queue += 1
                        unresolved -= 1
                        continue
                    except Exception:
                        pass

                # Agent transfer
                if contact.get('AgentInfo') and contact['AgentInfo'].get('Id'):
                    try:
                        u = connect_client.describe_user(
                            InstanceId=CONNECT_INSTANCE_ID,
                            UserId=contact['AgentInfo']['Id']
                        )
                        identity = u['User']['IdentityInfo']
                        agent_name = identity.get('Email') or \
                            f"{identity.get('FirstName', '')} {identity.get('LastName', '')}".strip()
                        target_info[next_id] = {
                            'queue_name': None,
                            'agent_name': agent_name,
                            'initiation_method': 'TRANSFER'
                        }
                        resolved_agent += 1
                        unresolved -= 1
                        continue
                    except Exception:
                        pass

            except Exception as e:
                print(f"  DescribeContact failed for {next_id}: {e}")

    # Fallback Phase 2: Batch S3 CTR lookup for ALL remaining unresolved
    # Uses parallel downloads (ThreadPoolExecutor) for speed.
    # Uses the INBOUND contact's initiationtimestamp to estimate S3 partition.
    needs_s3_lookup = []
    for c in forwarded_contacts:
        next_id = c.get('nextcontactid')
        if not next_id:
            continue
        info = target_info.get(next_id, {})
        if info.get('queue_name') in ('Quick Connect / Direct Transfer', 'Unknown Destination'):
            timestamp = c.get('initiationtimestamp', '')
            if timestamp:
                needs_s3_lookup.append((next_id, timestamp))

    if needs_s3_lookup:
        print(f"Batch S3 lookup for {len(needs_s3_lookup)} phone transfers (threaded)...")
        ctr_results = batch_lookup_ctr_from_s3(needs_s3_lookup)

        for next_id, _ in needs_s3_lookup:
            ctr = ctr_results.get(next_id, {})
            transferred_to = ctr.get('TransferredToEndpoint', {})
            if transferred_to and transferred_to.get('Address'):
                dialed_phone = transferred_to['Address']
                qc_name = qc_name_map.get(dialed_phone)
                label = f'{qc_name} ({dialed_phone})' if qc_name else f'External ({dialed_phone})'
                target_info[next_id] = {
                    'queue_name': label,
                    'agent_name': None,
                    'initiation_method': 'EXTERNAL_OUTBOUND'
                }
                resolved_phone += 1
                unresolved -= 1
            else:
                target_info[next_id] = {
                    'queue_name': 'External Transfer',
                    'agent_name': None,
                    'initiation_method': 'TRANSFER'
                }

    print(f"Transfer resolution: queue={resolved_queue}, agent={resolved_agent}, "
          f"phone={resolved_phone}, unresolved={unresolved}")
    return target_info


def handle_query_results(event, headers):
    """
    GET /contact-search/results/{queryId}?queueIds=...&startTime=...&endTime=...
    Handles composite queryId (mainId,transferId).
    Fetches both result sets and joins them in-memory.
    """
    try:
        path = event.get('path') or event.get('rawPath', '')
        composite_id = path.split('/')[-1]
        if not composite_id:
            return {'statusCode': 400, 'headers': headers, 'body': json.dumps({'error': 'queryId required'})}

        params = event.get('queryStringParameters') or {}
        queue_ids_param = params.get('queueIds', '')
        selected_queue_ids = [qid.strip() for qid in queue_ids_param.split(',') if qid.strip()] if queue_ids_param else []
        start_time = params.get('startTime')
        end_time = params.get('endTime')

        # Parse composite ID
        query_ids = [qid.strip() for qid in composite_id.split(',') if qid.strip()]
        main_query_id = query_ids[0]
        transfer_query_id = query_ids[1] if len(query_ids) > 1 else None

        # Verify main query completed
        exec_response = athena_client.get_query_execution(QueryExecutionId=main_query_id)
        status = exec_response['QueryExecution']['Status']['State']
        if status != 'SUCCEEDED':
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({
                    'error': f'Query not completed. Status: {status}',
                    'statusReason': exec_response['QueryExecution']['Status'].get('StateChangeReason')
                })
            }

        # Fetch main query results
        main_rows = fetch_athena_results(main_query_id)
        contacts = parse_athena_rows(main_rows)
        print(f"Main query: {len(contacts)} agent-handled contacts")

        if not contacts:
            return {
                'statusCode': 200,
                'headers': headers,
                'body': json.dumps({
                    'totalCalls': 0, 'totalForwarded': 0, 'forwardRate': 0,
                    'agentsWhoForwarded': [], 'forwardSummary': [], 'queueStats': [],
                    'transferDetails': []
                })
            }

        # Find forwarded contacts
        forwarded = [c for c in contacts if c.get('nextcontactid')]
        print(f"Found {len(forwarded)} forwarded contacts")

        # Resolve transfer destinations
        target_info = {}
        if forwarded and transfer_query_id:
            # Fetch transfer chain results
            transfer_rows = fetch_athena_results(transfer_query_id)
            transfer_records = parse_athena_rows(transfer_rows)
            print(f"Transfer chain query: {len(transfer_records)} TRANSFER/EXTERNAL_OUTBOUND records")

            target_info = resolve_transfer_chain(forwarded, transfer_records)
        elif forwarded:
            # Fallback: no transfer query (shouldn't happen with new code)
            print("WARNING: No transfer query ID - transfers will show as Unknown")
            for c in forwarded:
                nid = c.get('nextcontactid')
                if nid:
                    target_info[nid] = {
                        'queue_name': 'Unknown Destination',
                        'agent_name': None,
                        'initiation_method': 'UNKNOWN'
                    }

        # Get accurate total count
        connect_total = None
        if selected_queue_ids and start_time and end_time:
            connect_total = get_connect_total_count(selected_queue_ids, start_time, end_time)

        result_data = build_transfer_report(contacts, target_info, connect_total)
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps(result_data)
        }
    except Exception as error:
        print(f"Error fetching results: {str(error)}")
        import traceback
        traceback.print_exc()
        return {'statusCode': 500, 'headers': headers, 'body': json.dumps({'error': str(error)})}


def build_transfer_report(contacts, target_info, connect_total=None):
    """Build the transfer report from Athena contacts + resolved transfer target info."""
    total_calls = connect_total if connect_total is not None else len(contacts)
    total_transferred = 0
    agent_data = {}
    target_summary = {}
    transfer_details = []

    for contact in contacts:
        next_id = contact.get('nextcontactid')
        if not next_id:
            continue

        total_transferred += 1
        agent = contact.get('agent_username', 'Unknown')
        source_queue = contact.get('queue_name', 'Unknown')
        timestamp = contact.get('initiationtimestamp', '')

        target = target_info.get(next_id, {})
        target_queue = target.get('queue_name')
        target_agent = target.get('agent_name')
        target_method = target.get('initiation_method', 'UNKNOWN')

        if target_queue:
            target_name = target_queue
        elif target_agent:
            target_name = f'Agent: {target_agent}'
        elif target_method == 'EXTERNAL_OUTBOUND':
            target_name = 'External Transfer'
        elif target_method == 'NOT_FOUND':
            target_name = 'Expired Contact'
        else:
            target_name = 'Unknown Destination'

        if agent not in agent_data:
            agent_data[agent] = {
                'agentName': agent,
                'originQueue': source_queue,
                'forwardCount': 0,
                'forwardedTo': {}
            }
        agent_data[agent]['forwardCount'] += 1
        agent_data[agent]['forwardedTo'][target_name] = agent_data[agent]['forwardedTo'].get(target_name, 0) + 1

        target_summary[target_name] = target_summary.get(target_name, 0) + 1

        transfer_details.append({
            'timestamp': timestamp,
            'contactId': contact.get('contactid', ''),
            'agent': agent,
            'sourceQueue': source_queue,
            'targetQueue': target_name,
            'targetAgent': target_agent or 'N/A',
            'targetContactId': next_id
        })

    agents_list = []
    for agent, data in agent_data.items():
        forwarded_to = [
            {'target': t, 'count': c}
            for t, c in sorted(data['forwardedTo'].items(), key=lambda x: x[1], reverse=True)
        ]
        agents_list.append({
            'agentName': data['agentName'],
            'originQueue': data['originQueue'],
            'forwardCount': data['forwardCount'],
            'forwardedTo': forwarded_to
        })
    agents_list.sort(key=lambda x: x['forwardCount'], reverse=True)

    queue_stats = [
        {'queueName': q, 'forwardCount': c}
        for q, c in sorted(target_summary.items(), key=lambda x: x[1], reverse=True)
    ]

    forward_summary = []
    for agent, data in agent_data.items():
        for target, count in data['forwardedTo'].items():
            forward_summary.append({'from': agent, 'to': target, 'count': count})
    forward_summary.sort(key=lambda x: x['count'], reverse=True)

    transfer_details.sort(key=lambda x: x['timestamp'], reverse=True)

    result = {
        'totalCalls': total_calls,
        'totalForwarded': total_transferred,
        'forwardRate': round((total_transferred / total_calls * 100), 2) if total_calls > 0 else 0,
        'agentsWhoForwarded': agents_list,
        'forwardSummary': forward_summary,
        'queueStats': queue_stats,
        'transferDetails': transfer_details[:500]
    }
    print(f"Report: {total_calls} calls, {total_transferred} transfers ({len(agents_list)} agents)")
    return result
