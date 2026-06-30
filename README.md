# Amazon Connect Tools

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![AWS SAM](https://img.shields.io/badge/Deployed%20with-AWS%20SAM-orange?logo=amazonaws)](https://aws.amazon.com/serverless/sam/)
[![Amazon Connect](https://img.shields.io/badge/Amazon-Connect-blue?logo=amazonaws)](https://aws.amazon.com/connect/)

A collection of open-source tools for Amazon Connect to help manage and optimize your contact center operations.

> **Disclaimer:** These tools were extracted from a customized internal deployment
> and stripped of all corporate/account-specific data. Authentication was removed so
> each tool runs standalone. A fresh setup will likely need some modifications for
> your own AWS account, Amazon Connect instance, and naming. Treat them as working
> references, not turnkey drop-ins.

## Overview

These tools are designed to work with Amazon Connect and related AWS services. Each subfolder contains a standalone tool with its own Lambda backend, frontend, and deployment instructions.

## Structure

Each tool folder contains only the essential files needed to deploy and run the tool:
- **Frontend**: `index.html`, `styles.css`
- **Backend**: Lambda function code (`lambda.js` / `lambda_function.py`)
- **Infrastructure**: SAM `template.yaml` for deployment
- **Documentation**: a tool-specific `README.md` (what it does) and `INSTRUCTIONS.md` (how to install)

## Prerequisites

- AWS Account with Amazon Connect instance configured
- AWS CLI and SAM CLI installed
- Appropriate IAM permissions for deployment

## Deployment

Each tool can be deployed independently using AWS SAM:

```bash
cd <tool-folder>
sam build
sam deploy --guided
```

Refer to individual tool READMEs for specific setup instructions.

## Configuration (replace the placeholders)

All organization-specific values have been replaced with named placeholders such as
`YOUR_AWS_ACCOUNT_ID`, `YOUR_COGNITO_USER_POOL_ID`, and `YOUR_CONNECT_INSTANCE_ID`.

- **Per tool:** each tool folder has a generated **`INSTRUCTIONS.md`** with install
  steps, a disclaimer, and exactly which placeholders that tool uses (and the files/lines to edit).

Most backend values are CloudFormation parameters in `template.yaml` (so
`sam deploy --guided` will prompt for them); frontend values live in the config block
near the top of each `index.html`.

> **Single instance by default.** Each tool is set up to point at one Amazon Connect
> instance. A few tools still contain a `region → instance` map left over from a
> multi-region setup — just fill in your single `YOUR_CONNECT_INSTANCE_ID` and remove
> the regions you don't need. Running across multiple instances/regions is left to you.

## Contributing

Contributions are welcome. Feel free to open an issue or submit a pull request. When adapting a tool, please keep placeholder names intact so others can follow the same setup pattern.

## License

Released under the [MIT License](LICENSE) — free to use, modify, and distribute.
