# Connect Migration Tool

A standalone Amazon Connect tool built on AWS serverless services (Lambda, API
Gateway, and a static frontend). It was extracted from a customized internal
deployment and stripped of all corporate data.

## How it works
- `index.html` + `styles.css` - the frontend served as a static site
- `template.yaml` - the SAM/CloudFormation backend (Lambda + API Gateway)
- Lambda code calls the Amazon Connect APIs and returns data to the page

## Setup
See [INSTRUCTIONS.md](INSTRUCTIONS.md) for prerequisites, install steps, the
placeholders you must replace, and important caveats.

