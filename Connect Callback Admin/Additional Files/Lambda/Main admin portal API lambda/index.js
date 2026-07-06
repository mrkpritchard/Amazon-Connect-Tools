'use strict';

// AWS SDK v3 (built into Lambda Node 18/20/22)
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, QueryCommand, UpdateCommand, GetCommand, PutCommand, DeleteCommand, BatchGetCommand } = require('@aws-sdk/lib-dynamodb');
const { ConnectClient, DescribeContactCommand, ListAssociatedContactsCommand, StopContactCommand, SearchContactsCommand } = require('@aws-sdk/client-connect');

const REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE = process.env.CALLBACKS_TABLE || 'Callback';
const HISTORY_TABLE = process.env.HISTORY_TABLE || process.env.HistoryTableName || 'CallbackHistory';

// Helper function to get table names and DynamoDB client based on region
// Tables have the same names in both regions, but are in different AWS regions
function getTableNames(region) {
  // Tables have the same names in both regions
  return {
    callbacksTable: TABLE,
    historyTable: HISTORY_TABLE,
    region: region // Return the region so we can use the correct DynamoDB client
  };
}

// Helper function to get DynamoDB client for a specific region
function getDynamoDBClient(region) {
  const targetRegion = region || REGION;
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: targetRegion }),
    { marshallOptions: { removeUndefinedValues: true } }
  );
}

// Default DynamoDB client (for backward compatibility and default operations)
const ddb = getDynamoDBClient(REGION);

const CONNECT_REGION = process.env.CONNECT_REGION || process.env.AWS_REGION || REGION;
const CONNECT_INSTANCE_ID_RAW = process.env.CONNECT_INSTANCE_ID;
// Use env EU_CONNECT_INSTANCE_ID if provided, otherwise fall back to the known EU instance ID.
// This keeps it overridable via environment variables but gives a safe default.
const EU_CONNECT_INSTANCE_ID_RAW = process.env.EU_CONNECT_INSTANCE_ID || 'YOUR_CONNECT_INSTANCE_ID';

// Accept GUID or ARN; normalize to GUID
function normalizeInstanceId(v) {
  if (!v) return v;
  if (v.includes(':instance/')) return v.split('/').pop();
  return v;
}
const CONNECT_INSTANCE_ID = normalizeInstanceId(CONNECT_INSTANCE_ID_RAW);
const EU_CONNECT_INSTANCE_ID = normalizeInstanceId(EU_CONNECT_INSTANCE_ID_RAW);

// Default Connect client (for backward compatibility)
const connect = new ConnectClient({ region: CONNECT_REGION });

// Helper function to get Connect client for a specific region
function getConnectClient(region) {
  let targetRegion = region || CONNECT_REGION;

  // If EU region is requested but no dedicated EU instance is configured,
  // fall back to the default Connect region so that InstanceId+region stay consistent.
  // This avoids DescribeContact/ListAssociatedContacts "Resource not found"
  // caused by calling eu-central-1 with a us-east-1 instance ID.
  if (targetRegion === 'eu-central-1' && !EU_CONNECT_INSTANCE_ID) {
    console.warn('[getConnectClient] EU region requested but EU_CONNECT_INSTANCE_ID is not set; falling back to CONNECT_REGION', {
      requestedRegion: region,
      effectiveRegion: CONNECT_REGION,
      connectInstanceId: CONNECT_INSTANCE_ID
    });
    targetRegion = CONNECT_REGION;
  }

  return new ConnectClient({ region: targetRegion });
}

// Helper function to get Connect instance ID for a specific region
function getConnectInstanceId(region) {
  if (region === 'eu-central-1') {
    const instanceId = EU_CONNECT_INSTANCE_ID || CONNECT_INSTANCE_ID; // Fallback to US if EU not configured
    if (!EU_CONNECT_INSTANCE_ID) {
      console.warn('[getConnectInstanceId] EU_CONNECT_INSTANCE_ID not set, falling back to US instance ID', {
        region,
        usingInstanceId: instanceId,
        euInstanceId: EU_CONNECT_INSTANCE_ID,
        usInstanceId: CONNECT_INSTANCE_ID
      });
    } else {
      console.log('[getConnectInstanceId] Using EU Connect instance ID', {
        region,
        instanceId
      });
    }
    return instanceId;
  }
  console.log('[getConnectInstanceId] Using US Connect instance ID', {
    region,
    instanceId: CONNECT_INSTANCE_ID
  });
  return CONNECT_INSTANCE_ID;
}

// Allowed origins for CORS
const allowedOrigins = [
  'https://your-portal-domain.example.com',
  'https://YOUR_CLOUDFRONT_DOMAIN.cloudfront.net',
  // Add other CloudFront distribution domains if needed
];

function getCorsOrigin(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || '*';
  // If origin is in allowed list, use it; otherwise use wildcard
  return allowedOrigins.includes(origin) ? origin : '*';
}

function json(statusCode, body, event = null) {
  const corsOrigin = event ? getCorsOrigin(event) : '*';
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    },
    isBase64Encoded: false,
    body: JSON.stringify(body)
  };
}

async function getCallbackContactIdFromDescribe(connectClient, instanceId, inboundContactId) {
  try {
    const out = await connectClient.send(new DescribeContactCommand({
      InstanceId: instanceId,
      ContactId: inboundContactId
    }));
    const attrs = out?.Contact?.Attributes;
    if (attrs && attrs.NextContactId) {
      console.log('[getCallbackContactIdFromDescribe] Found NextContactId in attributes', {
        instanceId,
        inboundContactId,
        nextContactId: attrs.NextContactId
      });
      return attrs.NextContactId;
    }
    return null;
  } catch (err) {
    // ResourceNotFoundException is expected if contact doesn't exist yet or isn't accessible
    if (err.name === 'ResourceNotFoundException') {
      console.log('[getCallbackContactIdFromDescribe] Contact not found (expected for new callbacks)', {
        instanceId,
        inboundContactId,
        error: err.message
      });
    } else {
      console.error('[getCallbackContactIdFromDescribe] Error:', {
        instanceId,
        inboundContactId,
        errName: err.name,
        errMsg: err.message
      });
    }
    return null;
  }
}

// Helper: for inbound contactId, resolve phone + queue from your table (checks both main and history tables)
async function resolveKeysByContactId(inboundContactId, checkHistory = true, callbacksTable = TABLE, historyTable = HISTORY_TABLE, region = null) {
  // Get the correct DynamoDB client for the region
  const ddbClient = region ? getDynamoDBClient(region) : ddb;
  
  // First check main table
  const out = await ddbClient.send(new ScanCommand({
    TableName: callbacksTable,
    // IMPORTANT: no Limit here, otherwise you may miss matches
    FilterExpression:
      '(#c = :cid) OR (#lc = :cid) OR (#cidCaps = :cid) OR (#id = :cid) OR (#pk = :cid) OR (#cbLower = :cid) OR (#cbUpper = :cid)',
    ExpressionAttributeNames: {
      '#c': 'ContactId',
      '#lc': 'contactId',
      '#cidCaps': 'ContactID',
      '#id': 'id',
      '#pk': 'pk',
      '#cbLower': 'callbackId',
      '#cbUpper': 'CallbackContactId'
    },
    ExpressionAttributeValues: { ':cid': inboundContactId },
    ProjectionExpression: 'PhoneNumber, QueueName'
  }));
  const item = out.Items?.[0];
  if (item) {
    return { PhoneNumber: item.PhoneNumber, QueueName: item.QueueName, table: callbacksTable };
  }
  
      // If not found in main table and checkHistory is true, check history table
      if (checkHistory && historyTable) {
        try {
          const historyOut = await ddbClient.send(new ScanCommand({
            TableName: historyTable,
            FilterExpression:
              '(#c = :cid) OR (#lc = :cid) OR (#cidCaps = :cid) OR (#id = :cid) OR (#pk = :cid) OR (#cbLower = :cid) OR (#cbUpper = :cid) OR (#orig = :cid)',
            ExpressionAttributeNames: {
              '#c': 'ContactId',
              '#lc': 'contactId',
              '#cidCaps': 'ContactID',
              '#id': 'id',
              '#pk': 'pk',
              '#cbLower': 'callbackId',
              '#cbUpper': 'CallbackContactId',
              '#orig': 'OriginalContactId'
            },
            ExpressionAttributeValues: { ':cid': inboundContactId },
            ProjectionExpression: 'PhoneNumber, QueueName, ArchivedAt, ContactId, OriginalContactId',
            ConsistentRead: true
          }));
          // Sort by ArchivedAt descending to get the most recent entry
          const sortedItems = (historyOut.Items || []).sort((a, b) => {
            const aTime = a.ArchivedAt ? new Date(a.ArchivedAt).getTime() : 0;
            const bTime = b.ArchivedAt ? new Date(b.ArchivedAt).getTime() : 0;
            return bTime - aTime;
          });
          const historyItem = sortedItems[0];
          if (historyItem) {
            console.log('[resolveKeysByContactId] Found in history table:', {
              inboundContactId,
              phoneNumber: historyItem.PhoneNumber,
              queueName: historyItem.QueueName,
              archivedAt: historyItem.ArchivedAt,
              hasContactId: !!historyItem.ContactId,
              hasOriginalContactId: !!historyItem.OriginalContactId
            });
            return { 
              PhoneNumber: historyItem.PhoneNumber, 
              QueueName: historyItem.QueueName, 
              ArchivedAt: historyItem.ArchivedAt,
              table: historyTable 
            };
          }
        } catch (err) {
          console.error('[resolveKeysByContactId] Error checking history table:', err);
        }
      }
  
  return null;
}

