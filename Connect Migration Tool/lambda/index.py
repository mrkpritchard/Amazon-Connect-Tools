import json
import os
import re
import uuid
import boto3
import botocore
import traceback
from datetime import datetime, timezone


HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Content-Type': 'application/json'
}

# Resource types in dependency order
RESOURCE_TYPES = [
    'hours_of_operations',
    'security_profiles',
    'queues',
    'contact_flows',
    'routing_profiles',
    'quick_connects',
    'predefined_attributes',
    'users',
    'user_proficiencies'
]


def respond(status, body):
    return {'statusCode': status, 'headers': HEADERS, 'body': json.dumps(body, default=str)}


def get_connect_client(region, role_arn=None):
    """Get a Connect client, optionally assuming a cross-account role."""
    if role_arn:
        sts = boto3.client('sts')
        creds = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName='ConnectMigration'
        )['Credentials']
        return boto3.client(
            'connect',
            region_name=region,
            aws_access_key_id=creds['AccessKeyId'],
            aws_secret_access_key=creds['SecretAccessKey'],
            aws_session_token=creds['SessionToken']
        )
    return boto3.client('connect', region_name=region)


def paginate_connect(client, method_name, key, **kwargs):
    """Generic paginator for Connect list APIs."""
    results = []
    paginator_token = None
    while True:
        params = {**kwargs}
        if paginator_token:
            params['NextToken'] = paginator_token
        params['MaxResults'] = 100
        response = getattr(client, method_name)(**params)
        results.extend(response.get(key, []))
        paginator_token = response.get('NextToken')
        if not paginator_token:
            break
    return results


# ─── Discovery Functions ─────────────────────────────────────────────

def discover_hours_of_operations(client, instance_id):
    items = paginate_connect(client, 'list_hours_of_operations', 'HoursOfOperationSummaryList', InstanceId=instance_id)
    return [
        {
            'id': item['Id'],
            'arn': item.get('Arn', ''),
            'name': item['Name'],
            'type': 'hours_of_operations'
        }
        for item in items
    ]


def discover_queues(client, instance_id):
    items = paginate_connect(client, 'list_queues', 'QueueSummaryList', InstanceId=instance_id)
    return [
        {
            'id': item['Id'],
            'arn': item.get('Arn', ''),
            'name': item['Name'],
            'queueType': item.get('QueueType', ''),
            'type': 'queues'
        }
        for item in items
        if item.get('QueueType') != 'AGENT'
    ]


def discover_security_profiles(client, instance_id):
    items = paginate_connect(client, 'list_security_profiles', 'SecurityProfileSummaryList', InstanceId=instance_id)
    return [
        {
            'id': item['Id'],
            'arn': item.get('Arn', ''),
            'name': item['Name'],
            'type': 'security_profiles'
        }
        for item in items
    ]


def discover_routing_profiles(client, instance_id):
    items = paginate_connect(client, 'list_routing_profiles', 'RoutingProfileSummaryList', InstanceId=instance_id)
    return [
        {
            'id': item['Id'],
            'arn': item.get('Arn', ''),
            'name': item['Name'],
            'type': 'routing_profiles'
        }
        for item in items
    ]


def discover_contact_flows(client, instance_id):
    items = paginate_connect(client, 'list_contact_flows', 'ContactFlowSummaryList', InstanceId=instance_id)
    # Return summary data only — content is fetched lazily during replication
    return [
        {
            'id': item['Id'],
            'arn': item.get('Arn', ''),
            'name': item['Name'],
            'flowType': item.get('ContactFlowType', ''),
            'type': 'contact_flows'
        }
        for item in items
    ]


def discover_quick_connects(client, instance_id):
    items = paginate_connect(client, 'list_quick_connects', 'QuickConnectSummaryList', InstanceId=instance_id)
    return [
        {
            'id': item['Id'],
            'arn': item.get('Arn', ''),
            'name': item['Name'],
            'quickConnectType': item.get('QuickConnectType', ''),
            'type': 'quick_connects'
        }
        for item in items
    ]


def discover_users(client, instance_id):
    items = paginate_connect(client, 'list_users', 'UserSummaryList', InstanceId=instance_id)
    return [
        {
            'id': item['Id'],
            'arn': item.get('Arn', ''),
            'name': item.get('Username', ''),
            'type': 'users'
        }
        for item in items
    ]


def discover_predefined_attributes(client, instance_id):
    """List predefined attributes (used for skills-based routing)."""
    items = []
    next_token = None
    while True:
        params = {'InstanceId': instance_id, 'MaxResults': 25}
        if next_token:
            params['NextToken'] = next_token
        resp = client.list_predefined_attributes(**params)
        items.extend(resp.get('PredefinedAttributeSummaryList', []))
        next_token = resp.get('NextToken')
        if not next_token:
            break
    return [
        {
            'id': item['Name'],
            'name': item['Name'],
            'type': 'predefined_attributes'
        }
        for item in items
    ]


def discover_user_proficiencies(client, instance_id):
    """List users that have proficiency assignments."""
    users = paginate_connect(client, 'list_users', 'UserSummaryList', InstanceId=instance_id)
    results = []
    for user in users:
        try:
            profs = paginate_connect(
                client, 'list_user_proficiencies', 'UserProficiencyList',
                InstanceId=instance_id, UserId=user['Id']
            )
            if profs:
                results.append({
                    'id': user['Id'],
                    'arn': user.get('Arn', ''),
                    'name': user.get('Username', ''),
                    'type': 'user_proficiencies',
                    'proficiencyCount': len(profs)
                })
        except Exception:
            pass
    return results


DISCOVER_FN = {
    'hours_of_operations': discover_hours_of_operations,
    'queues': discover_queues,
    'security_profiles': discover_security_profiles,
    'routing_profiles': discover_routing_profiles,
    'contact_flows': discover_contact_flows,
    'quick_connects': discover_quick_connects,
    'predefined_attributes': discover_predefined_attributes,
    'users': discover_users,
    'user_proficiencies': discover_user_proficiencies,
}


# ─── Replication Functions ────────────────────────────────────────────

def _get_source_client(res):
    """Get a Connect client for the source instance from embedded metadata."""
    return get_connect_client(res.get('_sourceRegion', ''), res.get('_sourceRoleArn'))

def _source_instance_id(res):
    return res.get('_sourceInstanceId', '')

def _resolve_id_by_name(client, instance_id, resource_type, source_id, source_name, arn_map):
    """
    Resolve a source resource ID to a target resource ID.
    First checks arn_map (populated during current session).
    Falls back to listing the target instance and matching by name.
    Populates arn_map with the found mapping for future calls.
    """
    mapped = arn_map.get(source_id, '')
    if mapped:
        return mapped

    # Name-based fallback: list target resources and match by name
    list_map = {
        'hours_of_operations': ('list_hours_of_operations', 'HoursOfOperationSummaryList'),
        'queues':              ('list_queues',               'QueueSummaryList'),
        'security_profiles':   ('list_security_profiles',    'SecurityProfileSummaryList'),
        'routing_profiles':    ('list_routing_profiles',     'RoutingProfileSummaryList'),
    }
    if resource_type not in list_map:
        return ''

    method, key = list_map[resource_type]
    items = paginate_connect(client, method, key, InstanceId=instance_id)
    for item in items:
        item_name = item.get('Name') or item.get('Username', '')
        if item_name == source_name:
            target_id = item['Id']
            arn_map[source_id] = target_id  # cache for subsequent lookups
            return target_id
    return ''


def replicate_hours_of_operations(client, instance_id, resources, arn_map):
    results = []
    for res in resources:
        try:
            # Lazy-fetch details from source
            src_client = _get_source_client(res)
            detail = src_client.describe_hours_of_operation(
                InstanceId=_source_instance_id(res),
                HoursOfOperationId=res['id']
            )['HoursOfOperation']

            params = {
                'InstanceId': instance_id,
                'Name': res['name'],
                'TimeZone': detail.get('TimeZone', 'UTC'),
                'Config': detail.get('Config', [])
            }
            if detail.get('Description'):
                params['Description'] = detail['Description']
            resp = client.create_hours_of_operation(**params)
            new_id = resp['HoursOfOperationId']
            new_arn = resp['HoursOfOperationArn']
            arn_map[res['id']] = new_id
            arn_map[res.get('arn', '')] = new_arn
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'targetId': new_id,
                'status': 'success'
            })
        except client.exceptions.DuplicateResourceException:
            # Populate arn_map by name lookup so dependent resources (queues etc.) can find this HoO
            existing_id = _resolve_id_by_name(client, instance_id, 'hours_of_operations', res['id'], res['name'], arn_map)
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'targetId': existing_id or None,
                'status': 'skipped',
                'message': 'Already exists on target'
            })
        except Exception as e:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'failed',
                'error': str(e)
            })
    return results


