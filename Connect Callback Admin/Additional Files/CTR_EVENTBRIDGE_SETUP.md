# EventBridge + CTR Setup Guide for Callback Attempt Tracking

## Overview
This guide will help you set up EventBridge to process Contact Trace Records (CTR) and automatically detect when callbacks succeed or fail, enabling accurate attempt tracking.

## Architecture
```
Amazon Connect Callback → CTR Generated → EventBridge Rule → callback-ctr-processor Lambda → removecallback Lambda → DynamoDB
```

## What You Need to Provide

### For Each Region (US-EAST-1 and EU-CENTRAL-1):

1. **Amazon Connect Instance ARN**
   - Find in: AWS Console → Amazon Connect → Instances → Click your instance
   - Format: `arn:aws:connect:us-east-1:YOUR_AWS_ACCOUNT_ID:instance/YOUR_CONNECT_INSTANCE_ID`

2. **Existing removecallback Lambda Function Name**
   - Find in: AWS Console → Lambda → Functions → Search for "removecallback"
   - Example: `prod-connect-ccp-removecallback` or similar

3. **CTR Data Stream Configuration** (if not already enabled)
   - Check in: AWS Console → Amazon Connect → Data streaming
   - You need either:
     - **Kinesis Data Stream** (already configured), OR
     - **Amazon Connect Data Streaming to Kinesis** enabled

## Step-by-Step Setup

### PART 1: Deploy callback-ctr-processor Lambda Function

#### For US Region (us-east-1):

1. **Create Lambda Function**
   - Go to: AWS Console → Lambda → Create function
   - Choose: "Author from scratch"
   - Function name: `callback-ctr-processor-us`
   - Runtime: **Node.js 24.x**
   - Architecture: x86_64
   - Click "Create function"

2. **Upload Code**
   - Copy the code from `callback-ctr-processor-US.js`
   - In Lambda console → Code tab → Paste code
   - Click "Deploy"

3. **Configure Environment Variables**
   - Go to: Configuration tab → Environment variables → Edit
   - Add:
     - Key: `REMOVECALLBACK_FUNCTION_NAME`
     - Value: `[YOUR_REMOVECALLBACK_LAMBDA_NAME]` (e.g., `prod-connect-ccp-removecallback`)
   - Save

4. **Adjust Timeout**
   - Go to: Configuration tab → General configuration → Edit
   - Timeout: **30 seconds**
   - Memory: **256 MB** (default is fine)
   - Save

