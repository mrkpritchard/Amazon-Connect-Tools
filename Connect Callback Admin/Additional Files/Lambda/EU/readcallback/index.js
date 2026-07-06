'use strict';

// AWS SDK v3
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

// ---- Config ----
const REGION = process.env.AWS_REGION || 'eu-central-1';
const TABLE_NAME = process.env.TABLE_NAME || process.env.TableName || 'Callback';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://d3igja1xy9gdxm.cloudfront.net';

// Single shared client
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Utility: standard CORS headers for API Gateway responses
const corsHeaders = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Allow-Methods': 'GET,DELETE,OPTIONS',
};

// --- Helpers ---

/**
 * Query by PhoneNumber + QueueName (same semantics as your original code).
 * Returns the first matching item or null.
 * Excludes COMPLETED entries so new callbacks can be created for the same number.
 */
async function getCallbackByNumberAndQueue(phoneNumber, queueName) {
  // First, query without filter to see what exists (like original)
  const params = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PhoneNumber = :phone AND QueueName = :queue',
    ExpressionAttributeValues: {
      ':phone': phoneNumber,
      ':queue': queueName,
    },
    Limit: 1,
    ScanIndexForward: false,
    ConsistentRead: true, // Use consistent read to ensure we see the latest data
  };

  console.log('[readcallback] Checking for existing callback:', { phoneNumber, queueName, table: TABLE_NAME });
  
  try {
    const out = await ddb.send(new QueryCommand(params));
    
    console.log('[readcallback] Query executed successfully:', {
      itemCount: out.Items?.length || 0,
      scannedCount: out.ScannedCount || 0,
      items: out.Items?.map(item => ({
        hasStatus: !!item.Status,
        status: item.Status,
        hasCompletedAt: !!item.CompletedAt,
        contactId: item.ContactId,
        phoneNumber: item.PhoneNumber,
        queueName: item.QueueName
      })) || []
    });
    
    // Filter out completed items (like original, but exclude completed)
    let item = null;
    if (out.Items && out.Items.length > 0) {
      // Find first non-completed item
      for (const candidate of out.Items) {
        const isCompleted = candidate.Status === 'Completed' || candidate.CompletedAt;
        if (!isCompleted) {
          item = candidate;
          break;
        }
      }
    }
    
    if (item) {
      console.log('[readcallback] ✅ FOUND ACTIVE CALLBACK:', { 
        contactId: item.ContactId, 
        status: item.Status,
        hasCompletedAt: !!item.CompletedAt,
        phoneNumber: item.PhoneNumber,
        queueName: item.QueueName
      });
    } else {
      console.log('[readcallback] ❌ NO ACTIVE CALLBACK FOUND - Will return Callback: false');
      if (out.Items && out.Items.length > 0) {
        console.log('[readcallback] Note: Found items but all were COMPLETED:', out.Items.map(i => ({ status: i.Status, completedAt: i.CompletedAt })));
      }
    }
    
    return item || null;
  } catch (error) {
    console.error('[readcallback] ERROR querying for callback:', {
      error: error.message,
      name: error.name,
      stack: error.stack,
      phoneNumber,
      queueName
    });
    // Return null on error so it doesn't break the flow
    return null;
  }
}

/**
 * Build the Amazon Connect style response:
 *   { Callback: "true", Time, Date }  OR  { Callback: "false" }
 */
function buildConnectResponseFromItem(item) {
  if (!item) {
    return { Callback: 'false' };
  }
  // Preserve original property names: timeStamp + dateStamp if present
  return {
    Callback: 'true',
    Time: item.timeStamp || null,
    Date: item.dateStamp || null,
  };
}

/**
 * Admin UI list (scan) with safety limit.
 */
