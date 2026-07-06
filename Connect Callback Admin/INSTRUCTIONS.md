# Installation & Setup - Connect Callback Admin

> **Built on an AWS reference solution - deploy that first.**
> This tool sits on top of the AWS Contact Center blog post
> [Preventing duplicate callback requests in Amazon Connect](https://aws.amazon.com/blogs/contact-center/preventing-duplicate-callback-requests-in-amazon-connect/).
> That solution is the small `writecallback` / `readcallback` script that logs each
> callback into a DynamoDB table, removes it when the callback is done, and checks
> whether a caller already has a callback pending. **Set that up first** - this admin
> portal only adds a UI + CTR-based auto-archiving on top of it.

> **Disclaimer:** This is a public/standalone extraction of an internal deployment.
> All corporate/account-specific data has been replaced with named placeholders, and
> the internal user/group queue-permission layer plus the Cognito login have been
> removed. Treat this as a working reference, not a turnkey drop-in.

## Prerequisites
- The AWS "duplicate callback prevention" solution above, deployed (or at least the
  `Callback` / `CallbackHistory` tables and `writecallback` / `readcallback` Lambdas)
- An AWS account with permission to deploy Lambda, API Gateway, DynamoDB, EventBridge, and IAM
- AWS CLI and AWS SAM CLI installed and configured (`aws configure`)
- An Amazon Connect instance (instance ID required)
- Node.js 22.x

## Access control - read this first
- The internal group/user queue-permission layer **and the Cognito login have been
  removed**. The API is open and the page loads data directly with no sign-in.
- Add your own access control (Cognito authorizer, IAM, WAF, or an SSO proxy) before
  exposing this publicly.

## Install
1. Replace every placeholder listed below with your own values.
2. Backend (US): `sam build` then `sam deploy --guided -t template-us.yaml`.
   Backend (EU, optional): repeat with `template-eu.yaml`.
   The templates create the `Callback` + `CallbackHistory` tables, the admin API,
   the EventBridge CTR processor, and the `readcallback` / `writecallback` flow Lambdas.
   (Lambda code lives in `Additional Files/Lambda/...`; the template CodeUri paths
   already point there.)
3. Copy the `ApiUrl` from the SAM output into the `REGION_CONFIG` block near the top
   of `index.html` (the `apiBaseUrl` value).
4. Wire your contact flows to the `writecallback` / `readcallback` Lambdas (see the
   AWS blog for the flow design).
5. Host the frontend: upload `index.html` + assets to S3 (or any static host) and, if
   using CloudFront, invalidate the cache.
6. Open the page and verify it lists callbacks from your table.

## Be aware
- Region, Connect instance IDs, and resource names must match your environment.
- Review the IAM policy JSON files under `Additional Files/` and scope them to least privilege.
- The EU stack is optional; remove the EU region entry from `REGION_CONFIG` if you run one region.

## Placeholders to replace

### `YOUR_CONNECT_INSTANCE_ID`

Your Amazon Connect instance ID (the ARN ends in `instance/<this-id>`).

Appears in: `template-us.yaml`, `template-eu.yaml`,
`Additional Files/eventbridge-pattern-us.json`, `Additional Files/eventbridge-pattern-eu.json`,
`Additional Files/Lambda/Main admin portal API lambda/index.js`.

### `YOUR_API_ID`

API Gateway ID from your SAM deploy output (the 10-char subdomain in the
`...execute-api...` URL). Paste into the `apiBaseUrl` in the `index.html` config block.

### `YOUR_CLOUDFRONT_DOMAIN`

Your CloudFront domain, e.g. `dxxxxxxxx.cloudfront.net`. Used in the CORS allow-list.

Appears in: `template-us.yaml`, `Additional Files/Lambda/Main admin portal API lambda/index.js`.

### `your-portal-domain.example.com`

Your custom portal domain, if you use one (CORS allow-list).

Appears in: `Additional Files/Lambda/Main admin portal API lambda/index.js`,
`Additional Files/DOCUMENTATION.html`.

### `YOUR_AWS_ACCOUNT_ID`

Your 12-digit AWS account ID. Usually injected automatically via `${AWS::AccountId}`
in the SAM templates; only edit the standalone policy JSON files by hand.

Appears in: `Additional Files/eventbridge-pattern-*.json`,
`Additional Files/invoke-policy-*.json`, `Additional Files/kinesis-policy.json`.

### `your-org`

Your organization short name/alias (used in resource names).

Appears in: `Additional Files/kinesis-policy.json`.

---
Frontend values live in the `REGION_CONFIG` block near the top of `index.html`;
backend values are `template-us.yaml` / `template-eu.yaml` parameters that
`sam deploy --guided` will prompt for.