def replicate_queues(client, instance_id, resources, arn_map):
    results = []
    for res in resources:
        try:
            # Lazy-fetch details from source
            src_client = _get_source_client(res)
            detail = src_client.describe_queue(
                InstanceId=_source_instance_id(res),
                QueueId=res['id']
            )['Queue']

            # Map hours of operation ID — fallback to name-based lookup on target
            hours_id = detail.get('HoursOfOperationId', '')
            # Fetch HoO name from source so we can do name-based fallback on target
            hoo_name = ''
            if hours_id:
                try:
                    hoo_detail = src_client.describe_hours_of_operation(
                        InstanceId=_source_instance_id(res),
                        HoursOfOperationId=hours_id
                    )['HoursOfOperation']
                    hoo_name = hoo_detail.get('Name', '')
                except Exception:
                    pass
            mapped_hours_id = _resolve_id_by_name(client, instance_id, 'hours_of_operations', hours_id, hoo_name, arn_map)
            if not mapped_hours_id:
                results.append({
                    'name': res['name'],
                    'sourceId': res['id'],
                    'status': 'failed',
                    'error': f'Hours of Operation "{hoo_name or hours_id}" not found on target. Migrate it first.'
                })
                continue

            params = {
                'InstanceId': instance_id,
                'Name': res['name'],
                'HoursOfOperationId': mapped_hours_id
            }
            if detail.get('Description'):
                params['Description'] = detail['Description']
            if detail.get('MaxContacts'):
                params['MaxContacts'] = detail['MaxContacts']

            resp = client.create_queue(**params)
            new_id = resp['QueueId']
            new_arn = resp['QueueArn']
            arn_map[res['id']] = new_id
            arn_map[res.get('arn', '')] = new_arn
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'targetId': new_id,
                'status': 'success',
                'notes': 'Outbound caller config skipped (phone numbers/flows not transferable)'
            })
        except client.exceptions.DuplicateResourceException:
            existing_id = _resolve_id_by_name(client, instance_id, 'queues', res['id'], res['name'], arn_map)
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'targetId': existing_id or None,
                'status': 'skipped',
                'message': 'Already exists on target'
            })
        except Exception as e:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'failed',
                'error': str(e)
            })
    return results


def replicate_security_profiles(client, instance_id, resources, arn_map):
    results = []
    for res in resources:
        try:
            # Lazy-fetch details from source
            src_client = _get_source_client(res)
            detail = src_client.describe_security_profile(
                InstanceId=_source_instance_id(res),
                SecurityProfileId=res['id']
            )['SecurityProfile']
            # Get permissions
            perms = []
            try:
                perms = paginate_connect(
                    src_client, 'list_security_profile_permissions',
                    'Permissions',
                    InstanceId=_source_instance_id(res),
                    SecurityProfileId=res['id']
                )
            except Exception:
                pass

            params = {
                'InstanceId': instance_id,
                'SecurityProfileName': res['name'],
            }
            if detail.get('Description'):
                params['Description'] = detail['Description']
            if perms:
                params['Permissions'] = perms

            resp = client.create_security_profile(**params)
            new_id = resp['SecurityProfileId']
            new_arn = resp['SecurityProfileArn']
            arn_map[res['id']] = new_id
            arn_map[res.get('arn', '')] = new_arn
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'targetId': new_id,
                'status': 'success'
            })
        except client.exceptions.DuplicateResourceException:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'skipped',
                'message': 'Already exists on target'
            })
        except Exception as e:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'failed',
                'error': str(e)
            })
    return results


def _find_arns_in_obj(obj, instance_id, found=None):
    """Recursively walk a parsed JSON object and collect all ARNs referencing a specific instance."""
    if found is None:
        found = set()
    if isinstance(obj, str):
        # Match any ARN referencing the specific instance
        for m in re.finditer(r'arn:aws:connect:[^/]+:\d+:instance/' + re.escape(instance_id) + r'/[^"\s,}]+', obj):
            found.add(m.group(0))
    elif isinstance(obj, dict):
        for v in obj.values():
            _find_arns_in_obj(v, instance_id, found)
    elif isinstance(obj, list):
        for item in obj:
            _find_arns_in_obj(item, instance_id, found)
    return found


def _apply_arn_map_to_obj(obj, arn_map):
    """Recursively apply arn_map replacements to all string values in a parsed JSON object."""
    if isinstance(obj, str):
        for src, tgt in arn_map.items():
            if src and tgt and src in obj:
                obj = obj.replace(src, tgt)
        return obj
    elif isinstance(obj, dict):
        return {k: _apply_arn_map_to_obj(v, arn_map) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_apply_arn_map_to_obj(item, arn_map) for item in obj]
    return obj


def _auto_migrate_queue_to_target(src_client, src_instance_id, src_queue_id, src_queue_name,
                                   tgt_client, tgt_instance_id, arn_map, warnings):
    """Auto-migrate a missing queue from source to target. Returns the new target queue ARN, or None."""
    try:
        q_detail = src_client.describe_queue(InstanceId=src_instance_id, QueueId=src_queue_id)['Queue']
        hoo_src_id = q_detail.get('HoursOfOperationId', '')
        hoo_tgt_id = arn_map.get(hoo_src_id, '')

        if not hoo_tgt_id and hoo_src_id:
            hoo_name = ''
            try:
                hoo_det = src_client.describe_hours_of_operation(
                    InstanceId=src_instance_id, HoursOfOperationId=hoo_src_id
                )['HoursOfOperation']
                hoo_name = hoo_det.get('Name', '')
            except Exception:
                pass
            hoo_tgt_id = _resolve_id_by_name(tgt_client, tgt_instance_id, 'hours_of_operations', hoo_src_id, hoo_name, arn_map)
            if not hoo_tgt_id and hoo_name:
                try:
                    hoo_det = src_client.describe_hours_of_operation(
                        InstanceId=src_instance_id, HoursOfOperationId=hoo_src_id
                    )['HoursOfOperation']
                    hoo_params = {
                        'InstanceId': tgt_instance_id,
                        'Name': hoo_name,
                        'TimeZone': hoo_det.get('TimeZone', 'UTC'),
                        'Config': hoo_det.get('Config', [])
                    }
                    if hoo_det.get('Description'):
                        hoo_params['Description'] = hoo_det['Description']
                    hoo_resp = tgt_client.create_hours_of_operation(**hoo_params)
                    hoo_tgt_id = hoo_resp['HoursOfOperationId']
                    arn_map[hoo_src_id] = hoo_tgt_id
                    warnings.append(f'Auto-migrated hours of operation "{hoo_name}" to target')
                except tgt_client.exceptions.DuplicateResourceException:
                    hoo_tgt_id = _resolve_id_by_name(tgt_client, tgt_instance_id, 'hours_of_operations', hoo_src_id, hoo_name, arn_map)
                except Exception as e:
                    warnings.append(f'Could not create HoO "{hoo_name}" for queue "{src_queue_name}": {e}')

        if not hoo_tgt_id:
            # Fallback: use "Basic Hours" (exists on every Connect instance)
            basic = paginate_connect(tgt_client, 'list_hours_of_operations', 'HoursOfOperationSummaryList', InstanceId=tgt_instance_id)
            for b in basic:
                if b.get('Name') == 'Basic Hours':
                    hoo_tgt_id = b['Id']
                    warnings.append(f'Queue "{src_queue_name}": using "Basic Hours" as placeholder HoO')
                    break
        if not hoo_tgt_id:
            warnings.append(f'Cannot auto-migrate queue "{src_queue_name}": no hours of operation on target at all')
            return None

        q_params = {'InstanceId': tgt_instance_id, 'Name': src_queue_name, 'HoursOfOperationId': hoo_tgt_id}
        if q_detail.get('Description'):
            q_params['Description'] = q_detail['Description']
        if q_detail.get('MaxContacts'):
            q_params['MaxContacts'] = q_detail['MaxContacts']

        q_resp = tgt_client.create_queue(**q_params)
        new_id = q_resp['QueueId']
        new_arn = q_resp['QueueArn']
        arn_map[src_queue_id] = new_id
        arn_map[src_queue_id.replace(src_queue_id, new_arn)] = new_arn
        warnings.append(f'Auto-migrated queue "{src_queue_name}" to target')
        return new_arn

    except tgt_client.exceptions.DuplicateResourceException:
        existing_items = paginate_connect(tgt_client, 'list_queues', 'QueueSummaryList', InstanceId=tgt_instance_id)
        for item in existing_items:
            if item.get('Name') == src_queue_name:
                return item.get('Arn', '')
        return None
    except Exception as e:
        warnings.append(f'Auto-migrate queue "{src_queue_name}" failed: {e}')
        return None


