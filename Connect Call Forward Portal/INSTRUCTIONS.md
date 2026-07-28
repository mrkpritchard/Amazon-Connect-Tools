# Installation & Setup - Connect Call Forward Report

> **Disclaimer:** This tool was extracted from a customized internal deployment
> and stripped of all corporate/account-specific data. Every organization value
> has been replaced with a named placeholder. A fresh setup will likely need some
> adjustments for your own AWS account, Amazon Connect instance, and naming. Treat
> this as a working reference, not a turnkey drop-in.

## Prerequisites
- An AWS account with permission to deploy Lambda, API Gateway, S3, and IAM
- AWS CLI and AWS SAM CLI installed and configured (`aws configure`)
- An Amazon Connect instance (instance ID required for most tools)
- Node.js or Python installed, depending on the tool's runtime

## Install
1. Replace every placeholder listed below with your own values.
2. Backend: `sam build` then `sam deploy --guided` (prompts for `template.yaml` params).
3. Copy the API URL from the SAM output into the config block near the top of `index.html`.
4. Host the frontend: upload `index.html` and assets to S3 (or any static host).
5. Open the page and verify it connects to your backend.

## Be aware
- Authentication was removed for standalone use - add your own access control before exposing publicly.
- Region, Connect instance IDs, and resource names must match your environment.
- Review IAM policy JSON files and scope them to least privilege.

## Placeholders to replace

## `YOUR_AWS_ACCOUNT_ID`

Your 12-digit AWS account ID. AWS Console -> top-right account menu. Usually passed automatically via ${AWS::AccountId} in the SAM template.

Appears in:
- connect-policy.json (line 17)
- lambda_function.py (line 16)
- lambda_function.py (line 21)
- Additional Files\athena-policy.json (line 22)
- Additional Files\athena-policy.json (line 23)
- Additional Files\athena-policy.json (line 35)
- Additional Files\athena-policy.json (line 36)
- Additional Files\athena-s3-policy.json (line 16)
- Additional Files\athena-s3-policy.json (line 17)
- Additional Files\athena-s3-policy.json (line 27)
- Additional Files\athena-s3-policy.json (line 28)
- Additional Files\firehose-config-eu.json (line 5)
- Additional Files\firehose-config-eu.json (line 6)
- Additional Files\firehose-config-eu.json (line 9)
- Additional Files\firehose-config-eu.json (line 10)
- Additional Files\firehose-config-us.json (line 5)
- Additional Files\firehose-config-us.json (line 6)
- Additional Files\firehose-config-us.json (line 9)
- Additional Files\firehose-config-us.json (line 10)
- Additional Files\firehose-permissions-eu.json (line 13)
- Additional Files\firehose-permissions-eu.json (line 27)
- Additional Files\firehose-permissions-eu.json (line 28)
- Additional Files\firehose-permissions-eu.json (line 37)
- Additional Files\firehose-permissions-us.json (line 13)
- Additional Files\firehose-permissions-us.json (line 27)
- Additional Files\firehose-permissions-us.json (line 28)
- Additional Files\firehose-permissions-us.json (line 37)
- Additional Files\iam-policy.json (line 14)
- Additional Files\lambda_function_old_athena.py (line 15)
- Additional Files\lambda-policy.json (line 24)
- Additional Files\lambda-policy.json (line 25)
- Additional Files\s3-policy.json (line 11)
- Additional Files\s3-policy.json (line 12)

## `YOUR_CONNECT_INSTANCE_ID`

Your Amazon Connect instance ID. Connect console -> your instance; the ARN ends in instance/<this-id>. Tools ship configured for a single instance - if a region->instance map appears in the code, fill in your one instance (or remove the regions you do not use).

Appears in:
- index.html (line 465)
- index.html (line 466)
- index.html (line 467)
- index.html (line 468)
- lambda_function.py (line 25)
- lambda_function.py (line 26)
- lambda_function.py (line 27)
- lambda_function.py (line 28)
- Additional Files\lambda-policy.json (line 24)
- Additional Files\lambda-policy.json (line 25)

## `YOUR_API_ID`

API Gateway ID from your SAM deploy output (the 10-char subdomain in ...execute-api... URLs). Paste into the frontend config after deploying the backend.

Appears in:
- index.html (line 451)
- index.html (line 452)
- index.html (line 453)
- index.html (line 454)
- index.html (line 458)
- index.html (line 459)
- index.html (line 460)
- index.html (line 461)

## `your-org`

Your organization short name/alias (used in resource names).

Appears in:
- lambda_function.py (line 16)
- template.yaml (line 80)
- template.yaml (line 81)
- Additional Files\athena-policy.json (line 22)
- Additional Files\athena-policy.json (line 23)
- Additional Files\athena-s3-policy.json (line 27)
- Additional Files\athena-s3-policy.json (line 28)
- Additional Files\firehose-config-eu.json (line 10)
- Additional Files\firehose-config-us.json (line 10)
- Additional Files\firehose-permissions-eu.json (line 27)
- Additional Files\firehose-permissions-eu.json (line 28)
- Additional Files\firehose-permissions-us.json (line 27)
- Additional Files\firehose-permissions-us.json (line 28)
- Additional Files\s3-policy.json (line 11)
- Additional Files\s3-policy.json (line 12)

## `YOUR_KINESIS_STREAM`

Your Amazon Connect data-stream (Kinesis) name, for CTR / agent-event style tools.

Appears in:
- Additional Files\firehose-config-eu.json (line 2)
- Additional Files\firehose-config-eu.json (line 5)
- Additional Files\firehose-config-eu.json (line 20)
- Additional Files\firehose-config-us.json (line 2)
- Additional Files\firehose-config-us.json (line 5)
- Additional Files\firehose-config-us.json (line 20)
- Additional Files\firehose-permissions-eu.json (line 13)
- Additional Files\firehose-permissions-us.json (line 13)

## `your-portal-domain.example.com`

Your custom portal domain, if you use one.

Appears in:
- Additional Files\lambda_function_old_athena.py (line 24)

---
Frontend values live in the config block near the top of `index.html`; backend
values are `template.yaml` parameters that `sam deploy --guided` will prompt for.

