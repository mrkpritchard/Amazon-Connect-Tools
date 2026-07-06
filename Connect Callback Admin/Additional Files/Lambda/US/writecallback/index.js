'use strict';
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TableName || 'Callback';
const HISTORY_TABLE_NAME = process.env.HistoryTableName || process.env.HISTORY_TABLE || 'CallbackHistory';

exports.handler = async (event) => {
  try {
    const attributes = event.Details.ContactData.Attributes;
    const phoneNumber = attributes.CallbackNumber;
    const holdTime = attributes.HoldTime ?? null;
    const cbqueue = attributes.cbqueue ?? null;
    const queue = event.Details.ContactData.Queue.Name;
    const contactId = event.Details.ContactData.ContactId;

    const now = new Date();
    const isoUtc = now.toISOString();
    const epochSeconds = Math.floor(now.getTime() / 1000);

    // Check if an entry already exists for this phone+queue
    try {
      const existingQuery = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PhoneNumber = :phone AND QueueName = :queue',
        ExpressionAttributeValues: {
          ':phone': phoneNumber,
          ':queue': queue
        },
        Limit: 1
      }));

      const existingItem = existingQuery.Items?.[0];
      
      // If entry exists and is ACTIVE (not completed), don't overwrite - callback already exists
      if (existingItem && existingItem.Status !== 'Completed' && !existingItem.CompletedAt) {
        console.log('Active callback already exists, skipping write:', { phoneNumber, queue });
        return { statusCode: 200, body: JSON.stringify({ CallbackWrite: 'Success', message: 'Callback already exists' }) };
      }
      
      // If entry exists and is COMPLETED, move it to history table and delete from main table
      if (existingItem && (existingItem.Status === 'Completed' || existingItem.CompletedAt)) {
        console.log('Found COMPLETED entry, moving to history table:', { 
          phoneNumber, 
          queue, 
          historyTable: HISTORY_TABLE_NAME,
          existingItemKeys: Object.keys(existingItem)
        });
        
        // Copy to history table with a unique key (add archived timestamp to prevent key conflicts)
        const historyItem = {
          ...existingItem,
          PhoneNumber: phoneNumber,
          QueueName: queue,
          ArchivedAt: isoUtc,
          ArchivedEpoch: epochSeconds,
          OriginalContactId: existingItem.ContactId,
          OriginalCallbackContactId: existingItem.CallbackContactId || null
        };
        
        const historyKey = {
          PhoneNumber: phoneNumber,
          ArchivedAt: isoUtc // Sort key to allow multiple completed entries
        };
        
        try {
          console.log('Attempting to write to history table:', {
            table: HISTORY_TABLE_NAME,
            key: historyKey,
            itemHasPhone: !!historyItem.PhoneNumber
          });
          
          // Use PhoneNumber as PK and ArchivedAt as SK to allow multiple history entries per phone
          const putResult = await ddb.send(new PutCommand({
            TableName: HISTORY_TABLE_NAME,
            Item: {
              ...historyItem,
              ...historyKey
            }
          }));
          
          console.log('Successfully moved COMPLETED entry to history table', { 
            result: putResult,
            historyTable: HISTORY_TABLE_NAME
          });
          
          // Delete the completed entry from main table so new entry can be created
          const deleteResult = await ddb.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              PhoneNumber: phoneNumber,
              QueueName: queue
            }
          }));
          
          console.log('Deleted COMPLETED entry from main table', { deleteResult });
        } catch (historyErr) {
          console.error('Error moving to history table:', {
            error: historyErr.message,
            name: historyErr.name,
            code: historyErr.code,
            stack: historyErr.stack,
            historyTable: HISTORY_TABLE_NAME,
            historyKey,
            phoneNumber,
            queue
          });
          // Continue anyway - we'll still create the new entry
        }
      }
    } catch (historyError) {
      // Log but don't fail - history is nice-to-have, main callback write should succeed
      console.warn('Error checking/moving to history table (continuing anyway):', historyError);
    }

    // Create the new callback entry with attempt tracking initialized
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PhoneNumber: phoneNumber, // PK
        ContactId: contactId,
        QueueName: queue,
        HoldTime: holdTime,
        cbqueue: cbqueue,
        timeStamp: isoUtc,
        epoch: epochSeconds,
        AttemptNumber: 0,
        LastAttemptOutcome: null,
        MaxRetries: 3
      }
    }));

    return { statusCode: 200, body: JSON.stringify({ CallbackWrite: 'Success' }) };
  } catch (err) {
    console.error('Error writing callback:', err);
    return { statusCode: 500, body: JSON.stringify({ CallbackWrite: 'Failed' }) };
  }
};