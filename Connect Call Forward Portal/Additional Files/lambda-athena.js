const { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } = require('@aws-sdk/client-athena');
const { ConnectClient, DescribeQueueCommand, DescribeUserCommand } = require('@aws-sdk/client-connect');

const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const connectClient = new ConnectClient({ region: process.env.AWS_REGION });

const ATHENA_DATABASE = 'connect_ctr';
const ATHENA_TABLE = 'contact_trace_records';
const ATHENA_OUTPUT_LOCATION = 's3://aws-athena-query-results-us-east-1/';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const path = event.path || event.resource;
    const method = event.httpMethod;

    if ((path.includes('/flow-data') || path.includes('/contact-search')) && method === 'GET') {
      return await handleFlowData(event, headers);
    } else {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Endpoint not found' }) };
    }
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error', message: error.message }) };
  }
};

async function handleFlowData(event, headers) {
  const instanceId = process.env.CONNECT_INSTANCE_ID;
  const params = event.queryStringParameters || {};
  const queueIds = params.queueIds ? params.queueIds.split(',') : [];
  const startTime = params.startTime;
  const endTime = params.endTime;

  if (!startTime || !endTime) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'startTime and endTime required' }) };
  }

  console.log('Querying CTR via Athena:', startTime, 'to', endTime);

  // Build Athena SQL query
  let queueFilter = '';
  if (queueIds.length > 0) {
    const queueArns = queueIds.map(id => `'%${id}%'`).join(' OR queue.arn LIKE ');
    queueFilter = `AND (queue.arn LIKE ${queueArns})`;
  }

  const query = `
    SELECT 
      contactid,
      initiationtimestamp,
      queue.arn as queue_arn,
      agent.arn as agent_arn,
      nextcontactid,
      disconnectreason
    FROM ${ATHENA_DATABASE}.${ATHENA_TABLE}
    WHERE initiationtimestamp >= '${startTime}'
      AND initiationtimestamp <= '${endTime}'
      ${queueFilter}
    ORDER BY initiationtimestamp
    LIMIT 10000
  `;

  console.log('Athena Query:', query);

  const queryId = await startAthenaQuery(query);
  console.log('Query ID:', queryId);

  const results = await waitForQueryResults(queryId);
  console.log('Retrieved', results.length, 'CTR records');

  const flowData = await processFlowFromResults(results, instanceId);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ totalContacts: results.length, flows: flowData })
  };
}

async function startAthenaQuery(query) {
  const params = {
    QueryString: query,
    QueryExecutionContext: { Database: ATHENA_DATABASE },
    ResultConfiguration: { OutputLocation: ATHENA_OUTPUT_LOCATION }
  };

  const command = new StartQueryExecutionCommand(params);
  const response = await athenaClient.send(command);
  return response.QueryExecutionId;
}

async function waitForQueryResults(queryId, maxWaitSeconds = 20) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitSeconds * 1000) {
    const command = new GetQueryExecutionCommand({ QueryExecutionId: queryId });
    const execution = await athenaClient.send(command);
    const state = execution.QueryExecution.Status.State;

    console.log('Query state:', state);

    if (state === 'SUCCEEDED') {
      return await getQueryResults(queryId);
    } else if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Query ${state}: ${execution.QueryExecution.Status.StateChangeReason}`);
    }

    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
  }

  throw new Error('Query timeout');
}

async function getQueryResults(queryId) {
  const command = new GetQueryResultsCommand({ QueryExecutionId: queryId });
  const response = await athenaClient.send(command);

  const rows = response.ResultSet.Rows;
  if (rows.length <= 1) return []; // No data (only header row)

  const headers = rows[0].Data.map(col => col.VarCharValue);
  const results = [];

  for (let i = 1; i < rows.length; i++) {
    const row = {};
    rows[i].Data.forEach((col, index) => {
      row[headers[index]] = col.VarCharValue;
    });
    results.push(row);
  }

  return results;
}

async function processFlowFromResults(results, instanceId) {
  const flows = {};
  const queueCache = {};
  const agentCache = {};

  const getQueueName = async (queueArn) => {
    if (!queueArn) return 'Unknown Queue';
    const queueId = queueArn.split('/').pop();
    if (queueCache[queueId]) return queueCache[queueId];

    try {
      const cmd = new DescribeQueueCommand({ InstanceId: instanceId, QueueId: queueId });
      const resp = await connectClient.send(cmd);
      queueCache[queueId] = resp.Queue.Name;
      return resp.Queue.Name;
    } catch (err) {
      console.error('Error fetching queue', queueId + ':', err.message);
      queueCache[queueId] = 'Unknown Queue';
      return 'Unknown Queue';
    }
  };

  const getAgentName = async (agentArn) => {
    if (!agentArn) return null;
    const agentId = agentArn.split('/').pop();
    if (agentCache[agentId]) return agentCache[agentId];

    try {
      const cmd = new DescribeUserCommand({ InstanceId: instanceId, UserId: agentId });
      const resp = await connectClient.send(cmd);
      agentCache[agentId] = resp.User.Username;
      return resp.User.Username;
    } catch (err) {
      console.error('Error fetching agent', agentId + ':', err.message);
      agentCache[agentId] = 'Unknown Agent';
      return 'Unknown Agent';
    }
  };

  // Build contact map for finding transfers
  const contactMap = {};
  results.forEach(ctr => {
    contactMap[ctr.contactid] = ctr;
  });

  for (const ctr of results) {
    try {
      const queueName = await getQueueName(ctr.queue_arn);

      if (ctr.agent_arn) {
        const agentName = await getAgentName(ctr.agent_arn);
        const agentWithQueue = agentName + ' (' + queueName + ')';
        const initialFlow = queueName + '→' + agentWithQueue;
        flows[initialFlow] = (flows[initialFlow] || 0) + 1;

        // Check for transfer
        if (ctr.nextcontactid) {
          const nextCtr = contactMap[ctr.nextcontactid];
          if (nextCtr && nextCtr.queue_arn) {
            const nextQueueName = await getQueueName(nextCtr.queue_arn);

            if (nextCtr.agent_arn) {
              const nextAgentName = await getAgentName(nextCtr.agent_arn);
              const nextAgentWithQueue = nextAgentName + ' (' + nextQueueName + ')';
              const transferFlow = agentWithQueue + '→' + nextAgentWithQueue;
              flows[transferFlow] = (flows[transferFlow] || 0) + 1;
            } else {
              const transferFlow = agentWithQueue + '→' + nextQueueName;
              flows[transferFlow] = (flows[transferFlow] || 0) + 1;
            }
          }
        }
      } else {
        const abandonedFlow = queueName + '→Abandoned/Disconnected';
        flows[abandonedFlow] = (flows[abandonedFlow] || 0) + 1;
      }
    } catch (err) {
      console.error('Error processing CTR:', err.message);
    }
  }

  const flowArray = Object.entries(flows).map(([path, count]) => {
    const parts = path.split('→');
    return { source: parts[0], target: parts[1], value: count };
  });

  console.log('Processed', flowArray.length, 'unique flows');
  return flowArray;
}
