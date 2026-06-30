# Installation & Setup - Connect SBR Portal

> **Disclaimer:** This tool was extracted from a customized internal deployment
> and stripped of all corporate/account-specific data. Every organization value
> has been replaced with a named placeholder. A fresh setup will likely need some
> adjustments for your own AWS account, Amazon Connect instance, and naming. Treat
> this as a working reference, not a turnkey drop-in.

## Prerequisites
- An AWS account with permission to deploy Lambda, API Gateway, S3, and IAM
- AWS CLI and AWS SAM CLI installed and configured (`aws configure`)
- An Amazon Connect instance (instance ID required)
- Node.js or Python installed, depending on the tool's runtime

## Install
1. Replace every placeholder listed below with your own values.
2. Backend: `sam build` then `sam deploy --guided` (prompts for `template.yaml` params).
3. Copy the API URL from the SAM output into the config block near the top of `app.js`.
4. Host the frontend: upload `index.html` and assets to S3 (or any static host).
5. Open the page and verify it connects to your backend.

## Be aware
- Authentication uses Amazon Cognito - add your own user pool/client or replace with your access control before exposing publicly.
- Region, Connect instance IDs, and resource names must match your environment.
- This tool keeps a `region -> instance` map (US/EU). Fill in only the regions you use and remove the rest.
- Review IAM policy JSON files and scope them to least privilege.

## Placeholders to replace

## `YOUR_USER_POOL_ID`
Cognito user pool ID (e.g. us-east-1_XXXXXXXXX). Appears in: `app.js`

## `YOUR_CLIENT_ID`
Cognito app client ID (26-char alphanumeric). Appears in: `app.js`

## `YOUR_US_API_GATEWAY_URL` / `YOUR_EU_API_GATEWAY_URL`
Your API Gateway invoke URL per region. Appears in: `app.js`

## `YOUR_US_INSTANCE_ID` / `YOUR_EU_INSTANCE_ID`
Your Amazon Connect instance ID per region. Appears in: `app.js`

---
Frontend values live in the config block near the top of `app.js`; backend values are
`template.yaml` parameters that `sam deploy --guided` will prompt for.
