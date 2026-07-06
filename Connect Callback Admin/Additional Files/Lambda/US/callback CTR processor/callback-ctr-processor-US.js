'use strict';

/**
 * Lambda: callback-ctr-processor
 * Purpose: Process Contact Trace Records (CTR) from EventBridge to detect callback outcomes
 * Trigger: EventBridge rule on Amazon Connect CTR events
 * 
 * This Lambda:
 * 1. Receives CTR events for callback contacts
 * 2. Checks if customer actually answered (Agent.ConnectedToAgentTimestamp exists)
 * 3. Directly updates DynamoDB:
 *    - If answered: Moves callback to history (complete)
 *    - If no answer: Increments attempt count, checks if max retries reached
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || 'us-east-1';
const CALLBACKS_TABLE = process.env.CALLBACKS_TABLE || 'Callback';
const HISTORY_TABLE = process.env.HISTORY_TABLE || 'CallbackHistory';

const dynamoDbClient = new DynamoDBClient({ region: REGION });
const ddbDocClient = DynamoDBDocumentClient.from(dynamoDbClient);

exports.handler = async (event) => {
  console.log('[callback-ctr-processor] Received event:', JSON.stringify(event, null, 2));

  try {
    // Handle both EventBridge and Kinesis event formats
    let ctr;
    
    // Check if this is a Kinesis event (from CTR data stream)
    if (event.Records && event.Records[0]?.kinesis) {
      console.log('[callback-ctr-processor] Processing Kinesis stream event');
      const record = event.Records[0];
      const payload = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
      ctr = JSON.parse(payload);
    } 
    // Check if this is an EventBridge event
    else if (event.detail) {
      console.log('[callback-ctr-processor] Processing EventBridge event');
      ctr = event.detail;
    }
    // Unknown format
    else {
      console.error('[callback-ctr-processor] Unknown event format:', event);
      return { statusCode: 400, body: 'Unknown event format' };
    }

    // Validate this is a callback contact
    if (ctr.InitiationMethod !== 'CALLBACK') {
      console.log('[callback-ctr-processor] Not a callback contact, skipping:', {
        initiationMethod: ctr.InitiationMethod,
        contactId: ctr.ContactId
      });
      return { statusCode: 200, body: 'Not a callback contact' };
    }

    // Extract key information
    const contactId = ctr.ContactId;
    const phoneNumber = ctr.CustomerEndpoint?.Address || ctr.Attributes?.CallbackNumber;
    const queueName = ctr.Queue?.Name;
    const disconnectReason = ctr.DisconnectReason;
    
    // Detect if customer answered by checking if agent was connected
    // ConnectedToAgentTimestamp is only set when the customer actually picks up and connects to the agent
    const agentConnectedTime = ctr.Agent?.ConnectedToAgentTimestamp;
    const disconnectTime = ctr.DisconnectTimestamp;
    
    // Customer answered if:
    // 1. Agent was connected to them (ConnectedToAgentTimestamp exists)
    const customerAnswered = !!(agentConnectedTime);
    const callAttemptOutcome = customerAnswered ? 'answered' : 'no_answer';

    console.log('[callback-ctr-processor] Processing callback CTR:', {
      contactId,
      phoneNumber,
      queueName,
      initiationMethod: ctr.InitiationMethod,
      agentConnectedTime,
      customerAnswered,
      callAttemptOutcome,
      disconnectReason,
      disconnectTime
    });

    // Validate required fields
    if (!phoneNumber) {
      console.error('[callback-ctr-processor] Missing phone number in CTR:', {
        contactId,
        customerEndpoint: ctr.CustomerEndpoint,
        attributes: ctr.Attributes
      });
      return { statusCode: 400, body: 'Missing phone number in CTR' };
    }

    if (!queueName) {
      console.warn('[callback-ctr-processor] Missing queue name in CTR:', {
        contactId,
        phoneNumber
      });
      return { statusCode: 400, body: 'Missing queue name in CTR' };
    }

    // Find callback in DynamoDB by phone number only (queue may differ between original and callback)
    // Note: The callback may be stored with the original queue name, but CTR has the callback queue name
    console.log('[callback-ctr-processor] Looking up callback in DynamoDB:', {
      phoneNumber,
      ctrQueueName: queueName,
      table: CALLBACKS_TABLE
    });

    const queryResult = await ddbDocClient.send(new QueryCommand({
      TableName: CALLBACKS_TABLE,
      KeyConditionExpression: 'PhoneNumber = :phone',
      ExpressionAttributeValues: {
        ':phone': phoneNumber
      },
      ConsistentRead: true
    }));

    if (!queryResult.Items || queryResult.Items.length === 0) {
      console.warn('[callback-ctr-processor] Callback not found in DynamoDB:', {
        phoneNumber,
        ctrQueueName: queueName,
        contactId
      });
      // This is not necessarily an error - callback might have been moved or deleted
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Callback not found in database',
          phoneNumber,
          queueName,
          contactId
        })
      };
    }

    // Get the first (and should be only) callback for this phone number
    const callback = queryResult.Items[0];
    const storedQueueName = callback.QueueName;
    
    console.log('[callback-ctr-processor] Found callback (queue mismatch is normal):', {
      phoneNumber,
      storedQueueName,
      ctrQueueName: queueName,
      callbackId: callback.CallbackContactId
    });
    
    console.log('[callback-ctr-processor] Processing outcome:', {
      phoneNumber,
      storedQueueName,
      currentAttempt: callback.AttemptNumber || 0,
      maxRetries: callback.MaxRetries || 3,
      customerAnswered,
      callAttemptOutcome
    });

    if (customerAnswered) {
      // Customer answered - complete callback and move to history
      console.log('[callback-ctr-processor] Customer answered - completing callback:', {
        phoneNumber,
        storedQueueName,
        ctrQueueName: queueName,
        contactId
      });

      const now = new Date();
      const completedAt = now.toISOString();
      const completedEpoch = Math.floor(now.getTime() / 1000);

      // Calculate time in queue
      let timeInQueue = null;
      const createdEpoch = callback.epoch || (callback.timeStamp ? Math.floor(new Date(callback.timeStamp).getTime() / 1000) : null);
      if (createdEpoch && completedEpoch) {
        timeInQueue = completedEpoch - createdEpoch;
      }

      // Create history item
      const historyItem = {
        ...callback,
        PhoneNumber: phoneNumber,
        QueueName: storedQueueName,
        Status: 'Completed',
        CompletedAt: completedAt,
        CompletedEpoch: completedEpoch,
        TimeInQueue: timeInQueue,
        ArchivedAt: completedAt,
        ArchivedEpoch: completedEpoch,
        LastAttemptOutcome: 'answered',
        OriginalContactId: callback.ContactId,
        OriginalCallbackContactId: callback.CallbackContactId || contactId
      };

      // Write to history table
      await ddbDocClient.send(new PutCommand({
        TableName: HISTORY_TABLE,
        Item: historyItem
      }));

      // Delete from callbacks table (was incorrectly using UpdateCommand)
      await ddbDocClient.send(new DeleteCommand({
        TableName: CALLBACKS_TABLE,
        Key: {
          PhoneNumber: phoneNumber,
          QueueName: storedQueueName
        }
      }));

      console.log('[callback-ctr-processor] Successfully completed callback:', {
        phoneNumber,
        storedQueueName,
        contactId,
        completedAt
      });

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Callback completed - moved to history',
          phoneNumber,
          queueName: storedQueueName,
          contactId,
          outcome: 'answered'
        })
      };
    } else {
      // No answer - increment attempt count and check if max retries reached
      const currentAttempt = callback.AttemptNumber || 0;  // Start at 0 (no attempts made yet)
      const maxRetries = callback.MaxRetries || 3;
      const nextAttempt = currentAttempt + 1;  // First failed attempt becomes 1

      console.log('[callback-ctr-processor] No answer - incrementing attempt:', {
        phoneNumber,
        storedQueueName,
        currentAttempt,
        nextAttempt,
        maxRetries,
        maxRetriesReached: nextAttempt > maxRetries
      });

      if (nextAttempt > maxRetries) {
        // Max retries reached - move to history with Failed status
        console.log('[callback-ctr-processor] Max retries reached - failing callback:', {
          phoneNumber,
          storedQueueName,
          contactId,
          attempts: nextAttempt,
          maxRetries
        });

        const now = new Date();
        const completedAt = now.toISOString();
        const completedEpoch = Math.floor(now.getTime() / 1000);

        // Calculate time in queue
        let timeInQueue = null;
        const createdEpoch = callback.epoch || (callback.timeStamp ? Math.floor(new Date(callback.timeStamp).getTime() / 1000) : null);
        if (createdEpoch && completedEpoch) {
          timeInQueue = completedEpoch - createdEpoch;
        }

        // Create history item
        const historyItem = {
          ...callback,
          PhoneNumber: phoneNumber,
          QueueName: storedQueueName,
          Status: 'Failed',
          AttemptNumber: nextAttempt,
          FinalAttemptNumber: nextAttempt,
          CompletedAt: completedAt,
          CompletedEpoch: completedEpoch,
          TimeInQueue: timeInQueue,
          ArchivedAt: completedAt,
          ArchivedEpoch: completedEpoch,
          LastAttemptOutcome: 'no_answer',
          OriginalContactId: callback.ContactId,
          OriginalCallbackContactId: callback.CallbackContactId || contactId
        };

        // Write to history table
        await ddbDocClient.send(new PutCommand({
          TableName: HISTORY_TABLE,
          Item: historyItem
        }));

        // Delete from callbacks table (was incorrectly using UpdateCommand)
        await ddbDocClient.send(new DeleteCommand({
          TableName: CALLBACKS_TABLE,
          Key: {
            PhoneNumber: phoneNumber,
            QueueName: storedQueueName
          }
        }));

        console.log('[callback-ctr-processor] Successfully failed callback - moved to history:', {
          phoneNumber,
          storedQueueName,
          contactId,
          finalAttempt: nextAttempt,
          maxRetries
        });

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: 'Callback failed after max retries - moved to history',
            phoneNumber,
            queueName: storedQueueName,
            contactId,
            outcome: 'no_answer',
            finalAttempt: nextAttempt,
            maxRetries
          })
        };
      } else {
        // More attempts remaining - just increment counter
        console.log('[callback-ctr-processor] Incrementing attempt counter:', {
          phoneNumber,
          storedQueueName,
          contactId,
          newAttempt: nextAttempt,
          maxRetries
        });

        await ddbDocClient.send(new UpdateCommand({
          TableName: CALLBACKS_TABLE,
          Key: {
            PhoneNumber: phoneNumber,
            QueueName: storedQueueName
          },
          UpdateExpression: 'SET AttemptNumber = :attempt, LastAttemptOutcome = :outcome, LastAttemptAt = :now',
          ExpressionAttributeValues: {
            ':attempt': nextAttempt,
            ':outcome': 'no_answer',
            ':now': new Date().toISOString()
          }
        }));

        console.log('[callback-ctr-processor] Successfully incremented attempt counter:', {
          phoneNumber,
          storedQueueName,
          contactId,
          newAttempt: nextAttempt,
          maxRetries
        });

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: 'Callback attempt incremented - will retry',
            phoneNumber,
            queueName: storedQueueName,
            contactId,
            outcome: 'no_answer',
            newAttempt: nextAttempt,
            maxRetries,
            attemptsRemaining: maxRetries - nextAttempt
          })
        };
      }
    }

  } catch (error) {
    console.error('[callback-ctr-processor] Error processing CTR:', {
      error: error.message,
      stack: error.stack,
      event: JSON.stringify(event, null, 2)
    });

    // Don't throw - we don't want EventBridge to retry
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error processing CTR',
        error: error.message
      })
    };
  }
};