/**
 * Check if a callback contact is completed by checking its state in Amazon Connect
 * Returns completion info including actual completion time
 */

/**
 * PRIMARY METHOD: Check callback completion via original contact's associated contacts
 */
async function checkCallbackCompletionViaOriginalContact(connectClient, instanceId, originalContactId) {
  if (!originalContactId || !instanceId) {
    return { isCompleted: false, reason: 'missing-params' };
  }
  
  try {
    console.log('[cleanup] Checking original contact for associated callbacks', { originalContactId });
    
    const associatedResponse = await connectClient.send(new ListAssociatedContactsCommand({
      InstanceId: instanceId,
      ContactId: originalContactId
    }));
    
    const associatedContacts = associatedResponse.ContactSummaryList || [];
    
    // Separate callback contacts from the original inbound contact
    const callbackContacts = associatedContacts.filter(c => c.InitiationMethod === 'CALLBACK');
    const otherContacts = associatedContacts.filter(c => c.InitiationMethod !== 'CALLBACK');
    
    console.log('[cleanup] Associated contacts', { 
      originalContactId, 
      total: associatedContacts.length,
      callbackContacts: callbackContacts.length,
      otherContacts: otherContacts.length
    });
    
    if (associatedContacts.length === 0) {
      return { isCompleted: false, reason: 'no-associated-contacts' };
    }
    
    // If NO callback contacts exist, the callback was never attempted
    // Only the original inbound contact exists - keep it active
    if (callbackContacts.length === 0) {
      console.log('[cleanup] No callback contacts found - callback not yet attempted', { originalContactId });
      return { isCompleted: false, reason: 'no-callback-contacts' };
    }
    
    // Check if any callback contacts are still active (no DisconnectTimestamp)
    const activeCallbacks = callbackContacts.filter(c => !c.DisconnectTimestamp);
    console.log('[cleanup] Active callback contacts', { 
      originalContactId, 
      active: activeCallbacks.length, 
      totalCallbacks: callbackContacts.length 
    });
    
    if (activeCallbacks.length > 0) {
      return { isCompleted: false, reason: 'has-active-callbacks' };
    }
    
    // All callback contacts are disconnected - callback process is complete!
    const mostRecent = callbackContacts.filter(c => c.DisconnectTimestamp)
      .sort((a, b) => new Date(b.DisconnectTimestamp) - new Date(a.DisconnectTimestamp))[0];
    
    if (mostRecent) {
      const completedAt = new Date(mostRecent.DisconnectTimestamp);
      console.log('[cleanup] Callback completed via original contact check', { 
        originalContactId, 
        completedAt: completedAt.toISOString(),
        callbackContactId: mostRecent.ContactId
      });
      return {
        isCompleted: true,
        completedAt: completedAt.toISOString(),
        completedEpoch: Math.floor(completedAt.getTime() / 1000),
        reason: 'all-callbacks-disconnected'
      };
    }
    
    return { isCompleted: false, reason: 'no-completion-data' };
  } catch (err) {
    console.warn('[cleanup] Error checking original contact', { originalContactId, error: err.message });
    return { isCompleted: false, reason: 'api-error', error: err.message };
  }
}

/**
 * FALLBACK METHOD: Check if a callback is completed by searching Amazon Connect for active contacts with this phone number
 * @param {*} connectClient - Connect client instance
 * @param {*} instanceId - Connect instance ID
 * @param {*} phoneNumber - Phone number to search for
 * @param {*} callbackCreatedEpoch - Unix epoch when callback was created (to narrow search window)
 * @returns {Object} - { isCompleted: boolean, completedAt?: string, completedEpoch?: number }
 * 
 * CRITICAL: Amazon Connect creates a NEW contact ID for each callback retry attempt.
 * Checking a specific contact ID will ALWAYS show "disconnected" after that attempt ends.
 * Instead, we search for contacts matching the phone number created around the callback time.
 * Only mark as completed when NO active contacts exist (all have DisconnectTimestamp).
 */
async function getCallbackContactCompletionInfo(connectClient, instanceId, phoneNumber, callbackCreatedEpoch, hasBeenAttempted = false) {
  if (!phoneNumber || !instanceId) {
    console.warn('[cleanup] Missing phoneNumber or instanceId', { phoneNumber, instanceId });
    return { isCompleted: false };
  }
  
  try {
    // Calculate time range: callback creation time to +7 days after
    // Wide window needed because Connect may schedule callback hours/days after creation
    // We don't search backwards to avoid matching old callbacks with same phone number
    const callbackCreatedTime = callbackCreatedEpoch ? new Date(callbackCreatedEpoch * 1000) : new Date();
    const startTime = new Date(callbackCreatedTime.getTime()); // Start at callback creation
    const endTime = new Date(callbackCreatedTime.getTime() + (7 * 24 * 60 * 60 * 1000)); // +7 days after
    
    console.log('[cleanup] Searching Connect for phone number in callback time window', {
      phoneNumber,
      instanceId,
      callbackCreatedEpoch,
      callbackCreatedTime: callbackCreatedTime.toISOString(),
      timeRange: { start: startTime.toISOString(), end: endTime.toISOString() },
      hasBeenAttempted
    });
    
    // Search for contacts with this phone number created around the callback time
    // This prevents matching old callbacks with the same phone number
    const searchResponse = await connectClient.send(new SearchContactsCommand({
      InstanceId: instanceId,
      TimeRange: {
        Type: 'INITIATION_TIMESTAMP',
        StartTime: startTime,
        EndTime: endTime
      },
      SearchCriteria: {
        Channels: ['VOICE'],
        SearchableContactAttributes: {
          Criteria: [
            {
              Key: 'CustomerEndpoint',
              Values: [phoneNumber]
            }
          ],
          MatchType: 'MATCH_ALL'
        }
      },
      MaxResults: 20
    }));
    
    const contacts = searchResponse.Contacts || [];
    
    console.log('[cleanup] Search results for phone number', {
      phoneNumber,
      totalContacts: contacts.length,
      contactIds: contacts.map(c => c.Id)
    });
    
    if (contacts.length === 0) {
      console.log('[cleanup] No contacts found for phone number', { 
        phoneNumber, 
        hasBeenAttempted,
        callbackCreatedEpoch 
      });
      
      // CRITICAL: Only archive if callback was already attempted (has CallbackContactId)
      // If no CallbackContactId, callback is waiting to be attempted (might be Friday → Monday)
      // DON'T archive pending callbacks just because they're old!
      if (!hasBeenAttempted) {
        console.log('[cleanup] Callback not attempted yet (no CallbackContactId), keeping it active', { phoneNumber });
        return { isCompleted: false };
      }
      
      // Callback WAS attempted (has CallbackContactId) but Connect has no contact records
      // This means the callback cycle completed and records aged out OR were purged
      // Safe to archive after 2 days since attempt
      const callbackAgeDays = callbackCreatedEpoch ? (Date.now() / 1000 - callbackCreatedEpoch) / 86400 : 0;
      console.log('[cleanup] Callback was attempted but no Connect records found', { 
        phoneNumber, 
        callbackAgeDays: Math.floor(callbackAgeDays * 100) / 100 
      });
      
      if (callbackAgeDays > 2) {
        console.log('[cleanup] Attempted callback >2 days old with no Connect records, marking as completed', { 
          phoneNumber, 
          callbackAgeDays: Math.floor(callbackAgeDays * 100) / 100
        });
        return { 
          isCompleted: true, 
          completedAt: new Date().toISOString(),
          completedEpoch: Math.floor(Date.now() / 1000)
        };
      }
      
      // Attempted recently but no records yet - wait a bit longer
      console.log('[cleanup] Attempted callback <2 days old, waiting for contact records', { phoneNumber });
      return { isCompleted: false };
    }
    
    // Filter for contacts that are still active (no DisconnectTimestamp)
    const activeContacts = contacts.filter(contact => !contact.DisconnectTimestamp);
    
    console.log('[cleanup] Active contacts check', {
      phoneNumber,
      totalContacts: contacts.length,
      activeContacts: activeContacts.length,
      activeContactIds: activeContacts.map(c => c.Id),
      disconnectedContactIds: contacts.filter(c => c.DisconnectTimestamp).map(c => c.Id)
    });
    
    // If ANY contacts are still active (no disconnect timestamp), callback is NOT complete
    if (activeContacts.length > 0) {
      console.log('[cleanup] Found active contacts, callback NOT completed', {
        phoneNumber,
        activeCount: activeContacts.length,
        activeContactIds: activeContacts.map(c => c.Id)
      });
      return { isCompleted: false };
    }
    
    // All contacts are disconnected - callback is complete
    // Use the most recent DisconnectTimestamp as the completion time
    const sortedContacts = contacts
      .filter(c => c.DisconnectTimestamp)
      .sort((a, b) => new Date(b.DisconnectTimestamp) - new Date(a.DisconnectTimestamp));
    
    if (sortedContacts.length === 0) {
      console.warn('[cleanup] No contacts with DisconnectTimestamp found', { phoneNumber });
      return { isCompleted: false };
    }
    
    const mostRecentContact = sortedContacts[0];
    const completedAt = new Date(mostRecentContact.DisconnectTimestamp);
    const completedEpoch = Math.floor(completedAt.getTime() / 1000);
    
    console.log('[cleanup] Callback completed - all contacts disconnected', {
      phoneNumber,
      totalContacts: contacts.length,
      mostRecentContactId: mostRecentContact.Id,
      completedAt: completedAt.toISOString(),
      completedEpoch
    });
    
    return {
      isCompleted: true,
      completedAt: completedAt.toISOString(),
      completedEpoch
    };
  } catch (err) {
    console.error('[cleanup] Error searching for contacts', {
      phoneNumber,
      error: err.message,
      name: err.name,
      stack: err.stack
    });
    return { isCompleted: false };
  }
}