def remap_arns_in_flow_content(content_str, arn_map, src_client=None, src_instance_id=None, tgt_client=None, tgt_instance_id=None):
    """Replace source ARNs with target ARNs in flow content JSON.
    Parses the content as JSON and walks the structure to find ARNs, avoiding
    all regex/encoding fragility with string-based scanning.
    """
    warnings = []

    # Parse the flow content JSON
    try:
        content_obj = json.loads(content_str)
    except Exception:
        # If not valid JSON, fall back to plain string replacement
        content_obj = None

    # Map Connect ARN resource path slug to list API
    type_list_map = {
        'queue':               ('list_queues',               'QueueSummaryList'),
        'contact-flow':        ('list_contact_flows',        'ContactFlowSummaryList'),
        'hours-of-operation':  ('list_hours_of_operations',  'HoursOfOperationSummaryList'),
        'operating-hours':     ('list_hours_of_operations',  'HoursOfOperationSummaryList'),
        'routing-profile':     ('list_routing_profiles',     'RoutingProfileSummaryList'),
        'prompt':              ('list_prompts',              'PromptSummaryList'),
        'security-profile':    ('list_security_profiles',    'SecurityProfileSummaryList'),
    }

    describe_map = {
        'queue':              ('describe_queue',              'Queue',            'QueueId'),
        'contact-flow':       ('describe_contact_flow',       'ContactFlow',      'ContactFlowId'),
        'hours-of-operation': ('describe_hours_of_operation', 'HoursOfOperation', 'HoursOfOperationId'),
        'operating-hours':    ('describe_hours_of_operation', 'HoursOfOperation', 'HoursOfOperationId'),
        'routing-profile':    ('describe_routing_profile',    'RoutingProfile',   'RoutingProfileId'),
        'prompt':             ('describe_prompt',             'Prompt',           'PromptId'),
        'security-profile':   ('describe_security_profile',  'SecurityProfile',  'SecurityProfileId'),
    }

    if src_client and src_instance_id and tgt_client and tgt_instance_id:
        # Find all source-instance ARNs by walking the parsed JSON object
        if content_obj is not None:
            src_arns_found = _find_arns_in_obj(content_obj, src_instance_id)
        else:
            # Fallback: regex on the raw string
            src_arns_found = set(re.findall(
                r'arn:aws:connect:[^/]+:\d+:instance/' + re.escape(src_instance_id) + r'/\S+',
                content_str
            ))

        print(f"[remap] src_instance_id={src_instance_id}, source ARNs found={len(src_arns_found)}")
        for a in src_arns_found:
            print(f"[remap]   found: {a}")

        target_list_cache = {}

        for src_arn in src_arns_found:
            try:
                print(f"[remap] PROCESSING: {src_arn}")

                # Already resolved in a previous call
                if src_arn in arn_map and arn_map[src_arn] != src_arn:
                    print(f"[remap]   already in arn_map, skipping")
                    continue

                arn_match = re.search(r':instance/[^/]+/([^/]+)/(.+)', src_arn)
                if not arn_match:
                    print(f"[remap]   no regex match on ARN structure, skipping")
                    continue
                res_type_slug = arn_match.group(1)
                src_res_id    = arn_match.group(2).rstrip('"\\,} ')
                print(f"[remap]   type={res_type_slug}, id={src_res_id}")

                if res_type_slug not in type_list_map:
                    print(f"[remap]   unsupported type, skipping")
                    warnings.append(f'Cannot auto-resolve {res_type_slug} ARN (unsupported type): {src_arn}')
                    continue

                # Fetch resource name from source
                src_name = ''
                try:
                    if res_type_slug in describe_map:
                        desc_method, resp_key, id_param = describe_map[res_type_slug]
                        print(f"[remap]   describing source: {desc_method}({id_param}={src_res_id})")
                        detail = getattr(src_client, desc_method)(
                            InstanceId=src_instance_id,
                            **{id_param: src_res_id}
                        )[resp_key]
                        src_name = detail.get('Name', '')
                        print(f"[remap]   source name='{src_name}'")
                except Exception as e:
                    print(f"[remap]   describe FAILED: {e}")
                    warnings.append(f'Could not fetch name for source resource {res_type_slug}/{src_res_id}: {e}')

                # Fetch target list (cached per type)
                list_method, list_key = type_list_map[res_type_slug]
                if res_type_slug not in target_list_cache:
                    try:
                        print(f"[remap]   listing target {res_type_slug}s...")
                        target_list_cache[res_type_slug] = paginate_connect(
                            tgt_client, list_method, list_key, InstanceId=tgt_instance_id
                        )
                        print(f"[remap]   target has {len(target_list_cache[res_type_slug])} {res_type_slug}(s)")
                    except Exception as list_err:
                        target_list_cache[res_type_slug] = []
                        print(f"[remap]   listing target FAILED: {list_err}")
                        warnings.append(f'Could not list {res_type_slug} on target: {list_err}')
                target_items = target_list_cache[res_type_slug]

                # Try exact name match
                matched = False
                if src_name:
                    for item in target_items:
                        if item.get('Name') == src_name:
                            replacement = item.get('Arn') or item['Id']
                            arn_map[src_arn] = replacement
                            matched = True
                            print(f"[remap]   MATCHED on target → {replacement}")
                            break

                if not matched:
                    # For queues: auto-migrate from source rather than using a placeholder
                    if res_type_slug == 'queue' and src_name and src_client and tgt_client:
                        print(f"[remap]   attempting auto-migrate queue '{src_name}'...")
                        auto_arn = _auto_migrate_queue_to_target(
                            src_client, src_instance_id, src_res_id, src_name,
                            tgt_client, tgt_instance_id, arn_map, warnings
                        )
                        if auto_arn:
                            arn_map[src_arn] = auto_arn
                            matched = True
                            print(f"[remap]   queue AUTO-MIGRATED → {auto_arn}")
                        else:
                            print(f"[remap]   auto-migrate returned None")

                if not matched:
                    # For hours-of-operation: prefer "Basic Hours" as placeholder
                    fallback = None
                    if res_type_slug in ('hours-of-operation', 'operating-hours'):
                        for item in target_items:
                            if item.get('Name') == 'Basic Hours':
                                fallback = item
                                break
                    if not fallback:
                        fallback = target_items[0] if target_items else None
                    if fallback:
                        replacement = fallback.get('Arn') or fallback['Id']
                        arn_map[src_arn] = replacement
                        name_label = f' "{src_name}"' if src_name else ''
                        print(f"[remap]   PLACEHOLDER → {replacement} (using '{fallback.get('Name', '?')}')") 
                        warnings.append(
                            f'PLACEHOLDER: {res_type_slug}{name_label} not found on target — '
                            f'temporarily linked to "{fallback.get("Name", fallback["Id"])}". '
                            f'Re-migrate this flow once the dependency is on the target.'
                        )
                    else:
                        name_label = f' "{src_name}"' if src_name else ''
                        print(f"[remap]   UNRESOLVED - no {res_type_slug} resources on target at all")
                        warnings.append(
                            f'UNRESOLVED: {res_type_slug}{name_label} — '
                            f'no {res_type_slug} resources found on target at all. '
                            f'Migrate {res_type_slug}s first, then re-migrate this flow.'
                        )
            except Exception as loop_err:
                print(f"[remap]   LOOP EXCEPTION for {src_arn}: {loop_err}")
                import traceback as _tb
                print(f"[remap]   TRACEBACK: {_tb.format_exc()}")
                warnings.append(f'Exception resolving {src_arn}: {loop_err}')

    # Apply ARN-keyed replacements only — UUID-keyed entries corrupt ARN strings as substrings
    # e.g. arn_map['76f67412-...'] = 'new-id' would partially mangle
    # 'arn:aws:connect:.../queue/76f67412-...' before the full-ARN entry can replace it
    arn_only_map = {k: v for k, v in arn_map.items() if isinstance(k, str) and k.startswith('arn:')}
    print(f"[remap] applying {len(arn_only_map)} ARN-keyed replacements (arn_map total={len(arn_map)})")
    if content_obj is not None:
        content_obj = _apply_arn_map_to_obj(content_obj, arn_only_map)
        remapped = json.dumps(content_obj)
    else:
        remapped = content_str
        for src, tgt in arn_only_map.items():
            if src and tgt and src in remapped:
                remapped = remapped.replace(src, tgt)

    # Warn about any source-instance ARNs still remaining
    if src_instance_id and src_instance_id in remapped:
        still_unmapped = set(re.findall(
            r'arn:aws:connect:[^/]+:\d+:instance/' + re.escape(src_instance_id) + r'/\S+',
            remapped
        ))
        for arn in still_unmapped:
            warnings.append(f'Unmapped source ARN remaining (manual update needed): {arn}')

    # Warn about Lambda ARNs
    if 'arn:aws:lambda:' in remapped:
        lambda_arns = set(re.findall(r'arn:aws:lambda:[^\s"]+', remapped))
        for arn in lambda_arns:
            warnings.append(f'Lambda ARN (manual update needed): {arn}')

    return remapped, warnings