5. **Add Permissions**
   - Go to: Configuration tab → Permissions
   - Click on the execution role name (opens IAM)
   - Click "Add permissions" → "Create inline policy"
   - Choose JSON tab and paste:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "lambda:InvokeFunction"
         ],
         "Resource": "arn:aws:lambda:us-east-1:*:function:*removecallback*"
       }
     ]
   }
   ```
   - Name: `InvokeRemovecallbackPolicy`
   - Click "Create policy"

#### For EU Region (eu-central-1):

Repeat the same steps as US, but:
- Function name: `callback-ctr-processor-eu`
- Use code from `callback-ctr-processor-EU.js`
- Adjust Lambda ARN in permissions to `eu-central-1` region

---

### PART 2: Create EventBridge Rule

#### For US Region (us-east-1):

1. **Create EventBridge Rule**
   - Go to: AWS Console → EventBridge → Rules → Create rule
   - Name: `connect-callback-ctr-processor-us`
   - Description: `Trigger CTR processor for callback contacts`
   - Event bus: **default**
   - Rule type: **Rule with an event pattern**
   - Click "Next"

2. **Configure Event Pattern**
   - Event source: **AWS events or EventBridge partner events**
   - Creation method: **Custom pattern (JSON editor)**
   - Paste the following pattern:
   ```json
   {
     "source": ["aws.connect"],
     "detail-type": ["Amazon Connect Contact Trace Record"],
     "detail": {
       "InitiationMethod": ["CALLBACK"],
       "InstanceARN": ["arn:aws:connect:us-east-1:ACCOUNT_ID:instance/INSTANCE_ID"]
     }
   }
   ```
   - **REPLACE** `ACCOUNT_ID` and `INSTANCE_ID` with your actual values
   - Click "Next"

3. **Select Target**
   - Target types: **AWS service**
   - Select a target: **Lambda function**
   - Function: `callback-ctr-processor-us`
   - Click "Next"

4. **Configure Tags (Optional)**
   - Skip or add tags as needed
   - Click "Next"

5. **Review and Create**
   - Review settings
   - Click "Create rule"

#### For EU Region (eu-central-1):

Repeat the same steps as US, but:
- Rule name: `connect-callback-ctr-processor-eu`
- Update event pattern with EU Instance ARN
- Target function: `callback-ctr-processor-eu`

---

### PART 3: Enable CTR Streaming (if not already enabled)

Amazon Connect needs to stream CTRs to EventBridge for this to work.

#### Check Current Configuration:

1. Go to: AWS Console → Amazon Connect → Your Instance
2. Click on "Data streaming" in left menu
3. Check "Contact Trace Records (CTR)" section

#### If CTR Streaming is NOT Enabled:

1. In the CTR section, click "Edit"
2. Enable "Contact Trace Records"
3. Choose delivery method:
   - **Option A: Kinesis Data Stream** (recommended if you already have one)
   - **Option B: Amazon Data Firehose** (if you need long-term storage)
4. Save changes

**Note:** CTR events automatically flow to EventBridge regardless of Kinesis/Firehose configuration. The streaming setup ensures CTRs are generated.

---

### PART 4: Update removecallback Lambda

Your removecallback Lambda already has the logic to handle `CallAttemptOutcome`, but we need to verify it works correctly with the CTR processor invocations.

#### No code changes needed! ✅

The callback-ctr-processor formats the payload exactly like a Connect flow invocation, so your existing removecallback code will work as-is.

---

### PART 5: Remove Disconnect Flow (Optional but Recommended)

Since we're now using CTR events, the disconnect flow is no longer needed and can cause issues.

1. Go to: AWS Console → Amazon Connect → Contact flows
2. Find your "Outbound whisper flow" (the one used for callbacks)
3. Edit the flow
4. Remove the "Set disconnect flow" block if present
5. Save and publish

---

## Testing

### Test 1: Callback with Customer Answer

1. Create a callback through your portal
2. Have agent accept the callback
3. Customer answers and completes call
4. Check CloudWatch Logs for `callback-ctr-processor`:
   - Should see: `"callAttemptOutcome": "answered"`
   - Should see: `"Successfully invoked removecallback"`
5. Check your portal:
   - Callback should be in **History** table
   - Status: "Completed"
   - Attempts: "0/3"

### Test 2: Callback with No Answer

1. Create a callback through your portal
2. Have agent accept the callback
3. Customer does NOT answer (rings out or busy)
4. Check CloudWatch Logs for `callback-ctr-processor`:
   - Should see: `"callAttemptOutcome": "no_answer"`
   - Should see: `"Successfully invoked removecallback"`
5. Check your portal:
   - Callback should still be in **Active** table
   - Attempts should increment: "1/3", then "2/3", etc.

### Test 3: Max Retries Exceeded

1. Let a callback fail 3 times (attempts 0, 1, 2)
2. After 3rd failure, check portal:
   - Callback should be in **History** table
   - Status: "Failed" or "Max Retries"
   - Attempts: "2/3"

---

## Monitoring

### CloudWatch Logs

Monitor these log groups:
- `/aws/lambda/callback-ctr-processor-us` (or `-eu`)
- `/aws/lambda/[your-removecallback-function-name]`

### Key Log Messages to Watch For:

**Success:**
```
[callback-ctr-processor] Processing callback CTR
[callback-ctr-processor] Successfully invoked removecallback
[removecallback] Found callback to complete
[removecallback] Successfully moved to history table
```

**Errors:**
```
[callback-ctr-processor] Missing phone number in CTR
[callback-ctr-processor] Error processing CTR
[removecallback] Callback not found in main table
```

### EventBridge Rule Metrics

Check EventBridge metrics:
- Go to: EventBridge → Rules → Your rule → Monitoring tab
- Watch for: "Invocations", "Failed invocations", "Throttled rules"

---

## Troubleshooting

### CTR Events Not Triggering Lambda

**Check:**
1. EventBridge rule is **Enabled**
2. Event pattern matches your Connect Instance ARN exactly
3. CTR streaming is enabled in Amazon Connect
4. Lambda function has EventBridge trigger visible in Configuration → Triggers

**Fix:**
- Verify Instance ARN in event pattern
- Check EventBridge rule metrics for matched events
- Test with a manual event in Lambda console

### Lambda Execution Fails

**Check:**
1. Lambda has permission to invoke removecallback
2. Environment variable `REMOVECALLBACK_FUNCTION_NAME` is correct
3. Lambda timeout is sufficient (30 seconds)

**Fix:**
- Review IAM role permissions
- Check CloudWatch logs for error details
- Verify removecallback function name

### Callbacks Not Moving to History

**Check:**
1. CTR contains phone number in correct field
2. removecallback Lambda can find callback by phone number
3. DynamoDB table names are correct

**Fix:**
- Check CloudWatch logs for both Lambdas
- Verify phone number format matches DynamoDB key
- Check DynamoDB table for callback entry

### Customer Answered but Marked as No Answer

**Check:**
1. CTR contains `Customer.ConnectedToSystemTimestamp`
2. Callback completed successfully (not dropped)

**Fix:**
- Review CTR event in CloudWatch logs
- Verify customer actually answered (agent should have spoken to them)
- Check for network issues or call quality problems

---

## Cost Estimate

- **EventBridge:** $1.00 per million events (first 1M free/month)
- **Lambda:** $0.20 per 1M requests + $0.0000166667 per GB-second
- **CloudWatch Logs:** $0.50 per GB ingested

**Example:** 10,000 callbacks/month = ~$0.01/month (essentially free within free tier)

---

## What I Need From You

To help you deploy this, please provide:

1. **Amazon Connect Instance ARN** (US and EU regions)
   - Format: `arn:aws:connect:REGION:ACCOUNT:instance/INSTANCE_ID`

2. **Existing removecallback Lambda function names**
   - US region: ?
   - EU region: ?

3. **Confirm CTR streaming status**
   - Is it already enabled in your Connect instances?
   - If yes, which delivery method (Kinesis/Firehose)?

4. **Deployment preference**
   - Do you want to deploy manually following this guide?
   - Or would you like me to create CloudFormation/Terraform templates?

Once you provide these details, I can customize the EventBridge patterns and help you deploy!