/**
 * Cleanup function: Move completed callbacks from main table to history table
 * Checks Amazon Connect to see if callback contacts are completed
 */
async function cleanupCompletedCallbacks(ddbClient, callbacksTable, historyTable, region, allowedQueues) {
  try {
    // Normalize allowedQueues - handle null, undefined, or ensure it's an array
    const normalizedAllowedQueues = (allowedQueues === null || allowedQueues === undefined) ? null : (Array.isArray(allowedQueues) ? allowedQueues : []);
    
    console.log('[cleanup] Starting cleanup of completed callbacks', { 
      region, 
      callbacksTable, 
      historyTable,
      allowedQueuesType: typeof allowedQueues,
      allowedQueuesIsArray: Array.isArray(allowedQueues),
      allowedQueuesValue: allowedQueues,
      normalizedAllowedQueues
    });
    
    // Get Connect client and instance ID for this region
    const connectClient = getConnectClient(region);
    const instanceId = getConnectInstanceId(region);
    
    if (!instanceId) {
      console.warn('[cleanup] No Connect instance ID configured for region', { region });
      return 0;
    }
    
    // Scan all items (we'll check each one via Connect)
    const scanParams = {
      TableName: callbacksTable,
      Limit: 100 // Process in batches
    };
    
    let processedCount = 0;
    let checkedCount = 0;
    let nextToken = null;
    
    do {
      if (nextToken) {
        scanParams.ExclusiveStartKey = nextToken;
      }
      
      const scanResult = await ddbClient.send(new ScanCommand(scanParams));
      const items = scanResult.Items || [];
      
      // Filter by allowed queues if restrictions exist
      // normalizedAllowedQueues is null for admins (no filtering) or an array
      const itemsToCheck = (normalizedAllowedQueues !== null && normalizedAllowedQueues.length > 0)
        ? items.filter(item => {
            const queue = item.QueueName || item.queueName || item.queue;
            return !queue || normalizedAllowedQueues.includes(queue);
          })
        : items;
      
      // Check each item to see if callback is completed
      for (const item of itemsToCheck) {
        try {
          const phoneNumber = item.PhoneNumber || item.phoneNumber;
          const queueName = item.QueueName || item.queueName || item.queue;
          const callbackContactId = item.CallbackContactId || item.callbackContactId;
          const originalContactId = item.ContactId || item.contactId;
          
          // Skip items without required fields
          if (!phoneNumber || !queueName) {
            console.warn('[cleanup] Skipping item without phone or queue', { itemKeys: Object.keys(item) });
            continue;
          }
          
          // Skip items that have neither original contact ID nor callback contact ID
          // (we need at least one to check Connect)
          if (!originalContactId && !callbackContactId) {
            console.warn('[cleanup] Skipping item without any contact ID', { phoneNumber, queueName });
            continue;
          }
          
          checkedCount++;
          
          // FIRST: Check if this callback already exists in history table
          // If it does, the CTR processor already handled it, so just delete from main table
          try {
            const historyQueryResult = await ddbClient.send(new QueryCommand({
              TableName: historyTable,
              KeyConditionExpression: 'PhoneNumber = :phone',
              ExpressionAttributeValues: {
                ':phone': phoneNumber
              },
              Limit: 5 // Just check recent history entries
            }));
            
            // Check if any history entry matches this callback's contact IDs
            const existsInHistory = historyQueryResult.Items?.some(histItem => 
              (callbackContactId && (histItem.CallbackContactId === callbackContactId || 
               histItem.OriginalCallbackContactId === callbackContactId)) ||
              (originalContactId && (histItem.ContactId === originalContactId ||
               histItem.OriginalContactId === originalContactId))
            );
            
            if (existsInHistory) {
              console.log('[cleanup] Callback already in history - deleting duplicate from main table', {
                phoneNumber,
                queueName,
                callbackContactId,
                originalContactId,
                reason: 'CTR processor already moved to history but delete failed'
              });
              
              // Just delete from main table (already in history)
              await ddbClient.send(new DeleteCommand({
                TableName: callbacksTable,
                Key: { PhoneNumber: phoneNumber, QueueName: queueName }
              }));
              
              processedCount++;
              console.log('[cleanup] Deleted duplicate callback from main table', {
                phoneNumber,
                queueName
              });
              continue; // Move to next item
            }
          } catch (historyCheckErr) {
            console.warn('[cleanup] Error checking history table, will check Connect instead', {
              error: historyCheckErr.message,
              phoneNumber
            });
            // Continue to Connect check if history query fails
          }
          
          // SECOND: If not in history, check Connect to see if callback is FULLY completed
          // PRIMARY METHOD: Check via original contact ID using ListAssociatedContacts (most reliable!)
          // FALLBACK: Search by phone number if original contact check fails
          const createdEpoch = item.epoch || item.Epoch || (item.timeStamp ? Math.floor(new Date(item.timeStamp).getTime() / 1000) : null);
          
          let completionInfo = { isCompleted: false };
          
          // Try original contact ID first (checks associated callback contacts)
          if (originalContactId) {
            console.log('[cleanup] Checking completion via original contact ID', { originalContactId, phoneNumber, callbackContactId: callbackContactId || 'none' });
            completionInfo = await checkCallbackCompletionViaOriginalContact(connectClient, instanceId, originalContactId);
          }
          
          // If original contact method failed or unavailable, fall back to phone number search
          if (!completionInfo.isCompleted && completionInfo.reason !== 'has-active-callbacks') {
            console.log('[cleanup] Original contact check inconclusive, falling back to phone search', { 
              phoneNumber, 
              reason: completionInfo.reason 
            });
            const hasBeenAttempted = !!callbackContactId;
            completionInfo = await getCallbackContactCompletionInfo(connectClient, instanceId, phoneNumber, createdEpoch, hasBeenAttempted);
          }
          
          if (!completionInfo.isCompleted) {
            // Check for stale callbacks: if callback is >7 days old and Connect shows
            // no callback contacts were ever created, it likely expired or was handled
            // outside the system. Archive as expired to prevent perpetual buildup.
            const callbackAgeDays = createdEpoch ? (Date.now() / 1000 - createdEpoch) / 86400 : 0;
            if (callbackAgeDays > 7 && completionInfo.reason !== 'has-active-callbacks') {
              console.log('[cleanup] Stale callback (>7 days old) with no active contacts, archiving as expired', {
                phoneNumber,
                queueName,
                ageDays: Math.floor(callbackAgeDays),
                reason: completionInfo.reason
              });
              completionInfo = {
                isCompleted: true,
                completedAt: new Date().toISOString(),
                completedEpoch: Math.floor(Date.now() / 1000),
                reason: 'expired-stale'
              };
            } else {
              console.log('[cleanup] Callback not completed, skipping', { phoneNumber, reason: completionInfo.reason, ageDays: Math.floor(callbackAgeDays) });
              continue; // Not completed yet, skip
            }
          }
          
          // Callback is completed (all contacts are disconnected) - move to history
          // Note: We used to check retry attempts here, but that was wrong. If Connect says
          // the callback is complete (all contacts disconnected), we should archive it immediately.
          // The retry logic is handled by Connect's callback system, not by us.
          console.log('[cleanup] Callback completed, moving to history', {
            phoneNumber,
            queueName,
            callbackContactId,
            attemptNumber: item.AttemptNumber || 0,
            maxRetries: item.MaxRetries || 3
          });
          
          // Use actual completion time from Connect, or current time as fallback
          const completedAt = completionInfo.completedAt || new Date().toISOString();
          const completedEpoch = completionInfo.completedEpoch || Math.floor(Date.now() / 1000);
          
          // Calculate time in queue (from callback creation to completion)
          let timeInQueue = null;
          if (createdEpoch && completedEpoch) {
            timeInQueue = completedEpoch - createdEpoch; // Time in seconds
          }
          
          const now = new Date();
          const archivedAt = now.toISOString();
          const archivedEpoch = Math.floor(now.getTime() / 1000);
          
          // Prepare history item - set status based on completion reason
          const isExpired = completionInfo.reason === 'expired-stale';
          const historyItem = {
            PhoneNumber: phoneNumber,
            QueueName: queueName,
            ContactId: item.ContactId,
            CallbackContactId: callbackContactId || null,
            CBQueue: item.CBQueue || item.cbqueue,
            HoldTime: item.HoldTime,
            AttemptNumber: item.AttemptNumber || 0,
            MaxRetries: item.MaxRetries || 3,
            FinalAttemptNumber: item.AttemptNumber || 0,
            epoch: item.epoch,
            timeStamp: item.timeStamp,
            Status: isExpired ? 'Expired' : 'Complete',
            CompletedAt: completedAt,
            CompletedEpoch: completedEpoch,
            TimeInQueue: timeInQueue,
            ArchivedAt: archivedAt,
            ArchivedEpoch: archivedEpoch,
            OriginalContactId: item.ContactId,
            OriginalCallbackContactId: callbackContactId || null
          };
          
          const historyKey = {
            PhoneNumber: phoneNumber,
            ArchivedAt: archivedAt
          };
          
          // Write to history table
          await ddbClient.send(new PutCommand({
            TableName: historyTable,
            Item: {
              ...historyItem,
              ...historyKey
            }
          }));
          
          // Delete from main table
          await ddbClient.send(new DeleteCommand({
            TableName: callbacksTable,
            Key: {
              PhoneNumber: phoneNumber,
              QueueName: queueName
            }
          }));
          
          processedCount++;
          console.log('[cleanup] Moved completed callback to history', {
            phoneNumber,
            queueName,
            contactId: item.ContactId,
            callbackContactId
          });
        } catch (itemErr) {
          console.error('[cleanup] Error processing item', {
            error: itemErr.message,
            phoneNumber: item.PhoneNumber,
            queueName: item.QueueName
          });
          // Continue with next item
        }
      }
      
      nextToken = scanResult.LastEvaluatedKey;
    } while (nextToken);
    
    if (processedCount > 0 || checkedCount > 0) {
      console.log('[cleanup] Cleanup completed', { processedCount, checkedCount, region });
    }
    
    return processedCount;
  } catch (err) {
    console.error('[cleanup] Error during cleanup', {
      error: err.message,
      name: err.name,
      region
    });
    // Don't throw - cleanup is best effort
    return 0;
  }
}