def replicate_contact_flows(client, instance_id, resources, arn_map):
    results = []
    # Default flows that cannot be created (they already exist on new instance)
    default_flow_types = {'AGENT_HOLD', 'AGENT_TRANSFER', 'AGENT_WHISPER', 'CUSTOMER_HOLD',
                          'CUSTOMER_QUEUE', 'CUSTOMER_WHISPER', 'OUTBOUND_WHISPER', 'QUEUE_TRANSFER'}

    for res in resources:
        try:
            flow_type = res.get('flowType', '')
            content = res.get('content', '')

            # Always build src_client for ARN resolution (needed even when content is pre-loaded)
            src_client = get_connect_client(
                res.get('_sourceRegion', ''),
                res.get('_sourceRoleArn')
            )

            if not content:
                # Lazily fetch content from source (not loaded during discovery for performance)
                try:
                    detail = src_client.describe_contact_flow(
                        InstanceId=res.get('_sourceInstanceId', ''),
                        ContactFlowId=res['id']
                    )['ContactFlow']
                    content = detail.get('Content', '')
                    if not res.get('description'):
                        res['description'] = detail.get('Description', '')
                except Exception as fetch_err:
                    results.append({
                        'name': res['name'],
                        'sourceId': res['id'],
                        'status': 'skipped',
                        'message': f'Could not fetch flow content: {fetch_err}'
                    })
                    continue

            if not content:
                results.append({
                    'name': res['name'],
                    'sourceId': res['id'],
                    'status': 'skipped',
                    'message': 'No flow content available'
                })
                continue

            # Remap ARNs in flow content — with cross-session name-based resolution.
            # Unresolved ARNs are replaced with placeholder ARNs so the flow can still be created.
            remapped_content, warnings = remap_arns_in_flow_content(
                content, arn_map,
                src_client=src_client,
                src_instance_id=res.get('_sourceInstanceId', ''),
                tgt_client=client,
                tgt_instance_id=instance_id
            )

            # --- PRE-CALL DIAGNOSTIC ---
            src_iid = res.get('_sourceInstanceId', '')
            if src_iid and src_iid in remapped_content:
                remaining = remapped_content.count(src_iid)
                print(f"[DIAG] CODE_VERSION=2026-05-06-v3 flow='{res['name']}' "
                      f"SOURCE INSTANCE STILL IN CONTENT! occurrences={remaining}")
                # Dump the arn_map keys that start with 'arn:'
                arn_keys = [k for k in arn_map if isinstance(k, str) and k.startswith('arn:')]
                print(f"[DIAG] arn_map has {len(arn_keys)} ARN-keyed entries, {len(arn_map)} total entries")
                for k in arn_keys:
                    print(f"[DIAG]   {k}  →  {arn_map[k]}")
            else:
                print(f"[DIAG] CODE_VERSION=2026-05-06-v3 flow='{res['name']}' "
                      f"all source ARNs replaced OK")

            params = {
                'InstanceId': instance_id,
                'Name': res['name'],
                'Type': flow_type,
                'Content': remapped_content
            }
            if res.get('description'):
                params['Description'] = res['description']

            resp = client.create_contact_flow(**params)
            new_id = resp['ContactFlowId']
            new_arn = resp['ContactFlowArn']
            arn_map[res['id']] = new_id
            arn_map[res.get('arn', '')] = new_arn

            result = {
                'name': res['name'],
                'sourceId': res['id'],
                'targetId': new_id,
                'status': 'success',
                'flowType': flow_type
            }
            if warnings:
                result['warnings'] = warnings
            results.append(result)

        except client.exceptions.DuplicateResourceException:
            # Flow already exists on target — find its ID and update the content instead
            try:
                existing_flows = paginate_connect(client, 'list_contact_flows', 'ContactFlowSummaryList', InstanceId=instance_id)
                existing = next((f for f in existing_flows if f['Name'] == res['name']), None)
                if not existing:
                    raise Exception('Could not find existing flow to update')
                existing_id = existing['Id']
                existing_arn = existing.get('Arn', '')

                # Re-remap with the now-known existing flow in arn_map
                arn_map[res['id']] = existing_id
                arn_map[res.get('arn', '')] = existing_arn
                remapped_content, warnings = remap_arns_in_flow_content(
                    content, arn_map,
                    src_client=src_client,
                    src_instance_id=res.get('_sourceInstanceId', ''),
                    tgt_client=client,
                    tgt_instance_id=instance_id
                )

                client.update_contact_flow_content(
                    InstanceId=instance_id,
                    ContactFlowId=existing_id,
                    Content=remapped_content
                )
                result = {
                    'name': res['name'],
                    'sourceId': res['id'],
                    'targetId': existing_id,
                    'status': 'success',
                    'notes': 'Updated existing flow',
                    'flowType': flow_type
                }
                if warnings:
                    result['warnings'] = warnings
                results.append(result)
            except Exception as update_err:
                results.append({
                    'name': res['name'],
                    'sourceId': res['id'],
                    'status': 'skipped',
                    'message': f'Already exists on target (update failed: {update_err})'
                })
        except botocore.exceptions.ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', '')
            if error_code == 'InvalidContactFlowException':
                # Log the full response for debugging
                import json as _json
                print(f"InvalidContactFlowException response: {_json.dumps(e.response, default=str)}")
                # Extract problems from the HTTP response body
                problems = e.response.get('problems', e.response.get('Problems', []))
                if problems:
                    msgs = [p.get('message', p.get('Message', str(p))) for p in problems]
                    error_msg = 'Invalid flow: ' + '; '.join(msgs)
                else:
                    # Try to get detail from the parsed error message
                    error_msg = e.response.get('Error', {}).get('Message', '') or str(e)
                    if not error_msg or error_msg.endswith(':'):
                        # Log the full response for debugging
                        error_msg = f'Invalid flow content (no detail from AWS). Full response keys: {list(e.response.keys())}. Check Lambda logs for the raw flow content.'
            else:
                error_msg = str(e)
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'failed',
                'flowType': res.get('flowType', ''),
                'error': error_msg
            })
        except Exception as e:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'failed',
                'flowType': res.get('flowType', ''),
                'error': str(e)
            })
    return results


