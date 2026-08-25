# Installation & Setup - Connect Migration Tool

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
- index.html (line 84)
- index.html (line 130)
- index.html (line 182)
- index.html (line 193)

## `YOUR_CONNECT_INSTANCE_ID`

Your Amazon Connect instance ID. Connect console -> your instance; the ARN ends in instance/<this-id>. Tools ship configured for a single instance - if a region->instance map appears in the code, fill in your one instance (or remove the regions you do not use).

Appears in:
- index.html (line 79)
- index.html (line 125)
- index.html (line 496)
- index.html (line 580)
- index.html (line 581)
- index.html (line 582)
- index.html (line 583)
- index.html (line 584)
- index.html (line 585)

## `YOUR_API_ID`

API Gateway ID from your SAM deploy output (the 10-char subdomain in ...execute-api... URLs). Paste into the frontend config after deploying the backend.

Appears in:
- index.html (line 553)

## `YOUR_CLOUDFRONT_DOMAIN`

Your CloudFront domain, e.g. dxxxxxxxx.cloudfront.net.

Appears in:
- template.yaml (line 9)

---
Frontend values live in the config block near the top of `index.html`; backend
values are `template.yaml` parameters that `sam deploy --guided` will prompt for.