async function updateScheduledTimesForExistingCallbacks(ddbClient, callbacksTable, region, allowedQueues) {
  try {
    const normalizedAllowedQueues = (allowedQueues === null || allowedQueues === undefined) ? null : (Array.isArray(allowedQueues) ? allowedQueues : []);
    
    console.log('[updateScheduledTimes] Starting scheduled time update for existing callbacks', { 
      region, 
      callbacksTable,
      normalizedAllowedQueues
    });
    
    // Get Connect client and instance ID for this region
    const connectClient = getConnectClient(region);
    const connectInstanceId = getConnectInstanceId(region);
    
    if (!connectInstanceId) {
      console.warn('[updateScheduledTimes] No Connect instance ID configured for region', { region });
      return { updated: 0, skipped: 0, errors: 0 };
    }
    
    const scanParams = {
      TableName: callbacksTable,
      Limit: 100
    };
    
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let nextToken = null;
    
    do {
      if (nextToken) {
        scanParams.ExclusiveStartKey = nextToken;
      }
      
      const scanResult = await ddbClient.send(new ScanCommand(scanParams));
      const items = scanResult.Items || [];
      
      // Filter by allowed queues if restrictions exist
      const itemsToUpdate = (normalizedAllowedQueues !== null && normalizedAllowedQueues.length > 0)
        ? items.filter(item => {
            const queue = item.QueueName || item.queueName || item.queue;
            return !queue || normalizedAllowedQueues.includes(queue);
          })
        : items;
      
      // Process each item
      for (const item of itemsToUpdate) {
        try {
          // Skip if already has ScheduledTimestamp
          if (item.ScheduledTimestamp || item.scheduledTimestamp) {
            skippedCount++;
            continue;
          }
          
          // Skip if no callback contact ID (can't get DelayedTime)
          const callbackContactId = item.CallbackContactId || item.callbackContactId || item.callbackId;
          if (!callbackContactId) {
            skippedCount++;
            continue;
          }
          
          // Get DelayedTime from contact attributes
          try {
            const contact = await connectClient.send(new DescribeContactCommand({
              InstanceId: connectInstanceId,
              ContactId: callbackContactId
            }));
            
            const contactData = contact?.Contact;
            const attributes = contactData?.Attributes || {};
            
            // Get DelayedTime in seconds (check multiple possible attribute names)
            const delayedTime = attributes.DelayedTime 
              || attributes.delayedTime
              || attributes.DelaySeconds
              || attributes.delaySeconds
              || attributes.Delay
              || attributes.delay
              || null;
            
            if (!delayedTime) {
              skippedCount++;
              continue;
            }
            
            // Get creation time from the item
            let createdTime = null;
            if (item.timeStamp) {
              createdTime = new Date(item.timeStamp);
            } else if (item.epoch) {
              createdTime = new Date(Number(item.epoch) * 1000);
            }
            
            if (!createdTime || Number.isNaN(createdTime.getTime())) {
              skippedCount++;
              continue;
            }
            
            // Calculate scheduled time: Created time + DelayedTime (in seconds)
            const delaySeconds = Number(delayedTime);
            const delayMs = delaySeconds * 1000;
            const scheduledTime = new Date(createdTime.getTime() + delayMs);
            const scheduledTimestamp = scheduledTime.toISOString();
            
            // Update the item in DynamoDB
            const phoneNumber = item.PhoneNumber || item.phoneNumber;
            const queueName = item.QueueName || item.queueName || item.queue;
            
            if (!phoneNumber || !queueName) {
              skippedCount++;
              continue;
            }
            
            await ddbClient.send(new UpdateCommand({
              TableName: callbacksTable,
              Key: {
                PhoneNumber: phoneNumber,
                QueueName: queueName
              },
              UpdateExpression: 'SET ScheduledTimestamp = :st',
              ExpressionAttributeValues: {
                ':st': scheduledTimestamp
              }
            }));
            
            updatedCount++;
            console.log('[updateScheduledTimes] Updated scheduled time', {
              phoneNumber,
              queueName,
              createdTime: createdTime.toISOString(),
              delayedTime: delaySeconds,
              scheduledTimestamp: scheduledTimestamp
            });
          } catch (contactErr) {
            // If contact not found or error, skip this item
            if (contactErr.name !== 'ResourceNotFoundException') {
              console.warn('[updateScheduledTimes] Error getting DelayedTime', {
                callbackContactId,
                error: contactErr.message,
                phoneNumber: item.PhoneNumber
              });
            }
            skippedCount++;
          }
        } catch (itemErr) {
          errorCount++;
          console.error('[updateScheduledTimes] Error updating item', {
            error: itemErr.message,
            phoneNumber: item.PhoneNumber,
            queueName: item.QueueName
          });
        }
      }
      
      nextToken = scanResult.LastEvaluatedKey;
    } while (nextToken);
    
    console.log('[updateScheduledTimes] Update completed', { 
      updated: updatedCount, 
      skipped: skippedCount, 
      errors: errorCount,
      region 
    });
    
    return { updated: updatedCount, skipped: skippedCount, errors: errorCount };
  } catch (err) {
    console.error('[updateScheduledTimes] Error during update', {
      error: err.message,
      name: err.name,
      region
    });
    return { updated: 0, skipped: 0, errors: 0 };
  }
}

