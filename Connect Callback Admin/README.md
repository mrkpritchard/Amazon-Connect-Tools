# Connect Callback Admin

A standalone Amazon Connect tool built on AWS serverless services (Lambda, API
Gateway, and a static frontend). It was extracted from a customized internal
deployment and stripped of all corporate data.

## Prerequisite: deploy the AWS callback solution first

This tool is built **on top of** the AWS Contact Center reference solution
[Preventing duplicate callback requests in Amazon Connect](https://aws.amazon.com/blogs/contact-center/preventing-duplicate-callback-requests-in-amazon-connect/).
That blog post provides the small `writecallback` / `readcallback` scripts that log
each callback into a DynamoDB table, remove it when the callback is completed, and
check whether a caller already has a callback pending. **Set that up first** (the
`Callback` / `CallbackHistory` tables and the two flow Lambdas). This admin portal
then sits on top of it to view, search, and manage those callbacks, plus an
EventBridge CTR processor that auto-archives completed callbacks to history.

## How it works
- `index.html` + `styles.css` - the frontend served as a static site
- `template-us.yaml` / `template-eu.yaml` - the SAM/CloudFormation backend (DynamoDB + admin API + CTR processor + flow Lambdas)
- Lambda code calls the Amazon Connect APIs and DynamoDB and returns data to the page

## Setup
See [INSTRUCTIONS.md](INSTRUCTIONS.md) for prerequisites, install steps, the
placeholders you must replace, and important caveats.