async function listCallbacks(limit) {
  const out = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    Limit: limit,
  }));

  const items = (out.Items || []).map(it => ({
    id: it.ContactId || it.id || `${it.PhoneNumber || ''}:${it.QueueName || ''}`,
    phoneNumber: it.PhoneNumber || it.phone || '',
    queueName: it.QueueName || it.queue || '',
    createdAt: it.timeStamp || it.dateStamp || null,
    data: it,
  }));

  return {
    items,
    nextToken: out.LastEvaluatedKey ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString('base64') : null,
  };
}

/**
 * Try to detect if the invocation is coming from Amazon Connect contact flow.
 * We check presence of event.Details.ContactData as the original function expected.
 */
function isAmazonConnectEvent(event) {
  return !!(event &&
            event.Details &&
            event.Details.ContactData &&
            event.Details.ContactData.Attributes);
}

/**
 * Standard API Gateway response
 */
function apiResponse(statusCode, bodyObj, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...corsHeaders, ...extraHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  };
}

// --- Lambda handler ---

exports.handler = async (event, context, callback) => {
  try {
    // 1) AMAZON CONNECT MODE: behave exactly like the original readcallback.js
    if (isAmazonConnectEvent(event)) {
      const phoneNumber = event.Details.ContactData.Attributes.CallbackNumber;
      const queue = event.Details.ContactData.Queue && event.Details.ContactData.Queue.Name;

      console.log('Connect flow lookup for', { phoneNumber, queue });

      if (!phoneNumber || !queue) {
        console.warn('Missing phoneNumber or queue in ContactData');
        // Return Callback: false to be safe (matches original pattern for not found)
        const res = { Callback: 'false' };
        // Important: for Connect we use the Node-style callback
        if (typeof callback === 'function') return callback(null, res);
        return res;
      }

      console.log('About to check for callback:', { phoneNumber, queue, table: TABLE_NAME });
      
      const item = await getCallbackByNumberAndQueue(phoneNumber, queue);
      
      console.log('Item returned from query:', { 
        found: !!item, 
        hasItem: item !== null,
        itemStatus: item?.Status,
        itemCompletedAt: item?.CompletedAt,
        itemContactId: item?.ContactId
      });
      
      const response = buildConnectResponseFromItem(item);

      console.log('Connect flow result:', { 
        response, 
        callbackValue: response.Callback,
        willReturn: response.Callback === 'true' ? 'TRUE - Callback exists' : 'FALSE - No callback'
      });

      if (typeof callback === 'function') return callback(null, response);
      return response;
    }

    // 2) API GATEWAY / ADMIN UI MODE
    const method = (event.httpMethod || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      // CORS preflight
      return {
        statusCode: 204,
        headers: corsHeaders,
        body: '',
      };
    }

    const qs = event.queryStringParameters || {};

    // Route: /callbacks/check?phone=...&queue=...
    // Returns the same shape as the Connect flow ({ Callback: "true"/"false", ... })
    if ((qs.action === 'check') || (event.resource && String(event.resource).includes('/callbacks/check'))) {
      const phoneNumber = qs.phone || qs.phoneNumber;
      const queue = qs.queue || qs.queueName;

      if (!phoneNumber || !queue) {
        return apiResponse(400, { message: 'Missing required query params: phone and queue' });
      }

      console.log('Admin check lookup for', { phoneNumber, queue });
      const item = await getCallbackByNumberAndQueue(phoneNumber, queue);
      const result = buildConnectResponseFromItem(item);
      return apiResponse(200, result);
    }

    // Default Route: list callbacks (scan) — e.g., GET /callbacks?limit=25
    const limit = Math.max(5, Math.min(200, parseInt(qs.limit || '25', 10)));
    const list = await listCallbacks(limit);

    return apiResponse(200, list);

  } catch (err) {
    console.error('readcallback error', err);

    // For Connect invocations, follow the original idea: don't throw — return Callback:false
    if (isAmazonConnectEvent(event)) {
      const res = { Callback: 'false' };
      if (typeof callback === 'function') return callback(null, res);
      return res;
    }

    // For API Gateway, return 500
    return apiResponse(500, { message: 'Internal error' });
  }
};