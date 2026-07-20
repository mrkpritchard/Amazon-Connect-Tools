const { ConnectClient, ListQueuesCommand, SearchContactsCommand } = require('@aws-sdk/client-connect');

// Initialize AWS SDK v3 client
// Use the Lambda function's region (AWS_REGION environment variable)
const connect = new ConnectClient({ region: process.env.AWS_REGION });

/**
 * Lambda handler for Connect Heatmap API
 * Supports multiple endpoints:
 * - GET /queues - List all queues in Connect instance
 * - GET /heatmap - Get call volume heatmap data
 */
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle OPTIONS request for CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    // Extract path and method
    const path = event.path || event.resource;
    const method = event.httpMethod;

    // Route to appropriate handler
    if (path.includes('/queues') && method === 'GET') {
      return await handleListQueues(event, headers);
    } else if (path.includes('/heatmap') && method === 'GET') {
      return await handleGetHeatmap(event, headers);
    } else {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Endpoint not found' })
      };
    }
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: error.message 
      })
    };
  }
};

/**
 * List all queues in the Connect instance
 */
async function handleListQueues(event, headers) {
  const instanceId = process.env.CONNECT_INSTANCE_ID;
  
  if (!instanceId) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Connect instance ID not configured' })
    };
  }

  try {
    const queues = [];
    let nextToken = null;

    // Fetch all queues (with pagination)
    do {
      const params = {
        InstanceId: instanceId,
        QueueTypes: ['STANDARD'],
        MaxResults: 100
      };
      
      if (nextToken) {
        params.NextToken = nextToken;
      }

      const command = new ListQueuesCommand(params);
      const response = await connect.send(command);
      
      if (response.QueueSummaryList) {
        queues.push(...response.QueueSummaryList.map(q => ({
          id: q.Id,
          arn: q.Arn,
          name: q.Name
        })));
      }

      nextToken = response.NextToken;
    } while (nextToken);

    // Sort by name
    queues.sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ queues })
    };
  } catch (error) {
    console.error('Error listing queues:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to list queues',
        message: error.message 
      })
    };
  }
}

/**
 * Get heatmap data for a specific queue and date range
 */
async function handleGetHeatmap(event, headers) {
  const instanceId = process.env.CONNECT_INSTANCE_ID;
  
  if (!instanceId) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Connect instance ID not configured' })
    };
  }

  // Extract query parameters
  const params = event.queryStringParameters || {};
  const queueIdParam = params.queueId;
  const startDate = params.startDate; // YYYY-MM-DD
  const endDate = params.endDate;     // YYYY-MM-DD

  // Validate parameters
  if (!queueIdParam || !startDate || !endDate) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ 
        error: 'Missing required parameters: queueId, startDate, endDate' 
      })
    };
  }

  // Support multiple queue IDs (comma-separated)
  const queueIds = queueIdParam.split(',').map(id => id.trim()).filter(id => id);

  try {
    // Parse dates
    const start = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T23:59:59Z');

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid date format. Use YYYY-MM-DD' })
      };
    }

    // Fetch metrics data from Connect for all selected queues
    const allMetricsData = [];
    for (const queueId of queueIds) {
      console.log(`Fetching metrics for queue: ${queueId}`);
      const metricsData = await fetchConnectMetrics(instanceId, queueId, start, end);
      allMetricsData.push(...metricsData);
    }
    
    // Process combined data into heatmap format
    const heatmap = processHeatmapData(allMetricsData);
    const dailyHeatmap = processDailyHeatmapData(allMetricsData);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        queueIds: queueIds,
        queueCount: queueIds.length,
        startDate,
        endDate,
        heatmap,
        dailyHeatmap,
        totalCalls: calculateTotalCalls(heatmap)
      })
    };
  } catch (error) {
    console.error('Error generating heatmap:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to generate heatmap',
        message: error.message 
      })
    };
  }
}

/**
 * Fetch contact records from Amazon Connect using SearchContacts
 * Gets actual call timestamps to build accurate hourly heatmap
 */
async function fetchConnectMetrics(instanceId, queueId, startDate, endDate) {
  const startDateTime = new Date(startDate);
  startDateTime.setUTCHours(0, 0, 0, 0);
  
  const endDateTime = new Date(endDate);
  endDateTime.setUTCHours(23, 59, 59, 999);
  
  const allContacts = [];
  let nextToken = null;
  
  do {
    const params = {
      InstanceId: instanceId,
      TimeRange: {
        Type: 'INITIATION_TIMESTAMP',
        StartTime: startDateTime,
        EndTime: endDateTime
      },
      SearchCriteria: {
        QueueIds: [queueId]
      },
      MaxResults: 100
    };
    
    if (nextToken) {
      params.NextToken = nextToken;
    }

    try {
      const command = new SearchContactsCommand(params);
      const response = await connect.send(command);
      
      if (response.Contacts && response.Contacts.length > 0) {
        allContacts.push(...response.Contacts);
      }
      
      nextToken = response.NextToken;
    } catch (error) {
      console.error('Error searching contacts:', error);
      throw error;
    }
  } while (nextToken);
  
  return allContacts;
}

/**
 * Process contact records into heatmap format
 * Returns array[7][24] where:
 * - First dimension is day of week (0=Monday, 6=Sunday)
 * - Second dimension is hour of day (0-23)
 */
function processHeatmapData(contacts) {
  // Initialize 7x24 array (7 days, 24 hours)
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  
  // Count each contact by the hour it was initiated
  contacts.forEach(contact => {
    if (!contact.InitiationTimestamp) {
      return;
    }
    
    const date = new Date(contact.InitiationTimestamp);
    const dayOfWeek = (date.getUTCDay() + 6) % 7; // Convert Sunday=0 to Monday=0
    const hour = date.getUTCHours();
    
    // Increment count for this hour
    heatmap[dayOfWeek][hour]++;
  });

  return heatmap;
}

/**
 * Calculate total calls across all days and hours
 */
function calculateTotalCalls(heatmap) {
  let total = 0;
  heatmap.forEach(day => {
    day.forEach(hour => {
      total += hour;
    });
  });
  return Math.round(total);
}

/**
 * Process contact records into daily heatmap format
 * Returns object keyed by date string (YYYY-MM-DD) with 24-hour arrays
 */
function processDailyHeatmapData(contacts) {
  const dailyHeatmap = {};

  contacts.forEach(contact => {
    if (!contact.InitiationTimestamp) return;

    const date = new Date(contact.InitiationTimestamp);
    const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD in UTC
    const hour = date.getUTCHours();

    if (!dailyHeatmap[dateKey]) {
      dailyHeatmap[dateKey] = Array(24).fill(0);
    }
    dailyHeatmap[dateKey][hour]++;
  });

  return dailyHeatmap;
}