def replicate_routing_profiles(client, instance_id, resources, arn_map):
    results = []
    for res in resources:
        try:
            # Lazy-fetch details from source
            src_client = _get_source_client(res)
            detail = src_client.describe_routing_profile(
                InstanceId=_source_instance_id(res),
                RoutingProfileId=res['id']
            )['RoutingProfile']
            queue_configs_raw = paginate_connect(
                src_client, 'list_routing_profile_queues',
                'RoutingProfileQueueConfigSummaryList',
                InstanceId=_source_instance_id(res),
                RoutingProfileId=res['id']
            )

            # Map default outbound queue — fallback to name-based lookup on target
            default_queue_id = detail.get('DefaultOutboundQueueId', '')
            # Get the queue name from source for fallback resolution
            default_queue_name = ''
            if default_queue_id:
                try:
                    q_detail = src_client.describe_queue(
                        InstanceId=_source_instance_id(res),
                        QueueId=default_queue_id
                    )['Queue']
                    default_queue_name = q_detail.get('Name', '')
                except Exception:
                    pass
            default_queue = _resolve_id_by_name(client, instance_id, 'queues', default_queue_id, default_queue_name, arn_map)
            if not default_queue:
                results.append({
                    'name': res['name'],
                    'sourceId': res['id'],
                    'status': 'failed',
                    'error': f'Default outbound queue "{default_queue_name or default_queue_id}" not found on target. Migrate queues first.'
                })
                continue

            # Map queue configs — fallback to name-based lookup for each queue
            queue_configs = []
            skipped_queues = []
            for qc in queue_configs_raw:
                queue_id = qc.get('QueueId', '')
                queue_name = qc.get('QueueName', '')
                mapped_queue = _resolve_id_by_name(client, instance_id, 'queues', queue_id, queue_name, arn_map)
                if mapped_queue:
                    queue_configs.append({
                        'QueueReference': {
                            'QueueId': mapped_queue,
                            'Channel': qc.get('Channel', 'VOICE')
                        },
                        'Priority': qc.get('Priority', 1),
                        'Delay': qc.get('Delay', 0)
                    })
                else:
                    skipped_queues.append(qc.get('QueueName', queue_id))

            params = {
                'InstanceId': instance_id,
                'Name': res['name'],
                'DefaultOutboundQueueId': default_queue,
                'MediaConcurrencies': detail.get('MediaConcurrencies', [
                    {'Channel': 'VOICE', 'Concurrency': 1}
                ])
            }
            if detail.get('Description'):
                params['Description'] = detail['Description']
            if queue_configs:
                params['QueueConfigs'] = queue_configs

            resp = client.create_routing_profile(**params)
            new_id = resp['RoutingProfileId']
            new_arn = resp['RoutingProfileArn']
            arn_map[res['id']] = new_id
            arn_map[res.get('arn', '')] = new_arn

            result = {
                'name': res['name'],
                'sourceId': res['id'],
                'targetId': new_id,
                'status': 'success'
            }
            if skipped_queues:
                result['warnings'] = [f'Unmapped queue skipped: {q}' for q in skipped_queues]
            results.append(result)

        except client.exceptions.DuplicateResourceException:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'skipped',
                'message': 'Already exists on target'
            })
        except Exception as e:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'failed',
                'error': str(e)
            })
    return results


def replicate_quick_connects(client, instance_id, resources, arn_map):
    results = []
    for res in resources:
        try:
            # Lazy-fetch details from source
            src_client = _get_source_client(res)
            detail = src_client.describe_quick_connect(
                InstanceId=_source_instance_id(res),
                QuickConnectId=res['id']
            )['QuickConnect']

            qc_config = detail.get('QuickConnectConfig', {})
            qc_type = qc_config.get('QuickConnectType', '')

            # Remap internal references
            if qc_type == 'QUEUE' and 'QueueConfig' in qc_config:
                queue_id = qc_config['QueueConfig'].get('QueueId', '')
                mapped = arn_map.get(queue_id)
                if mapped:
                    qc_config['QueueConfig']['QueueId'] = mapped
                flow_id = qc_config['QueueConfig'].get('ContactFlowId', '')
                mapped_flow = arn_map.get(flow_id)
                if mapped_flow:
                    qc_config['QueueConfig']['ContactFlowId'] = mapped_flow

            elif qc_type == 'USER' and 'UserConfig' in qc_config:
                user_id = qc_config['UserConfig'].get('UserId', '')
                mapped = arn_map.get(user_id)
                if mapped:
                    qc_config['UserConfig']['UserId'] = mapped
                flow_id = qc_config['UserConfig'].get('ContactFlowId', '')
                mapped_flow = arn_map.get(flow_id)
                if mapped_flow:
                    qc_config['UserConfig']['ContactFlowId'] = mapped_flow

            params = {
                'InstanceId': instance_id,
                'Name': res['name'],
                'QuickConnectConfig': qc_config
            }
            if detail.get('Description'):
                params['Description'] = detail['Description']

            resp = client.create_quick_connect(**params)
            new_id = resp['QuickConnectId']
            new_arn = resp.get('QuickConnectARN', '')
            arn_map[res['id']] = new_id
            if new_arn:
                arn_map[res.get('arn', '')] = new_arn
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'targetId': new_id,
                'status': 'success'
            })
        except client.exceptions.DuplicateResourceException:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'skipped',
                'message': 'Already exists on target'
            })
        except Exception as e:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'failed',
                'error': str(e)
            })
    return results


def replicate_users(client, instance_id, resources, arn_map):
    results = []
    for res in resources:
        try:
            # Lazy-fetch details from source
            src_client = _get_source_client(res)
            detail = src_client.describe_user(
                InstanceId=_source_instance_id(res),
                UserId=res['id']
            )['User']
            identity = detail.get('IdentityInfo', {})

            # Map routing profile
            routing_id = arn_map.get(detail.get('RoutingProfileId', ''), '')
            if not routing_id:
                results.append({
                    'name': res['name'],
                    'sourceId': res['id'],
                    'status': 'failed',
                    'error': 'Routing profile not migrated. Migrate routing profiles first.'
                })
                continue

            # Map security profiles
            sec_ids = []
            for sp_id in detail.get('SecurityProfileIds', []):
                mapped = arn_map.get(sp_id)
                if mapped:
                    sec_ids.append(mapped)
            if not sec_ids:
                results.append({
                    'name': res['name'],
                    'sourceId': res['id'],
                    'status': 'failed',
                    'error': 'No security profiles mapped. Migrate security profiles first.'
                })
                continue

            phone_config = detail.get('PhoneConfig', {})
            params = {
                'InstanceId': instance_id,
                'Username': res['name'],
                'RoutingProfileId': routing_id,
                'SecurityProfileIds': sec_ids,
                'PhoneConfig': {
                    'PhoneType': phone_config.get('PhoneType', 'SOFT_PHONE'),
                    'AutoAccept': phone_config.get('AutoAccept', False),
                    'AfterContactWorkTimeLimit': phone_config.get('AfterContactWorkTimeLimit', 0)
                }
            }

            identity_info = {}
            if identity.get('FirstName'):
                identity_info['FirstName'] = identity['FirstName']
            if identity.get('LastName'):
                identity_info['LastName'] = identity['LastName']
            if identity.get('Email'):
                identity_info['Email'] = identity['Email']
            if identity_info:
                params['IdentityInfo'] = identity_info

            # Password required for new users — use a temp password
            params['Password'] = 'TempMigration#2026!'

            resp = client.create_user(**params)
            new_id = resp['UserId']
            new_arn = resp['UserArn']
            arn_map[res['id']] = new_id
            arn_map[res.get('arn', '')] = new_arn
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'targetId': new_id,
                'status': 'success',
                'notes': 'User created with temporary password. Password reset required.'
            })
        except client.exceptions.DuplicateResourceException:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'skipped',
                'message': 'Already exists on target'
            })
        except Exception as e:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'failed',
                'error': str(e)
            })
    return results