// Common filter function for both active callbacks and history
function applyFilter(items, filter, limit, includeOriginalContactId = false) {
  if (!filter) return items;
  
  const filterLower = filter.toLowerCase();
  const filtered = items.filter(item => {
    const phone = (item.PhoneNumber || '').toLowerCase();
    const contactId = (item.ContactId || (includeOriginalContactId ? item.OriginalContactId : '') || '').toLowerCase();
    const queueName = (item.QueueName || '').toLowerCase();
    return phone.includes(filterLower) || 
           contactId.includes(filterLower) || 
           queueName.includes(filterLower);
  });
  // Don't slice here - let pagination handle the limit
  // This was causing history to only show 'limit' items total instead of allowing proper pagination
  return filtered;
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    const path = event.path || event.rawPath || '';
    
    console.log('[handler] Request received', {
      method,
      path,
      rawPath: event.rawPath,
      hasHttpMethod: !!event.httpMethod,
      requestId: event.requestContext?.requestId
    });
    
    if (event.httpMethod === 'OPTIONS') {
      const corsOrigin = getCorsOrigin(event);
      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        isBase64Encoded: false,
        body: ''
      };
    }

    // -------- GET /callbacks (list for admin UI) ----------
    if (method === 'GET' && path.endsWith('/callbacks')) {
      const qs = event.queryStringParameters || {};
      const region = qs.region || 'us-east-1'; // Get region from query parameter
      const tables = getTableNames(region);
      
      if (!tables.callbacksTable) return json(500, { message: 'Server misconfiguration: CALLBACKS_TABLE missing' }, event);

      const filter = qs.filter || qs.phone || null; // Support both 'filter' and 'phone' for backward compatibility
      const limit = qs.limit ? parseInt(qs.limit, 10) : 50;
      const lastKeyEncoded = qs.lastKey || null;

      // Get the correct DynamoDB client for the region
      const ddbClient = getDynamoDBClient(region);
      
      const params = { TableName: tables.callbacksTable, Limit: limit * 3 }; // Fetch more items to account for filtering
      // If filter is provided, we'll filter in JavaScript after fetching
      // For backward compatibility, still support exact phone match in FilterExpression
      if (filter && qs.phone) {
        // Legacy support: exact phone match
        params.FilterExpression = '#p = :phone';
        params.ExpressionAttributeNames = { '#p': 'PhoneNumber' };
        params.ExpressionAttributeValues = { ':phone': filter };
      }
      if (lastKeyEncoded) {
        try {
          const lk = JSON.parse(Buffer.from(lastKeyEncoded, 'base64').toString('utf8'));
          if (lk) params.ExclusiveStartKey = lk;
        } catch { /* ignore */ }
      }

      // Strongly-consistent read so UI reflects updates immediately
      const data = await ddbClient.send(new ScanCommand({ ...params, ConsistentRead: true }));
      
      let items = data.Items || [];
      
      // Filter out very old callbacks (before January 10, 2026) - likely test data
      // Only exclude if created more than 5 days ago
      const cutoffDate = new Date('2026-01-10T00:00:00Z');
      const cutoffEpoch = Math.floor(cutoffDate.getTime() / 1000);
      items = items.filter(item => {
        let createdEpoch = null;
        if (typeof item?.epoch === 'number') {
          createdEpoch = item.epoch;
        } else if (typeof item?.epoch === 'string' && /^\d+$/.test(item.epoch)) {
          createdEpoch = parseInt(item.epoch, 10);
        } else if (item?.timeStamp) {
          const t = Date.parse(item.timeStamp);
          if (!Number.isNaN(t)) createdEpoch = Math.floor(t / 1000);
        }
        // If we can't determine age, include it (don't filter out)
        if (createdEpoch == null) return true;
        // Filter out callbacks created before cutoff date
        return createdEpoch >= cutoffEpoch;
      });
      
      // Manual cleanup: Check Amazon Connect and move completed callbacks to history
      // Only runs when explicitly requested via cleanup=true parameter
      if (qs.cleanup === 'true') {
        console.log('[cleanup] Manual cleanup requested via query parameter');
        const cleanedCount = await cleanupCompletedCallbacks(ddbClient, tables.callbacksTable, tables.historyTable, region, null);
        console.log('[cleanup] Manual cleanup completed', { cleanedCount, region });
        
        // Re-fetch after cleanup to get updated list
        const refreshData = await ddbClient.send(new ScanCommand({ ...params, ConsistentRead: true }));
        items = refreshData.Items || [];
      }
      
      // Then apply search filter in JavaScript if provided (supports partial matches across phone, ID, and queue)
      items = applyFilter(items, filter, limit, false);
      
      // Now limit the results for pagination
      items = items.slice(0, limit);

      // Compute Age / COMPLETED text
      const nowSec = Math.floor(Date.now() / 1000);
      function computeAgeText(it) {
        let createdSec = null;
        if (typeof it?.epoch === 'number') {
          createdSec = it.epoch;
        } else if (typeof it?.epoch === 'string' && /^\d+$/.test(it.epoch)) {
          createdSec = parseInt(it.epoch, 10);
        } else if (it?.timeStamp) {
          const t = Date.parse(it.timeStamp);
          if (!Number.isNaN(t)) createdSec = Math.floor(t / 1000);
        }
        if (createdSec == null) return '';
        const diff = Math.max(0, nowSec - createdSec);
        if (diff < 60) return `${diff} sec`;
        if (diff < 3600) return `${Math.floor(diff / 60)} min`;
        if (diff < 86400) return `${Math.floor(diff / 3600)} hr`;
        return `${Math.floor(diff / 86400)} days`;
      }

      const itemsWithAge = items.map(it => {
        const text = (it?.Status === 'Completed' || it?.CompletedAt)
          ? 'Completed'
          : computeAgeText(it);
        return { 
          ...it, 
          ageText: text, 
          Age: text,
          AttemptNumber: it.AttemptNumber || 1,
          LastAttemptOutcome: it.LastAttemptOutcome || null,
          MaxRetries: it.MaxRetries || 3
        }; // expose "Age" for legacy bindings
      });

      // Calculate scheduled time from Created time + DelayedTime (in seconds)
      // DelayedTime is stored in the contact attributes
      // Only calculate if ScheduledTimestamp doesn't already exist in DynamoDB
      const connectInstanceId = getConnectInstanceId(region);
      if (connectInstanceId) {
        // Early exit optimization: if all items already have ScheduledTimestamp, skip API calls
        const itemsNeedingCalculation = itemsWithAge.filter(item => 
          !item.ScheduledTimestamp && !item.scheduledTimestamp && (item.CallbackContactId || item.callbackContactId || item.callbackId)
        );
        
        if (itemsNeedingCalculation.length === 0) {
          console.log('[scheduled] All items already have ScheduledTimestamp, skipping calculation');
        } else {
          const connectClient = getConnectClient(region);
          const scheduledTimePromises = itemsWithAge.map(async (item) => {
          // If ScheduledTimestamp already exists in DynamoDB, use it (don't overwrite)
          if (item.ScheduledTimestamp || item.scheduledTimestamp) {
            return { item, scheduledTimestamp: item.ScheduledTimestamp || item.scheduledTimestamp };
          }
          
          const callbackContactId = item.CallbackContactId || item.callbackContactId || item.callbackId;
          
          if (!callbackContactId) {
            return { item, scheduledTimestamp: null };
          }
          
          try {
            // Get DelayedTime from contact attributes
            const contact = await connectClient.send(new DescribeContactCommand({
              InstanceId: connectInstanceId,
              ContactId: callbackContactId
            }));
            
            const contactData = contact?.Contact;
            const attributes = contactData?.Attributes || {};
            
            // Get DelayedTime in seconds (check multiple possible attribute names)
            const delayedTime = attributes.DelayedTime 
              || attributes.delayedTime
              || attributes.DelaySeconds
              || attributes.delaySeconds
              || attributes.Delay
              || attributes.delay
              || null;
            
            if (!delayedTime) {
              return { item, scheduledTimestamp: null };
            }
            
            // Get creation time from the item
            let createdTime = null;
            if (item.timeStamp) {
              createdTime = new Date(item.timeStamp);
            } else if (item.epoch) {
              createdTime = new Date(Number(item.epoch) * 1000);
            }
            
            if (!createdTime || Number.isNaN(createdTime.getTime())) {
              return { item, scheduledTimestamp: null };
            }
            
            // Calculate scheduled time: Created time + DelayedTime (in seconds)
            const delaySeconds = Number(delayedTime);
            const delayMs = delaySeconds * 1000;
            const scheduledTime = new Date(createdTime.getTime() + delayMs);
            const scheduledTimestamp = scheduledTime.toISOString();
            
            return { item, scheduledTimestamp };
          } catch (err) {
            // If contact not found or error, return null (non-critical)
            if (err.name !== 'ResourceNotFoundException') {
              console.warn('[scheduled] Error getting DelayedTime', {
                callbackContactId,
                error: err.message,
                phoneNumber: item.PhoneNumber
              });
            }
            return { item, scheduledTimestamp: null };
          }
          });
          
          // Wait for all scheduled time calculations to complete (in parallel)
          const results = await Promise.all(scheduledTimePromises);
          itemsWithAge.forEach((item, index) => {
            // Only set if we got a value and item doesn't already have one
            if (results[index].scheduledTimestamp && !item.ScheduledTimestamp) {
              item.ScheduledTimestamp = results[index].scheduledTimestamp;
            }
          });
        }
        
        const scheduledCount = itemsWithAge.filter(it => it.ScheduledTimestamp).length;
        console.log('[scheduled] Scheduled time calculation completed', {
          totalItems: itemsWithAge.length,
          itemsWithScheduledTimestamp: scheduledCount,
          itemsNeedingCalculation: itemsNeedingCalculation?.length || 0
        });
      }

      const lastKeyOut = data.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(data.LastEvaluatedKey)).toString('base64')
        : null;

      return json(200, {
        items: itemsWithAge,
        count: itemsWithAge.length,
        scannedCount: data.ScannedCount || 0,
        lastKey: lastKeyOut
      }, event);
    }

    // -------- GET /callbacks/history (list completed callbacks) ----------
    if (method === 'GET' && (path.endsWith('/callbacks/history') || path.includes('/callbacks/history'))) {
      const qs = event.queryStringParameters || {};
      const region = qs.region || 'us-east-1'; // Get region from query parameter
      const tables = getTableNames(region);
      
      if (!tables.historyTable) return json(500, { message: 'Server misconfiguration: HISTORY_TABLE missing' }, event);

      const filter = qs.filter || qs.phone || null; // Support both 'filter' and 'phone' for backward compatibility
      const limit = qs.limit ? parseInt(qs.limit, 10) : 25;
      const lastKeyEncoded = qs.lastKey || null;

      // Get the correct DynamoDB client for the region
      const ddbClient = getDynamoDBClient(region);
      
      // Simple approach: Scan with a larger limit to account for filtering, then paginate
      const params = { 
        TableName: tables.historyTable, 
        Limit: limit * 5, // Fetch 5x items to account for queue filtering
        ConsistentRead: true
      };
      
      if (lastKeyEncoded) {
        try {
          const lk = JSON.parse(Buffer.from(lastKeyEncoded, 'base64').toString('utf8'));
          if (lk) params.ExclusiveStartKey = lk;
        } catch { /* ignore */ }
      }

      const data = await ddbClient.send(new ScanCommand(params));
      
      let items = data.Items || [];
      
      // Then apply search filter in JavaScript if provided (supports partial matches across phone, ID, and queue)
      items = applyFilter(items, filter, null, true);
      
      // Sort by completion date (newest first) - prefer CompletedAt over ArchivedAt
      items.sort((a, b) => {
        const aTime = a.CompletedAt || a.ArchivedAt || a.timeStamp || '';
        const bTime = b.CompletedAt || b.ArchivedAt || b.timeStamp || '';
        if (!aTime && !bTime) return 0;
        if (!aTime) return 1; // Items without dates go to end
        if (!bTime) return -1;
        return new Date(bTime) - new Date(aTime); // Newest first
      });
      
      // Take only the requested page size
      const pageItems = items.slice(0, limit);
      
      console.log(`[History] Fetched ${data.Items?.length || 0} from DB, filtered to ${items.length}, returning ${pageItems.length}`);
      
      // Format items - show CompletedAt as completion time (prefer CompletedAt over ArchivedAt)
      const itemsWithAge = pageItems.map(it => {
        // Prefer CompletedAt (when callback finished) over ArchivedAt (when moved to history)
        const completedAt = it.CompletedAt || it.ArchivedAt || it.timeStamp;
        // Don't convert to string here - pass raw ISO string and let client format in local timezone
        
        // Calculate time in queue (from creation to completion)
        let timeInQueue = '';
        let createdSec = null;
        if (typeof it?.epoch === 'number') {
          createdSec = it.epoch;
        } else if (typeof it?.epoch === 'string' && /^\d+$/.test(it.epoch)) {
          createdSec = parseInt(it.epoch, 10);
        } else if (it?.timeStamp) {
          const t = Date.parse(it.timeStamp);
          if (!Number.isNaN(t)) createdSec = Math.floor(t / 1000);
        }
        
        let completedSec = null;
        if (completedAt) {
          const t = Date.parse(completedAt);
          if (!Number.isNaN(t)) completedSec = Math.floor(t / 1000);
        }
        
        if (createdSec && completedSec) {
          const diff = Math.max(0, completedSec - createdSec);
          if (diff < 60) timeInQueue = `${diff} sec`;
          else if (diff < 3600) timeInQueue = `${Math.floor(diff / 60)} min`;
          else if (diff < 86400) timeInQueue = `${Math.floor(diff / 3600)} hr`;
          else timeInQueue = `${Math.floor(diff / 86400)} days`;
        }
        
        return {
          ...it,
          ageText: 'Completed',
          Age: 'Completed',
          completedAt: completedAt, // Pass raw ISO string, not formatted string (prefer CompletedAt)
          ArchivedAt: it.ArchivedAt || completedAt, // Keep ArchivedAt for sorting
          timeInQueue: timeInQueue
        };
      });

      // Items are already sorted

      // If DynamoDB has more data, return the lastKey - regardless of filter results
      // This ensures we can paginate through all data even when queue filtering reduces results
      const lastKeyOut = data.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(data.LastEvaluatedKey)).toString('base64')
        : null;

      return json(200, {
        items: itemsWithAge,
        count: itemsWithAge.length,
        lastKey: lastKeyOut,
        hasMore: !!lastKeyOut
      }, event);
    }

    // -------- POST /callbacks/history/sync-callback-ids (sync missing callback IDs from Connect) ----------
    if (method === 'POST' && (path.endsWith('/callbacks/history/sync-callback-ids') || path.includes('/callbacks/history/sync-callback-ids'))) {
      const qs = event.queryStringParameters || {};
      const region = qs.region || 'us-east-1';
      const tables = getTableNames(region);
      
      console.log('[sync-callback-ids] Sync callback IDs endpoint called', { 
        region, 
        path: path,
        method: method
      });
      
      const connectInstanceId = getConnectInstanceId(region);
      if (!connectInstanceId) {
        return json(500, { 
          message: `Server misconfiguration: CONNECT_INSTANCE_ID missing for region ${region}` 
        }, event);
      }
      
      const ddbClient = getDynamoDBClient(region);
      const connectClient = getConnectClient(region);
      
      // Scan history table for items with missing callback contact IDs
      const scanParams = {
        TableName: tables.historyTable,
        FilterExpression: 'attribute_not_exists(CallbackContactId) OR CallbackContactId = :empty',
        ExpressionAttributeValues: { ':empty': '' }
      };
      
      console.log('[sync-callback-ids] Scanning history table for missing callback IDs', {
        table: tables.historyTable,
        region
      });
      
      const scanResult = await ddbClient.send(new ScanCommand(scanParams));
      let items = scanResult.Items || [];
      
      console.log('[sync-callback-ids] Found items with missing callback IDs', {
        count: items.length,
        region
      });
      
      let updated = 0;
      let skipped = 0;
      let errors = 0;
      
      // Process each item
      for (const item of items) {
        try {
          const inboundContactId = item.ContactId || item.contactId || item.id;
          if (!inboundContactId) {
            console.log('[sync-callback-ids] Skipping item - no inbound contact ID', { item });
            skipped++;
            continue;
          }
          
          // Try to get callback contact ID from Connect
          const callbackContactId = await getCallbackContactIdFromDescribe(connectClient, connectInstanceId, inboundContactId);
          
          if (callbackContactId) {
            // Update the history record with the callback contact ID
            const updateParams = {
              TableName: tables.historyTable,
              Key: {
                PhoneNumber: item.PhoneNumber,
                epoch: item.epoch
              },
              UpdateExpression: 'SET CallbackContactId = :cbId, LastUpdated = :now',
              ExpressionAttributeValues: {
                ':cbId': callbackContactId,
                ':now': new Date().toISOString()
              }
            };
            
            await ddbClient.send(new UpdateCommand(updateParams));
            
            console.log('[sync-callback-ids] Updated callback ID', {
              inboundContactId,
              callbackContactId,
              phone: item.PhoneNumber
            });
            
            updated++;
          } else {
            console.log('[sync-callback-ids] No callback ID found in Connect', {
              inboundContactId,
              phone: item.PhoneNumber
            });
            skipped++;
          }
        } catch (err) {
          console.error('[sync-callback-ids] Error processing item', {
            error: err.message,
            item: { phone: item.PhoneNumber, contactId: item.ContactId }
          });
          errors++;
        }
      }
      
      return json(200, {
        message: 'Callback ID sync completed',
        total: items.length,
        updated,
        skipped,
        errors,
        region
      }, event);
    }

    // -------- POST /callbacks/cleanup (manual cleanup of completed callbacks) ----------
    if (method === 'POST' && (path.endsWith('/callbacks/cleanup') || path.includes('/callbacks/cleanup'))) {
      const qs = event.queryStringParameters || {};
      const region = qs.region || 'us-east-1';
      const tables = getTableNames(region);
      
      if (!tables.callbacksTable) return json(500, { message: 'Server misconfiguration: CALLBACKS_TABLE missing' }, event);
      
      // Get the correct DynamoDB client for the region
      const ddbClient = getDynamoDBClient(region);
      
      console.log('[cleanup] Manual cleanup endpoint called', { 
        region, 
        path: path,
        rawPath: event.rawPath,
        method: method
      });
      
      // First, update scheduled times for existing callbacks that don't have it
      // Wrap in try-catch to ensure cleanup can proceed even if scheduled time update fails
      let updateResult = { updated: 0, skipped: 0, errors: 0 };
      try {
        updateResult = await updateScheduledTimesForExistingCallbacks(ddbClient, tables.callbacksTable, region, null);
      } catch (updateErr) {
        console.error('[cleanup] Error updating scheduled times, continuing with cleanup', {
          error: updateErr.message,
          name: updateErr.name
        });
        // Continue with cleanup even if scheduled time update fails
      }
      
      // Then, cleanup completed callbacks
      const cleanedCount = await cleanupCompletedCallbacks(ddbClient, tables.callbacksTable, tables.historyTable, region, null);
      
      return json(200, {
        message: 'Sync completed',
        cleanedCount,
        scheduledTimesUpdated: updateResult.updated,
        scheduledTimesSkipped: updateResult.skipped,
        scheduledTimesErrors: updateResult.errors,
        region
      });
    }

    // -------- POST /callbacks/{id}/link ----------
    if (method === 'POST' && /\/callbacks\/[^/]+\/link$/.test(path || event.rawPath || '')) {
      // Get region from query params or body
      const qs = event.queryStringParameters || {};
      let body;
      try {
        body = event.body ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body) : {};
      } catch {}
      const region = qs.region || body?.region || 'us-east-1';
      const tables = getTableNames(region);
      
      // Get region-specific Connect instance ID
      const connectInstanceId = getConnectInstanceId(region);
      if (!connectInstanceId) {
        return json(500, { 
          message: `Server misconfiguration: CONNECT_INSTANCE_ID missing for region ${region}` 
        });
      }
      
      if (!tables.callbacksTable) return json(500, { message: 'Server misconfiguration: CALLBACKS_TABLE missing' }, event);

      // Inbound ContactId from path
      const parts = (path || event.rawPath || '').split('?')[0].split('/').filter(Boolean);
      const i = parts.lastIndexOf('callbacks');
      const inboundId = i >= 0 ? decodeURIComponent(parts[i + 1] || '') : '';
      if (!inboundId) return json(400, { message: 'Missing original ContactId in path' }, event);

      // Optional body keys
      let phoneNumberValue, queueNameValue;
      if (body) {
        phoneNumberValue = body?.phoneNumber ?? body?.PhoneNumber;
        queueNameValue   = body?.queueName   ?? body?.QueueName;
      }

      // Declare variables outside try block so they're available in catch block
      let targetTable = tables.callbacksTable;
      let archivedAtValue = null;
      let updateKey = null;
      let expressionAttributeNames = {};
      let expressionAttributeValues = { ':cb': null, ':ts': new Date().toISOString() };
      let conditionExpression = '';
      
      // Get the correct DynamoDB client for the region
      const ddbClient = getDynamoDBClient(region);

      try {
        // 1) Find the callback contact via Connect (using region-specific instance)
        console.log('[link] Starting callback contact lookup', {
          inboundId,
          region,
          instanceId: connectInstanceId
        });
        
        let cbId;
        try {
          cbId = await findCallbackContactId(inboundId, region, connectInstanceId);
          console.log('[link] Callback contact lookup result', {
            found: !!cbId,
            callbackContactId: cbId,
            inboundId,
            region
          });
        } catch (findErr) {
          console.error('[link] Error finding callback contact ID:', {
            error: findErr.message,
            stack: findErr.stack,
            region,
            instanceId: connectInstanceId,
            inboundId
          });
          return json(500, {
            message: 'Failed to find callback contact',
            error: findErr.message,
            originalContactId: inboundId
          });
        }
        
        if (!cbId) {
          // not yet available
          console.log('[link] Callback contact not found yet (returning 202)', { inboundId, region });
          return json(202, {
            message: 'Callback contact not found yet (still pending). Try again shortly.',
            originalContactId: inboundId
          });
        }

        // 2) Ensure we have DynamoDB keys (check both main and history tables)
        targetTable = tables.callbacksTable;
        archivedAtValue = null;
        if (!phoneNumberValue || !queueNameValue) {
          const keys = await resolveKeysByContactId(inboundId, true, tables.callbacksTable, tables.historyTable, region);
          if (!keys?.PhoneNumber || !keys?.QueueName) {
            console.error('[link] Failed to resolve DynamoDB keys', {
              inboundId,
              region,
              callbackContactId: cbId,
              tables: {
                callbacks: tables.callbacksTable,
                history: tables.historyTable
              }
            });
            return json(404, {
              message: 'Inbound ContactId not found in DynamoDB (cannot resolve primary key)',
              originalContactId: inboundId,
              callbackContactId: cbId
            });
          }
          phoneNumberValue = keys.PhoneNumber;
          queueNameValue   = keys.QueueName;
          targetTable = keys.table || tables.callbacksTable; // Use the table where the item was found
          archivedAtValue = keys.ArchivedAt || null; // Get ArchivedAt if it's in history
        } else {
          // If phone/queue were provided, we still need to check which table has the item
          // and get ArchivedAt if it's in history - but also verify the ContactId matches
          const keys = await resolveKeysByContactId(inboundId, true, tables.callbacksTable, tables.historyTable, region);
          if (keys) {
            // Verify the keys match what was provided
            if (keys.PhoneNumber === phoneNumberValue && keys.QueueName === queueNameValue) {
              targetTable = keys.table || tables.callbacksTable;
              archivedAtValue = keys.ArchivedAt || null;
            } else {
              console.warn('[link] Keys mismatch:', {
                provided: { phoneNumberValue, queueNameValue },
                found: { phone: keys.PhoneNumber, queue: keys.QueueName }
              });
              // Use the found keys instead
              phoneNumberValue = keys.PhoneNumber;
              queueNameValue = keys.QueueName;
              targetTable = keys.table || tables.callbacksTable;
              archivedAtValue = keys.ArchivedAt || null;
            }
          }
        }
        
        console.log('[link] Resolved keys:', {
          targetTable,
          phoneNumberValue,
          queueNameValue,
          archivedAtValue,
          inboundId
        });

        // 3) Update the inbound item with callback info (in the appropriate table)
        // Build the key - history table uses ArchivedAt as sort key, main table uses QueueName
        conditionExpression = '';
        expressionAttributeNames = {};
        expressionAttributeValues = { ':cb': cbId, ':ts': new Date().toISOString() };
        
        if (targetTable === tables.historyTable) {
          // For history table, we need PhoneNumber and ArchivedAt as the key
          if (archivedAtValue) {
            updateKey = { PhoneNumber: phoneNumberValue, ArchivedAt: archivedAtValue };
          } else {
            // Fallback: query for the most recent entry with this phone/queue
            const historyScan = await ddbClient.send(new ScanCommand({
              TableName: tables.historyTable,
              FilterExpression: '#p = :phone AND #q = :queue',
              ExpressionAttributeNames: { '#p': 'PhoneNumber', '#q': 'QueueName' },
              ExpressionAttributeValues: { ':phone': phoneNumberValue, ':queue': queueNameValue },
              ProjectionExpression: 'PhoneNumber, ArchivedAt',
              ConsistentRead: true
            }));
            // Sort by ArchivedAt descending to get the most recent entry
            const sortedItems = (historyScan.Items || []).sort((a, b) => {
              const aTime = a.ArchivedAt ? new Date(a.ArchivedAt).getTime() : 0;
              const bTime = b.ArchivedAt ? new Date(b.ArchivedAt).getTime() : 0;
              return bTime - aTime;
            });
            const historyItem = sortedItems[0];
            if (historyItem && historyItem.ArchivedAt) {
              updateKey = { PhoneNumber: phoneNumberValue, ArchivedAt: historyItem.ArchivedAt };
              archivedAtValue = historyItem.ArchivedAt;
            } else {
              // Last resort: this shouldn't happen, but log it
              console.error('[link] Could not find ArchivedAt for history item', { phoneNumberValue, queueNameValue });
              return json(404, { message: 'History item found but cannot determine key (ArchivedAt missing)' }, event);
            }
          }
          
          // For history table, condition should check for PhoneNumber and ArchivedAt (the key attributes)
          conditionExpression = 'attribute_exists(PhoneNumber) AND attribute_exists(ArchivedAt)';
          expressionAttributeNames = {};
          // Optionally verify QueueName matches if provided
          if (queueNameValue) {
            expressionAttributeNames['#q'] = 'QueueName';
            conditionExpression += ' AND #q = :q';
            expressionAttributeValues[':q'] = queueNameValue;
          }
        } else {
          // Main table uses PhoneNumber + QueueName as key
          updateKey = { PhoneNumber: phoneNumberValue, QueueName: queueNameValue };
          conditionExpression = 'attribute_exists(PhoneNumber)';
          if (queueNameValue) {
            expressionAttributeNames['#q'] = 'QueueName';
            conditionExpression += ' AND #q = :q';
            expressionAttributeValues[':q'] = queueNameValue;
          }
        }

        console.log('[link] Updating item:', {
          table: targetTable,
          key: updateKey,
          conditionExpression,
          expressionAttributeNames,
          hasCallbackId: !!cbId,
          phoneNumberValue,
          queueNameValue,
          archivedAtValue
        });

        // Verify the item exists before updating (especially important for history table)
        try {
          const existingItem = await ddbClient.send(new GetCommand({
            TableName: targetTable,
            Key: updateKey,
            ConsistentRead: true
          }));
          
          if (!existingItem.Item) {
            console.error('[link] Item not found with key:', { table: targetTable, key: updateKey });
            return json(404, {
              message: 'Item not found in table',
              originalContactId: inboundId,
              table: targetTable,
              key: updateKey
            });
          }
          
          console.log('[link] Item found, proceeding with update:', {
            table: targetTable,
            hasItem: !!existingItem.Item,
            itemKeys: existingItem.Item ? Object.keys(existingItem.Item) : []
          });
        } catch (getErr) {
          console.error('[link] Error verifying item exists:', {
            error: getErr.message,
            name: getErr.name,
            table: targetTable,
            key: updateKey
          });
          // Continue anyway - the update will fail if item doesn't exist
        }

        // 🔧 Update the item in the appropriate table
        console.log('[link] Executing DynamoDB update', {
          table: targetTable,
          key: updateKey,
          callbackContactId: cbId,
          region
        });
        
        await ddbClient.send(new UpdateCommand({
          TableName: targetTable,
          Key: updateKey,
          UpdateExpression: 'SET CallbackContactId = :cb, CallbackLinkedAt = :ts',
          ConditionExpression: conditionExpression,
          ...(Object.keys(expressionAttributeNames).length ? { ExpressionAttributeNames: expressionAttributeNames } : {}),
          ExpressionAttributeValues: expressionAttributeValues
        }));

        console.log('[link] Successfully updated DynamoDB item', {
          table: targetTable,
          key: updateKey,
          callbackContactId: cbId,
          region
        });

        return json(200, {
          message: 'Linked',
          originalContactId: inboundId,
          callbackContactId: cbId,
          key: { PhoneNumber: phoneNumberValue, QueueName: queueNameValue }
        });
      } catch (err) {
        console.error('[link] error', { 
          inboundId, 
          region,
          errName: err?.name,
          errMessage: err?.message,
          errCode: err?.code,
          stack: err?.stack,
          targetTable: targetTable || 'not set',
          updateKey: updateKey || 'not set',
          phoneNumberValue: phoneNumberValue || 'not set',
          queueNameValue: queueNameValue || 'not set',
          archivedAtValue: archivedAtValue || 'not set'
        });
        const name = err?.name || '';
        if (name === 'ConditionalCheckFailedException') {
          return json(404, { 
            message: 'Inbound item not found (condition failed)', 
            originalContactId: inboundId,
            table: targetTable,
            key: updateKey
          });
        }
        if (name === 'ValidationException') {
          return json(400, { 
            message: 'Bad request to DynamoDB (validation)', 
            error: err.message,
            table: targetTable,
            key: updateKey
          });
        }
        return json(500, { 
          message: 'Internal server error', 
          error: err.message,
          errorName: err?.name,
          errorCode: err?.code,
          table: targetTable,
          key: updateKey
        });
      }
    }

    // -------- POST /callbacks/{id}/stop (stop callback contact and move to history) ----------
    if (method === 'POST' && /\/callbacks\/[^/]+\/stop$/.test(path || event.rawPath || '')) {
      // Get region from query params or body
      const qs = event.queryStringParameters || {};
      let body;
      try {
        body = event.body ? (typeof event.body === 'string' ? JSON.parse(event.body) : event.body) : {};
      } catch {}
      const region = qs.region || body?.region || 'us-east-1';
      
      console.log('[stop] Stop endpoint called', {
        path: path || event.rawPath,
        region,
        queryParams: qs,
        hasBody: !!body
      });
      
      const tables = getTableNames(region);
      
      // Get region-specific Connect instance ID
      const connectInstanceId = getConnectInstanceId(region);
      if (!connectInstanceId) {
        console.error('[stop] No Connect instance ID for region', { region });
        return json(500, { 
          message: `Server misconfiguration: CONNECT_INSTANCE_ID missing for region ${region}` 
        });
      }
      
      if (!tables.callbacksTable) return json(500, { message: 'Server misconfiguration: CALLBACKS_TABLE missing' }, event);

      // Extract callback contact ID from path
      const parts = (path || event.rawPath || '').split('?')[0].split('/').filter(Boolean);
      const i = parts.lastIndexOf('callbacks');
      const callbackContactId = i >= 0 ? decodeURIComponent(parts[i + 1] || '') : '';
      if (!callbackContactId) {
        console.error('[stop] Missing callback ContactId in path', { path: path || event.rawPath, parts });
        return json(400, { message: 'Missing callback ContactId in path' }, event);
      }

      console.log('[stop] Processing stop request', {
        callbackContactId,
        region,
        connectInstanceId,
        callbacksTable: tables.callbacksTable
      });

      // Get the correct DynamoDB and Connect clients for the region
      const ddbClient = getDynamoDBClient(region);
      const connectClient = getConnectClient(region);
      
      console.log('[stop] Clients initialized', {
        region,
        connectClientRegion: region, // The client should be using the correct region
        connectInstanceId
      });

      try {
        // 1) Find the item in DynamoDB by CallbackContactId
        console.log('[stop] Scanning DynamoDB for callback', {
          table: tables.callbacksTable,
          region,
          callbackContactId
        });
        
        const scanResult = await ddbClient.send(new ScanCommand({
          TableName: tables.callbacksTable,
          FilterExpression: '(CallbackContactId = :cbId) OR (callbackContactId = :cbId)',
          ExpressionAttributeValues: { ':cbId': callbackContactId },
          ConsistentRead: true
        }));

        console.log('[stop] Scan result', {
          itemsFound: scanResult.Items?.length || 0,
          scannedCount: scanResult.ScannedCount,
          callbackContactId
        });

        const item = scanResult.Items?.[0];
        if (!item) {
          console.error('[stop] Callback not found in database', {
            callbackContactId,
            region,
            table: tables.callbacksTable,
            scannedCount: scanResult.ScannedCount
          });
          return json(404, { 
            message: 'Callback not found in database',
            callbackContactId 
          });
        }
        
        console.log('[stop] Found callback item', {
          phoneNumber: item.PhoneNumber || item.phoneNumber,
          queueName: item.QueueName || item.queueName || item.queue,
          callbackContactId
        });

        const phoneNumber = item.PhoneNumber || item.phoneNumber;
        const queueName = item.QueueName || item.queueName || item.queue;

        if (!phoneNumber || !queueName) {
          return json(400, { 
            message: 'Callback item missing phone number or queue name',
            callbackContactId 
          });
        }

        // 2) Stop the contact in Amazon Connect
        try {
          await connectClient.send(new StopContactCommand({
            InstanceId: connectInstanceId,
            ContactId: callbackContactId
          }));
          console.log('[stop] Successfully stopped contact in Amazon Connect', {
            callbackContactId,
            region,
            instanceId: connectInstanceId
          });
        } catch (stopErr) {
          // If contact is already stopped or not found, log but continue
          if (stopErr.name === 'ResourceNotFoundException' || stopErr.name === 'InvalidContactStateException') {
            console.log('[stop] Contact already stopped or not found, continuing with database update', {
              callbackContactId,
              error: stopErr.message
            });
          } else {
            // For other errors, still log but continue (best effort)
            console.warn('[stop] Error stopping contact, continuing with database update', {
              callbackContactId,
              error: stopErr.message,
              name: stopErr.name
            });
          }
        }

        // 3) Move to history with "Deleted" status
        const now = new Date();
        const archivedAt = now.toISOString();
        const archivedEpoch = Math.floor(now.getTime() / 1000);

        // Calculate time in queue if we have creation time
        let timeInQueue = null;
        const createdEpoch = item.epoch || item.Epoch || (item.timeStamp ? Math.floor(new Date(item.timeStamp).getTime() / 1000) : null);
        if (createdEpoch && archivedEpoch) {
          timeInQueue = archivedEpoch - createdEpoch;
        }

        const historyItem = {
          ...item,
          PhoneNumber: phoneNumber,
          QueueName: queueName,
          Status: 'Deleted',
          CompletedAt: archivedAt,
          CompletedEpoch: archivedEpoch,
          TimeInQueue: timeInQueue,
          ArchivedAt: archivedAt,
          ArchivedEpoch: archivedEpoch,
          OriginalContactId: item.ContactId,
          OriginalCallbackContactId: callbackContactId,
          DeletedReason: 'Manually removed by admin'
        };

        const historyKey = {
          PhoneNumber: phoneNumber,
          ArchivedAt: archivedAt
        };

        // Write to history table
        await ddbClient.send(new PutCommand({
          TableName: tables.historyTable,
          Item: {
            ...historyItem,
            ...historyKey
          }
        }));

        // 4) Delete from main table
        console.log('[stop] Deleting from main table', {
          table: tables.callbacksTable,
          key: { PhoneNumber: phoneNumber, QueueName: queueName },
          region
        });
        
        await ddbClient.send(new DeleteCommand({
          TableName: tables.callbacksTable,
          Key: {
            PhoneNumber: phoneNumber,
            QueueName: queueName
          }
        }));

        console.log('[stop] Successfully moved callback to history', {
          phoneNumber,
          queueName,
          callbackContactId,
          region
        });

        return json(200, {
          message: 'Callback stopped and moved to history',
          callbackContactId,
          phoneNumber,
          queueName,
          region
        });
      } catch (err) {
        console.error('[stop] Error stopping callback', {
          callbackContactId,
          region,
          error: err.message,
          name: err.name,
          stack: err.stack
        });
        return json(500, {
          message: 'Error stopping callback',
          error: err.message,
          errorName: err?.name
        });
      }
    }

    // -------- GET /available-queues (return all unique queue names from callbacks) ----------
    if (method === 'GET' && path.endsWith('/available-queues')) {
      const qs = event.queryStringParameters || {};
      const region = qs.region || 'us-east-1';
      const tables = getTableNames(region);
      
      if (!tables.callbacksTable) return json(500, { message: 'Server misconfiguration: CALLBACKS_TABLE missing' }, event);

      try {
        const ddbClient = getDynamoDBClient(region);
        const data = await ddbClient.send(new ScanCommand({
          TableName: tables.callbacksTable,
          ProjectionExpression: 'QueueName',
          ConsistentRead: false // Can use eventually consistent for queue list
        }));
        
        // Extract unique queue names
        const queues = new Set();
        (data.Items || []).forEach(item => {
          if (item.QueueName) queues.add(item.QueueName);
        });
        
        return json(200, { queues: Array.from(queues).sort() }, event);
      } catch (err) {
        console.error('[GET /available-queues] Error:', err);
        return json(500, { message: 'Internal server error', error: err.message }, event);
      }
    }

    // Otherwise
    return json(404, { message: 'Not Found' }, event);

  } catch (err) {
    console.error('[handler] Unhandled error', {
      error: err.message,
      name: err.name,
      stack: err.stack,
      method: event?.httpMethod,
      path: event?.path || event?.rawPath,
      requestId: event?.requestContext?.requestId
    });
    return json(500, { message: 'Internal server error', error: err.message }, event);
  }
};

