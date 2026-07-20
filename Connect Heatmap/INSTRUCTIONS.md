# Installation & Setup - Connect Heatmap

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

## `YOUR_COGNITO_USER_POOL_ID`

Cognito user pool ID (e.g. us-east-1_XXXXXXXXX). Cognito -> User pools -> your pool. Set in the SAM template parameter and/or the frontend config block.

Appears in:
- index.html (line 415)
- index.html (line 422)
- index.html (line 429)
- index.html (line 436)
- Additional Files\frankfurt-stack.yaml (line 88)
- Additional Files\sydney-stack.yaml (line 88)
- Additional Files\tokyo-stack.yaml (line 88)

## `YOUR_COGNITO_APP_CLIENT_ID`

Cognito app client ID. Cognito -> your pool -> App integration -> App clients. Set in the frontend config block.

Appears in:
- index.html (line 416)
- index.html (line 423)
- index.html (line 430)
- index.html (line 437)

## `YOUR_CONNECT_INSTANCE_ID`

Your Amazon Connect instance ID. Connect console -> your instance; the ARN ends in instance/<this-id>. Tools ship configured for a single instance - if a region->instance map appears in the code, fill in your one instance (or remove the regions you do not use).

Appears in:
- index.html (line 418)
- index.html (line 425)
- index.html (line 432)
- index.html (line 439)
- Additional Files\connect-policy.json (line 14)
- Additional Files\connect-policy.json (line 15)
- Additional Files\frankfurt-stack.yaml (line 43)
- Additional Files\frankfurt-stack.yaml (line 44)
- Additional Files\frankfurt-stack.yaml (line 66)
- Additional Files\sydney-stack.yaml (line 43)
- Additional Files\sydney-stack.yaml (line 44)
- Additional Files\sydney-stack.yaml (line 66)
- Additional Files\tokyo-stack.yaml (line 43)
- Additional Files\tokyo-stack.yaml (line 44)
- Additional Files\tokyo-stack.yaml (line 66)

## `YOUR_API_ID`

API Gateway ID from your SAM deploy output (the 10-char subdomain in ...execute-api... URLs). Paste into the frontend config after deploying the backend.

Appears in:
- index.html (line 410)
- index.html (line 417)
- index.html (line 424)
- index.html (line 431)
- index.html (line 438)
- Additional Files\common-auth-check.js (line 5)

## `YOUR_AWS_ACCOUNT_ID`

Your 12-digit AWS account ID. AWS Console -> top-right account menu. Usually passed automatically via ${AWS::AccountId} in the SAM template.

Appears in:
- Additional Files\frankfurt-stack.yaml (line 43)
- Additional Files\frankfurt-stack.yaml (line 44)
- Additional Files\frankfurt-stack.yaml (line 67)
- Additional Files\frankfurt-stack.yaml (line 88)
- Additional Files\sydney-stack.yaml (line 43)
- Additional Files\sydney-stack.yaml (line 44)
- Additional Files\sydney-stack.yaml (line 67)
- Additional Files\sydney-stack.yaml (line 88)
- Additional Files\tokyo-stack.yaml (line 43)
- Additional Files\tokyo-stack.yaml (line 44)
- Additional Files\tokyo-stack.yaml (line 67)
- Additional Files\tokyo-stack.yaml (line 88)

---
Frontend values live in the config block near the top of `index.html`; backend
values are `template.yaml` parameters that `sam deploy --guided` will prompt for.