def replicate_predefined_attributes(client, instance_id, resources, arn_map):
    results = []
    for res in resources:
        try:
            src_client = _get_source_client(res)
            detail = src_client.describe_predefined_attribute(
                InstanceId=_source_instance_id(res),
                Name=res['name']
            )['PredefinedAttribute']

            params = {
                'InstanceId': instance_id,
                'Name': res['name'],
                'Values': detail.get('Values', {})
            }

            client.create_predefined_attribute(**params)
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'success'
            })
        except client.exceptions.DuplicateResourceException:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'skipped',
                'message': 'Already exists on target'
            })
        except Exception as e:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'failed',
                'error': str(e)
            })
    return results


def replicate_user_proficiencies(client, instance_id, resources, arn_map):
    results = []
    target_users = None
    for res in resources:
        try:
            src_client = _get_source_client(res)

            # Fetch proficiencies from source
            proficiencies = paginate_connect(
                src_client, 'list_user_proficiencies', 'UserProficiencyList',
                InstanceId=_source_instance_id(res), UserId=res['id']
            )

            if not proficiencies:
                results.append({
                    'name': res['name'],
                    'sourceId': res['id'],
                    'status': 'skipped',
                    'message': 'No proficiencies to migrate'
                })
                continue

            # Find matching user on target by username
            if target_users is None:
                target_users = paginate_connect(
                    client, 'list_users', 'UserSummaryList', InstanceId=instance_id
                )
            target_user = next(
                (u for u in target_users if u.get('Username') == res['name']), None
            )

            if not target_user:
                results.append({
                    'name': res['name'],
                    'sourceId': res['id'],
                    'status': 'failed',
                    'error': f'User "{res["name"]}" not found on target. Migrate users first.'
                })
                continue

            prof_items = [
                {
                    'AttributeName': p['AttributeName'],
                    'AttributeValue': p['AttributeValue'],
                    'Level': float(p['Level'])
                }
                for p in proficiencies
            ]

            # AssociateUserProficiencies accepts max 10 items per call
            for i in range(0, len(prof_items), 10):
                batch = prof_items[i:i + 10]
                client.associate_user_proficiencies(
                    InstanceId=instance_id,
                    UserId=target_user['Id'],
                    UserProficiencies=batch
                )

            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'targetId': target_user['Id'],
                'status': 'success',
                'notes': f'{len(prof_items)} proficiencies assigned'
            })
        except Exception as e:
            results.append({
                'name': res['name'],
                'sourceId': res['id'],
                'status': 'failed',
                'error': str(e)
            })
    return results


REPLICATE_FN = {
    'hours_of_operations': replicate_hours_of_operations,
    'queues': replicate_queues,
    'security_profiles': replicate_security_profiles,
    'routing_profiles': replicate_routing_profiles,
    'contact_flows': replicate_contact_flows,
    'quick_connects': replicate_quick_connects,
    'predefined_attributes': replicate_predefined_attributes,
    'users': replicate_users,
    'user_proficiencies': replicate_user_proficiencies,
}


# ─── Audit Log ───────────────────────────────────────────────────────────────

def write_audit_log(user_email, source, target, resource_type, summary):
    """Write an audit log entry to DynamoDB. Silently skips on failure."""
    table_name = os.environ.get('AUDIT_TABLE_NAME')
    if not table_name:
        return
    try:
        now = datetime.now(timezone.utc)
        log_id = now.strftime('%Y%m%d-%H%M%S') + '-' + str(uuid.uuid4())[:8]
        expires_at = int(now.timestamp()) + (90 * 24 * 60 * 60)  # 90-day TTL
        boto3.resource('dynamodb').Table(table_name).put_item(Item={
            'logId': log_id,
            'timestamp': now.isoformat(),
            'userEmail': user_email or 'unknown',
            'sourceRegion': source.get('region', ''),
            'sourceInstanceId': source.get('instanceId', ''),
            'targetRegion': target.get('region', ''),
            'targetInstanceId': target.get('instanceId', ''),
            'resourceType': resource_type,
            'success': int(summary.get('success', 0)),
            'failed': int(summary.get('failed', 0)),
            'skipped': int(summary.get('skipped', 0)),
            'expiresAt': expires_at
        })
    except Exception:
        pass


# ─── Migration Report Persistence ────────────────────────────────────────────

def write_report_results(user_email, source, target, resource_type, results, batch_id):
    """Write individual migration results to the MigrationReport table."""
    table_name = os.environ.get('REPORT_TABLE_NAME')
    if not table_name:
        return
    now = datetime.now(timezone.utc)
    expires_at = int(now.timestamp()) + (365 * 24 * 60 * 60)  # 365-day TTL
    table = boto3.resource('dynamodb').Table(table_name)
    for r in results:
        try:
            notes_parts = []
            if r.get('error'): notes_parts.append(r['error'])
            if r.get('message'): notes_parts.append(r['message'])
            if r.get('notes'): notes_parts.append(r['notes'])
            if r.get('warnings'): notes_parts.extend(r['warnings'])
            table.put_item(Item={
                'resultId': str(uuid.uuid4()),
                'batchId': batch_id,
                'timestamp': now.isoformat(),
                'userEmail': user_email or 'unknown',
                'resourceType': resource_type,
                'name': r.get('name', ''),
                'status': r.get('status', ''),
                'sourceId': r.get('sourceId', ''),
                'targetId': r.get('targetId', ''),
                'flowType': r.get('flowType', ''),
                'notes': '; '.join(notes_parts) if notes_parts else '',
                'sourceRegion': source.get('region', ''),
                'sourceInstanceId': source.get('instanceId', ''),
                'targetRegion': target.get('region', ''),
                'targetInstanceId': target.get('instanceId', ''),
                'expiresAt': expires_at
            })
        except Exception:
            pass


def handle_get_report():
    """Return all migration report results sorted newest first."""
    table_name = os.environ.get('REPORT_TABLE_NAME')
    if not table_name:
        return respond(200, {'results': []})
    try:
        table = boto3.resource('dynamodb').Table(table_name)
        items = []
        resp = table.scan()
        items.extend(resp.get('Items', []))
        while 'LastEvaluatedKey' in resp:
            resp = table.scan(ExclusiveStartKey=resp['LastEvaluatedKey'])
            items.extend(resp.get('Items', []))
        items.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
        return respond(200, {'results': items})
    except Exception as e:
        return respond(500, {'error': str(e)})


# ─── Flow Validation ─────────────────────────────────────────────────────────

SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

_UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


def _block_name(action):
    """Return a short human-readable label for a flow block."""
    identifier = action.get('Identifier', '')
    if _UUID_RE.match(identifier):
        return f'Block {identifier[:8]}…'
    return identifier