// ------------- helpers -------------
function getInboundIdFromEvent(event) {
  const p = event.path || event.rawPath || '';
  const parts = p.split('?')[0].split('/').filter(Boolean);
  const i = parts.lastIndexOf('callbacks');
  return i >= 0 ? decodeURIComponent(parts[i + 1] || '') : '';
}

async function findCallbackContactId(originalContactId, region = null, instanceId = null) {
  // Get region-specific Connect client and instance ID
  const targetRegion = region || CONNECT_REGION;
  const targetInstanceId = instanceId || getConnectInstanceId(targetRegion);
  const connectClient = getConnectClient(targetRegion);
  
  if (!targetInstanceId) {
    console.error('[findCallbackContactId] CONNECT_INSTANCE_ID missing', { region: targetRegion });
    return null; // Return null instead of throwing to avoid breaking the flow
  }

  // 1) Preferred: read NextContactId from inbound contact attributes
  const nextFromDescribe = await getCallbackContactIdFromDescribe(
    connectClient, targetInstanceId, originalContactId
  );
  if (nextFromDescribe) return nextFromDescribe;

  // 2) Fallback: scan associated contacts; catch any AWS errors to avoid 500s
  let nextToken;
  try {
    do {
      const out = await connectClient.send(new ListAssociatedContactsCommand({
        InstanceId: targetInstanceId,
        ContactId: originalContactId,
        MaxResults: 100,
        NextToken: nextToken
      }));
      const list = out?.ContactSummaryList ?? [];
      // Prefer direct linkage to the inbound
      const direct = list.find(c =>
        c?.InitiationMethod === 'CALLBACK' && c?.PreviousContactId === originalContactId
      );
      if (direct?.ContactId) {
        console.log('[findCallbackContactId] Found direct callback linkage', {
          region: targetRegion,
          callbackContactId: direct.ContactId,
          originalContactId
        });
        return direct.ContactId;
      }

      // Otherwise, any CALLBACK within the same association tree
      const anyCb = list.find(c => c?.InitiationMethod === 'CALLBACK');
      if (anyCb?.ContactId) {
        console.log('[findCallbackContactId] Found callback in association tree', {
          region: targetRegion,
          callbackContactId: anyCb.ContactId,
          originalContactId
        });
        return anyCb.ContactId;
      }

      nextToken = out?.NextToken;
    } while (nextToken);
    
    console.log('[findCallbackContactId] No callback contact found in associated contacts', {
      region: targetRegion,
      originalContactId
    });
  } catch (err) {
    // ResourceNotFoundException is expected if contact doesn't exist yet or isn't accessible
    if (err.name === 'ResourceNotFoundException') {
      console.log('[findCallbackContactId] Contact not found (expected for new callbacks)', {
        region: targetRegion,
        instanceId: targetInstanceId,
        originalContactId,
        error: err.message
      });
    } else {
      // Don't take the whole flow down; log and treat as "not ready yet"
      console.error('[findCallbackContactId] ListAssociatedContacts failed', {
        region: targetRegion,
        instanceId: targetInstanceId,
        originalContactId,
        errName: err?.name,
        errMsg: err?.message
      });
    }
    return null;
  }

  // Still not found → not yet created/linked
  return null;
}