def run_flow_checks(content_obj, connect_client, lambda_client, instance_id):
    """
    Run static analysis checks on a parsed flow content object.
    Returns a list of finding dicts: {severity, rule, message, blockName}
    """
    findings = []
    actions_list = content_obj.get('Actions', [])

    # Index by identifier for quick lookup
    disconnect_ids = {
        a['Identifier']
        for a in actions_list
        if a.get('Type') == 'DisconnectParticipant'
    }

    # Track Lambda ARNs already checked to avoid duplicate API calls
    checked_lambdas = {}

    def add(severity, rule, message, block_name=''):
        findings.append({
            'severity': severity,
            'rule': rule,
            'message': message,
            'blockName': block_name
        })

    for action in actions_list:
        atype = action.get('Type', '')
        bname = _block_name(action)
        params = action.get('Parameters', {})
        errors = action.get('Transitions', {}).get('Errors', [])

        # ── Check: Invalid nested JSONPath in Compare blocks ─────────────────
        # Amazon Connect resolves $.Attributes.X or $.External.X but NOT $.Attributes.$.External.X
        if atype == 'Compare':
            comp_val = params.get('ComparisonValue', '')
            if comp_val.count('$.') > 1:
                add('critical', 'invalid_jsonpath',
                    f'Invalid JSONPath: "{comp_val}" — contains nested "$." which Amazon Connect '
                    f'cannot resolve. This condition will never match, making the block non-functional.',
                    bname)

        # ── Check: Lambda function exists ─────────────────────────────────────
        if atype == 'InvokeLambdaFunction':
            arn = params.get('LambdaFunctionARN', '')
            if arn and arn not in checked_lambdas:
                try:
                    lambda_client.get_function_configuration(FunctionName=arn)
                    checked_lambdas[arn] = True
                except lambda_client.exceptions.ResourceNotFoundException:
                    checked_lambdas[arn] = False
                    fn_name = arn.split(':')[-1]
                    add('high', 'lambda_not_found',
                        f'Lambda function does not exist: "{fn_name}" — invocation will always fail.',
                        bname)
                except Exception as e:
                    checked_lambdas[arn] = None
                    add('low', 'lambda_check_failed',
                        f'Could not verify Lambda "{arn.split(":")[-1]}": {str(e)[:100]}',
                        bname)

        # ── Check: Lambda timeout is dangerously short ────────────────────────
        if atype == 'InvokeLambdaFunction':
            try:
                t = int(params.get('InvocationTimeLimitSeconds', '8'))
                if t <= 3:
                    add('medium', 'lambda_timeout_risk',
                        f'Lambda timeout is {t}s — cold starts can exceed 3s. '
                        f'Consider increasing to 5-8s to prevent spurious errors.',
                        bname)
            except (ValueError, TypeError):
                pass

        # ── Check: Target queue exists ────────────────────────────────────────
        if atype == 'UpdateContactTargetQueue':
            queue_ref = params.get('QueueId', '')
            if queue_ref:
                queue_id = queue_ref.split('/')[-1] if '/' in queue_ref else queue_ref
                try:
                    connect_client.describe_queue(InstanceId=instance_id, QueueId=queue_id)
                except connect_client.exceptions.ResourceNotFoundException:
                    add('high', 'queue_not_found',
                        f'Queue does not exist (ID: …{queue_id[-12:]}) — calls cannot be routed to queue.',
                        bname)
                except Exception:
                    pass

        # ── Check: Referenced queue flow exists ───────────────────────────────
        if atype == 'UpdateContactEventHooks':
            hooks = params.get('EventHooks', {})
            qf_arn = hooks.get('CustomerQueue', '')
            if qf_arn and 'contact-flow/' in qf_arn:
                flow_id = qf_arn.split('contact-flow/')[-1].rstrip('"\\,} ')
                try:
                    qf = connect_client.describe_contact_flow(
                        InstanceId=instance_id, ContactFlowId=flow_id
                    )['ContactFlow']
                    if qf.get('State') != 'ACTIVE' or qf.get('Status') != 'PUBLISHED':
                        add('medium', 'queue_flow_not_published',
                            f'Queue flow "{qf.get("Name", flow_id)}" is not active/published '
                            f'(State: {qf.get("State","?")}, Status: {qf.get("Status","?")}).',
                            bname)
                except connect_client.exceptions.ResourceNotFoundException:
                    add('high', 'queue_flow_not_found',
                        f'Referenced queue flow does not exist (ID: …{flow_id[-12:]}) — '
                        f'callers will not hear hold music or position announcements.',
                        bname)
                except Exception:
                    pass

        # ── Check: Hours of operation schedule exists ─────────────────────────
        if atype == 'CheckHoursOfOperation':
            hoo_ref = params.get('HoursOfOperationId', '')
            if hoo_ref:
                if 'operating-hours/' in hoo_ref:
                    hoo_id = hoo_ref.split('operating-hours/')[-1].rstrip('"\\,} ')
                else:
                    hoo_id = hoo_ref.split('/')[-1]
                try:
                    connect_client.describe_hours_of_operation(
                        InstanceId=instance_id, HoursOfOperationId=hoo_id
                    )
                except connect_client.exceptions.ResourceNotFoundException:
                    add('high', 'hoo_not_found',
                        f'Hours of Operation schedule does not exist (ID: …{hoo_id[-12:]}) — '
                        f'the schedule check will always fail.',
                        bname)
                except Exception:
                    pass

        # ── Check: Error paths that silently disconnect the caller ─────────────
        # Only flag non-queue-flow blocks (queue flows legitimately disconnect on error)
        if errors and atype not in ('DisconnectParticipant', 'TransferContactToQueue'):
            for err in errors:
                if err.get('NextAction') in disconnect_ids:
                    add('medium', 'silent_error_disconnect',
                        f'Error "{err.get("ErrorType", "?")} " routes directly to Disconnect — '
                        f'caller hears silence before being cut off. '
                        f'Add a Play Prompt block to explain the issue.',
                        bname)

        # ── Check: Queue full → silent disconnect ─────────────────────────────
        if atype == 'TransferContactToQueue':
            for err in errors:
                if err.get('ErrorType') == 'QueueAtCapacity' and err.get('NextAction') in disconnect_ids:
                    add('medium', 'queue_full_disconnect',
                        f'When queue is full, caller is disconnected without any message. '
                        f'Add a "Sorry, all agents are busy — please try again later" prompt.',
                        bname)

    # ── Check: Flow logging not enabled ───────────────────────────────────────
    has_logging = any(
        a.get('Type') == 'UpdateFlowLoggingBehavior' and
        a.get('Parameters', {}).get('FlowLoggingBehavior') == 'Enabled'
        for a in actions_list
    )
    if not has_logging:
        add('info', 'no_logging',
            'Flow logging is not enabled. Add a "Set logging behaviour → Enabled" block '
            'at the start of the flow to see detailed execution traces in CloudWatch.')

    return findings


def handle_validate_flow(body, user_email=''):
    """Validate a single contact flow and persist the results."""
    region = body.get('region')
    instance_id = body.get('instanceId')
    role_arn = body.get('roleArn')
    flow_id = body.get('flowId')

    if not region or not instance_id or not flow_id:
        return respond(400, {'error': 'region, instanceId, and flowId are required'})

    try:
        connect_client = get_connect_client(region, role_arn)
        lambda_client = boto3.client('lambda', region_name=region)

        detail = connect_client.describe_contact_flow(
            InstanceId=instance_id,
            ContactFlowId=flow_id
        )['ContactFlow']
        flow_name = detail.get('Name', flow_id)
        flow_type = detail.get('Type', '')

        try:
            content_obj = json.loads(detail.get('Content', '{}'))
        except Exception:
            return respond(400, {'error': 'Flow content is not valid JSON'})

        findings = run_flow_checks(content_obj, connect_client, lambda_client, instance_id)

        counts = {s: 0 for s in SEVERITY_ORDER}
        for f in findings:
            counts[f['severity']] = counts.get(f['severity'], 0) + 1

        now = datetime.now(timezone.utc).isoformat()
        validation_key = f'{region}#{instance_id}#{flow_id}'

        table_name = os.environ.get('VALIDATION_TABLE_NAME')
        if table_name:
            try:
                expires_at = int(datetime.now(timezone.utc).timestamp()) + (90 * 24 * 60 * 60)
                boto3.resource('dynamodb').Table(table_name).put_item(Item={
                    'validationKey': validation_key,
                    'flowId': flow_id,
                    'flowName': flow_name,
                    'flowType': flow_type,
                    'region': region,
                    'instanceId': instance_id,
                    'checkedAt': now,
                    'checkedBy': user_email or 'unknown',
                    'findings': json.dumps(findings, default=str),
                    'criticalCount': counts['critical'],
                    'highCount': counts['high'],
                    'mediumCount': counts['medium'],
                    'lowCount': counts['low'],
                    'infoCount': counts['info'],
                    'totalCount': sum(counts.values()),
                    'expiresAt': expires_at
                })
            except Exception:
                pass

        return respond(200, {
            'flowId': flow_id,
            'flowName': flow_name,
            'flowType': flow_type,
            'checkedAt': now,
            'findings': findings,
            'counts': counts
        })
    except Exception as e:
        return respond(500, {'error': str(e), 'trace': traceback.format_exc()})


def handle_get_validation_results(query_params):
    """Return stored validation results, optionally filtered by instance."""
    table_name = os.environ.get('VALIDATION_TABLE_NAME')
    if not table_name:
        return respond(200, {'results': []})

    region = (query_params or {}).get('region', '')
    instance_id = (query_params or {}).get('instanceId', '')

    try:
        table = boto3.resource('dynamodb').Table(table_name)
        items = []
        resp = table.scan()
        items.extend(resp.get('Items', []))
        while 'LastEvaluatedKey' in resp:
            resp = table.scan(ExclusiveStartKey=resp['LastEvaluatedKey'])
            items.extend(resp.get('Items', []))

        if region and instance_id:
            items = [i for i in items if i.get('region') == region and i.get('instanceId') == instance_id]

        items.sort(key=lambda x: x.get('checkedAt', ''), reverse=True)

        for item in items:
            if isinstance(item.get('findings'), str):
                try:
                    item['findings'] = json.loads(item['findings'])
                except Exception:
                    item['findings'] = []
            for k in ['criticalCount', 'highCount', 'mediumCount', 'lowCount', 'infoCount', 'totalCount']:
                if k in item:
                    item[k] = int(item[k])

        return respond(200, {'results': items})
    except Exception as e:
        return respond(500, {'error': str(e)})


def handle_delete_validation_result(body):
    """Delete a single validation result by key."""
    table_name = os.environ.get('VALIDATION_TABLE_NAME')
    if not table_name:
        return respond(200, {'deleted': True})

    validation_key = body.get('validationKey')
    if not validation_key:
        return respond(400, {'error': 'validationKey is required'})

    try:
        boto3.resource('dynamodb').Table(table_name).delete_item(
            Key={'validationKey': validation_key}
        )
        return respond(200, {'deleted': True})
    except Exception as e:
        return respond(500, {'error': str(e)})


def handle_clear_report():
    """Delete all items from the MigrationReport table."""
    table_name = os.environ.get('REPORT_TABLE_NAME')
    if not table_name:
        return respond(200, {'deleted': 0})
    try:
        table = boto3.resource('dynamodb').Table(table_name)
        # Scan for all result IDs, then batch delete
        items = []
        resp = table.scan(ProjectionExpression='resultId')
        items.extend(resp.get('Items', []))
        while 'LastEvaluatedKey' in resp:
            resp = table.scan(ProjectionExpression='resultId', ExclusiveStartKey=resp['LastEvaluatedKey'])
            items.extend(resp.get('Items', []))

        # Batch delete in chunks of 25
        deleted = 0
        for i in range(0, len(items), 25):
            batch = items[i:i+25]
            with table.batch_writer() as writer:
                for item in batch:
                    writer.delete_item(Key={'resultId': item['resultId']})
                    deleted += 1
        return respond(200, {'deleted': deleted})
    except Exception as e:
        return respond(500, {'error': str(e)})


# ─── Route Handlers ──────────────────────────────────────────────────

def handle_test_connection(body):
    """Test connectivity to a Connect instance."""
    region = body.get('region')
    instance_id = body.get('instanceId')
    role_arn = body.get('roleArn')

    if not region or not instance_id:
        return respond(400, {'error': 'region and instanceId are required'})

    try:
        client = get_connect_client(region, role_arn)
        resp = client.describe_instance(InstanceId=instance_id)
        inst = resp['Instance']
        return respond(200, {
            'success': True,
            'instanceAlias': inst.get('InstanceAlias', ''),
            'instanceStatus': inst.get('InstanceStatus', ''),
            'createdTime': inst.get('CreatedTime', ''),
            'serviceRole': inst.get('ServiceRole', '')
        })
    except Exception as e:
        return respond(200, {
            'success': False,
            'error': str(e)
        })


def handle_discover(body):
    """Discover resources from a Connect instance."""
    region = body.get('region')
    instance_id = body.get('instanceId')
    role_arn = body.get('roleArn')
    resource_type = body.get('resourceType')

    if not region or not instance_id or not resource_type:
        return respond(400, {'error': 'region, instanceId, and resourceType are required'})

    if resource_type not in DISCOVER_FN:
        return respond(400, {'error': f'Unknown resource type: {resource_type}. Valid: {list(DISCOVER_FN.keys())}'})

    try:
        client = get_connect_client(region, role_arn)
        resources = DISCOVER_FN[resource_type](client, instance_id)
        # Embed source connection info so replicate can lazy-fetch details
        for r in resources:
            r['_sourceRegion'] = region
            r['_sourceInstanceId'] = instance_id
            if role_arn:
                r['_sourceRoleArn'] = role_arn
        return respond(200, {
            'resourceType': resource_type,
            'count': len(resources),
            'resources': resources
        })
    except Exception as e:
        return respond(500, {'error': str(e), 'trace': traceback.format_exc()})


def handle_replicate(body, user_email=''):
    """Replicate selected resources to a target instance."""
    source = body.get('source', {})
    target = body.get('target', {})
    resource_type = body.get('resourceType')
    resources = body.get('resources', [])
    arn_map = body.get('arnMap', {})

    if not target.get('region') or not target.get('instanceId'):
        return respond(400, {'error': 'target region and instanceId are required'})
    if not resource_type:
        return respond(400, {'error': 'resourceType is required'})
    if not resources:
        return respond(400, {'error': 'No resources selected'})
    if resource_type not in REPLICATE_FN:
        return respond(400, {'error': f'Unknown resource type: {resource_type}'})

    try:
        client = get_connect_client(target['region'], target.get('roleArn'))
        results = REPLICATE_FN[resource_type](client, target['instanceId'], resources, arn_map)

        # Count outcomes
        success = sum(1 for r in results if r['status'] == 'success')
        failed = sum(1 for r in results if r['status'] == 'failed')
        skipped = sum(1 for r in results if r['status'] == 'skipped')

        summary = {'success': success, 'failed': failed, 'skipped': skipped}
        batch_id = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S') + '-' + str(uuid.uuid4())[:8]
        write_audit_log(user_email, source, target, resource_type, summary)
        write_report_results(user_email, source, target, resource_type, results, batch_id)
        return respond(200, {
            'resourceType': resource_type,
            'summary': summary,
            'results': results,
            'arnMap': arn_map
        })
    except Exception as e:
        return respond(500, {'error': str(e), 'trace': traceback.format_exc()})


def handle_discover_target(body):
    """Discover existing resources on the target instance (for comparison)."""
    region = body.get('region')
    instance_id = body.get('instanceId')
    role_arn = body.get('roleArn')
    resource_type = body.get('resourceType')

    if not region or not instance_id or not resource_type:
        return respond(400, {'error': 'region, instanceId, and resourceType are required'})

    if resource_type not in DISCOVER_FN:
        return respond(400, {'error': f'Unknown resource type: {resource_type}'})

    try:
        client = get_connect_client(region, role_arn)
        resources = DISCOVER_FN[resource_type](client, instance_id)
        # Return just names for comparison
        existing_names = [r['name'] for r in resources]
        return respond(200, {
            'resourceType': resource_type,
            'existingNames': existing_names,
            'count': len(existing_names)
        })
    except Exception as e:
        return respond(500, {'error': str(e), 'trace': traceback.format_exc()})


# ─── Lambda Handler ──────────────────────────────────────────────────

def handler(event, context):
    if event.get('httpMethod') == 'OPTIONS':
        return respond(200, '')

    path = event.get('path', '')
    method = event.get('httpMethod', '')

    # Extract user email from Cognito authorizer claims
    user_email = ''
    try:
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        user_email = claims.get('email', claims.get('cognito:username', ''))
    except Exception:
        pass

    if method == 'GET':
        if path.endswith('/audit-log'):
            return handle_get_audit_log()
        if path.endswith('/report'):
            return handle_get_report()
        if path.endswith('/validation-results'):
            return handle_get_validation_results(event.get('queryStringParameters'))
        return respond(404, {'error': f'Unknown path: {path}'})

    if method == 'DELETE':
        if path.endswith('/report'):
            return handle_clear_report()
        return respond(404, {'error': f'Unknown path: {path}'})

    if method != 'POST':
        return respond(405, {'error': 'Method not supported'})

    try:
        body = json.loads(event.get('body', '{}')) if event.get('body') else {}
    except json.JSONDecodeError:
        return respond(400, {'error': 'Invalid JSON body'})

    if path.endswith('/test-connection'):
        return handle_test_connection(body)
    elif path.endswith('/discover'):
        return handle_discover(body)
    elif path.endswith('/discover-target'):
        return handle_discover_target(body)
    elif path.endswith('/replicate'):
        return handle_replicate(body, user_email)
    elif path.endswith('/validate-flow'):
        return handle_validate_flow(body, user_email)
    elif path.endswith('/validation-results'):
        return handle_delete_validation_result(body)
    else:
        return respond(404, {'error': f'Unknown path: {path}'})
