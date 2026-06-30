# Amazon Connect - Skills Based Routing (SBR) Portal

A web-based portal for managing Amazon Connect user proficiencies (skills-based routing). View, search, edit, and audit user skill assignments across multiple AWS regions.

![SBR Portal Screenshot](https://img.shields.io/badge/AWS-Amazon%20Connect-orange?style=flat-square&logo=amazonaws) ![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

## Features

- **User Management** — View all Amazon Connect users with their assigned proficiencies
- **Proficiency Search** — Find users by specific proficiencies with multi-filter support (up to 3 simultaneous filters)
- **Edit Proficiencies** — Add, remove, or update proficiency levels for individual users
- **Audit Log** — Track all proficiency changes with timestamps, user details, and change history
- **Multi-Region Support** — Switch between AWS regions (US, EU, etc.) from a single portal
- **CSV Export** — Download user lists and search results as CSV files
- **Group Permissions** — Admin-configurable group-based access control for proficiencies
- **Dark / Light Theme** — Toggle between dark and light mode
- **S3 Caching** — Reduces Amazon Connect API calls with configurable cache duration

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐
│  Frontend   │────▶│ API Gateway  │────▶│   Lambda Functions  │
│ (S3 + CDN)  │     │  + Cognito   │     │                     │
└─────────────┘     └──────────────┘     │  - listUsers        │
                                         │  - listProficiencies│
                                         │  - updateProficiency │
                                         │  - listAuditLogs    │
                                         │  - writeAuditLog    │
                                         │  - manageGroups     │
                                         │  - manageUsers      │
                                         │  - getUserProf      │
                                         └──────────┬──────────┘
                                                    │
                                         ┌──────────▼──────────┐
                                         │   Amazon Connect    │
                                         │   + DynamoDB        │
                                         │   + S3 (cache)      │
                                         └─────────────────────┘
```

---

## Prerequisites

Before you begin, make sure you have the following:

| Requirement | Details |
|---|---|
| **AWS Account** | With permissions to create Lambda, API Gateway, DynamoDB, S3, and CloudFront resources |
| **Amazon Connect Instance** | A running instance with **Predefined Attributes** (proficiencies/skills) already configured |
| **Amazon Cognito User Pool** | A User Pool in the same AWS account for authenticating portal users |
| **S3 Bucket** | A bucket for hosting the frontend files and for data caching |
| **AWS CLI** | [Install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) — v2 recommended |
| **AWS SAM CLI** | [Install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) |
| **Python 3.12+** | Required for Lambda runtime |

---

## Installation & Setup (Step-by-Step)

### Step 1 — Gather Your AWS Resource IDs

Before deploying, collect the following values from your AWS environment. You'll need them during setup.

| Value | Where to find it | Example |
|---|---|---|
| **Connect Instance ID** | Amazon Connect Console → Your Instance → Instance ARN (the UUID at the end) | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| **Cognito User Pool ID** | Cognito Console → User Pools → General Settings | `us-east-1_XXXXXXXXX` |
| **Cognito User Pool ARN** | Cognito Console → User Pools → General Settings | `arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_XXXXXXXXX` |
| **Cognito App Client ID** | Cognito Console → User Pools → App Integration → App Clients | `26-character alphanumeric string` |
| **S3 Bucket Name** | S3 Console (create one if needed) | `my-connect-tools-bucket` |
| **AWS Region** | The region where your Connect instance runs | `us-east-1` |

### Step 2 — Set Up Cognito (if not already done)

If you don't have a Cognito User Pool yet:

1. Go to **Amazon Cognito** in the AWS Console
2. Click **Create user pool**
3. Configure sign-in with **email** as the primary identifier
4. Under **App Integration**, create an **App Client** (note down the Client ID)
5. Create a Cognito **group** called `SBR-Admin` — members of this group will have admin access in the portal
6. Add your admin users to the `SBR-Admin` group

> **Tip:** If you already have a Cognito User Pool for other tools, you can reuse it. Just create the `SBR-Admin` group and add your users.

### Step 3 — Create an S3 Bucket (if not already done)

You need an S3 bucket to:
- Host the frontend files (HTML, CSS, JS)
- Cache user/proficiency data (reduces API calls)

```bash
aws s3 mb s3://my-connect-tools-bucket --region us-east-1
```

### Step 4 — Deploy the Backend (Lambda + API Gateway + DynamoDB)

The SAM template will create all backend resources automatically.

```bash
# Clone or download this repository
cd "Connect SBR Portal"

# Build the SAM application
sam build

# Deploy (interactive — will prompt for parameter values)
sam deploy --guided
```

During the guided deploy, you'll be prompted for:

| Parameter | What to enter |
|---|---|
| **Stack Name** | A name for the CloudFormation stack, e.g. `sbr-portal` |
| **AWS Region** | The region where your Connect instance runs, e.g. `us-east-1` |
| **ConnectInstanceId** | Your Amazon Connect Instance ID |
| **CacheBucketName** | Your S3 bucket name (from Step 3) |
| **CognitoUserPoolArn** | The full ARN of your Cognito User Pool (from Step 2) |
| **Confirm changes before deploy** | `Y` (recommended) |
| **Allow SAM CLI IAM role creation** | `Y` |

After deployment completes, SAM will output your **API Gateway URL**. Copy this — you'll need it in the next step.

```
Outputs:
  ApiUrl: https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/api
```

> **Deploying to multiple regions?** Run `sam deploy --guided` again in each region with the appropriate Connect Instance ID. Each region gets its own API Gateway URL.

### Step 5 — Configure the Frontend

Open `app.js` and update the configuration section at the top of the file:

```javascript
// ============================================================================
// CONFIGURATION - Update these values for your environment
// ============================================================================

const COGNITO_CONFIG = {
    UserPoolId: 'us-east-1_XXXXXXXXX',         // Your Cognito User Pool ID
    ClientId: 'xxxxxxxxxxxxxxxxxxxxxxxxxx',      // Your Cognito App Client ID
    Region: 'us-east-1',                         // Region of your Cognito User Pool
    RequiredGroup: 'SBR-Admin'                   // Cognito group for admin access
};

const REGION_CONFIG = {
    'us-east-1': {
        name: 'US (N. Virginia)',
        apiBaseUrl: 'https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/api',  // From SAM output
        connectInstanceId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
    }
    // Add more regions as needed:
    // 'eu-central-1': {
    //     name: 'EU (Frankfurt)',
    //     apiBaseUrl: 'https://xxxxxxxxxx.execute-api.eu-central-1.amazonaws.com/prod/api',
    //     connectInstanceId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
    // }
};
```

> **Important:** If you only have one region, you can remove or comment out extra regions in both `app.js` and the region `<select>` dropdown in `index.html`.

### Step 6 — Set Up Authentication in the Frontend

The portal reads authentication tokens from `localStorage`. You have two options:

**Option A — Integrate with an existing portal/SSO**

If you have a parent portal that handles Cognito login, store the tokens in `localStorage` before the user navigates to the SBR Portal:

```javascript
localStorage.setItem('idToken', cognitoIdToken);
localStorage.setItem('userEmail', userEmail);
localStorage.setItem('userGroups', JSON.stringify(userGroupsArray));
```

**Option B — Add a standalone login page**

If this portal will run independently, you'll need to add a Cognito Hosted UI redirect or a login form. A simple approach:

1. Enable **Hosted UI** in your Cognito App Client settings
2. Set the callback URL to your CloudFront URL (e.g. `https://your-domain.com/sbr-portal/index.html`)
3. Add code to `index.html` to redirect unauthenticated users to the Hosted UI and parse the callback tokens

> The provided code expects tokens in `localStorage` under keys `idToken`, `userEmail`, and `userGroups`. Adjust the `checkAuthStatus()` function in `app.js` if your token storage differs.

### Step 7 — Deploy the Frontend to S3

Upload the three frontend files to your S3 bucket:

```bash
aws s3 cp index.html s3://my-connect-tools-bucket/sbr-portal/index.html
aws s3 cp styles.css s3://my-connect-tools-bucket/sbr-portal/styles.css
aws s3 cp app.js s3://my-connect-tools-bucket/sbr-portal/app.js
```

### Step 8 — Set Up CloudFront (Recommended)

To serve the portal over HTTPS with a custom domain:

1. Go to **CloudFront** in the AWS Console
2. Create a new distribution with:
   - **Origin**: Your S3 bucket
   - **Default Root Object**: `index.html`
   - **Viewer Protocol Policy**: Redirect HTTP to HTTPS
3. (Optional) Add a custom domain via Route 53 and an ACM certificate

Alternatively, you can enable **S3 Static Website Hosting** on the bucket for a simpler setup (HTTP only).

### Step 9 — Test the Portal

1. Navigate to your CloudFront URL or S3 website URL
2. You should see the SBR Portal login prompt
3. Log in with a user who is a member of the `SBR-Admin` Cognito group
4. Select your region and verify that users load from Amazon Connect
5. Try editing a user's proficiencies and check the Audit Log tab

---

## Troubleshooting

| Issue | Solution |
|---|---|
| **"Authentication required"** | Ensure your `idToken` is in `localStorage`. Check that your Cognito App Client ID is correct in `app.js`. |
| **"Session expired"** | The Cognito token has expired. Re-authenticate through your login flow. Cognito tokens expire after 1 hour by default. |
| **Users not loading / 403 error** | Check that your API Gateway URL is correct in `REGION_CONFIG`. Verify the Cognito authorizer is configured in the SAM template. |
| **CORS errors in browser console** | The SAM template configures CORS automatically. If you've customised the API Gateway, ensure `Access-Control-Allow-Origin: *` is set. |
| **No proficiencies showing** | Verify that your Connect instance has Predefined Attributes configured (Connect Console → Routing → Predefined Attributes). |
| **Lambda timeout (504)** | The `listUsers` function may timeout with large user bases. Increase the timeout in `template.yaml` (default: 120s) or reduce `max_workers` in `listUsers.py`. |
| **Cache not refreshing** | User data is cached for 10 minutes. Click "Refresh Users" to force a reload, or delete the cache object from S3 (`sbr-portal/cache/users-{region}.json`). |

---

## File Structure

```
Connect SBR Portal/
├── index.html                       # Main frontend page
├── styles.css                       # Styling (light/dark theme support)
├── app.js                           # Frontend application logic & configuration
├── template.yaml                    # AWS SAM template (deploys all backend resources)
├── README.md                        # This file
└── lambda/
    ├── listUsers.py                 # List Connect users with proficiencies (with S3 caching)
    ├── listProficiencies.py         # List all available predefined attributes
    ├── updateProficiencies.py       # Update a user's proficiencies
    ├── audit/
    │   ├── listAuditLogs.py         # Read audit log entries from DynamoDB
    │   └── writeAuditLog.py         # Write audit log entries to DynamoDB
    └── config/
        ├── getUserProficiencies.py  # Get current user's allowed proficiencies (based on group)
        ├── manageGroups.py          # CRUD for group-based proficiency permissions
        └── manageUsers.py           # CRUD for user-level proficiency permissions
```

## API Endpoints

All endpoints are behind Cognito authentication via API Gateway.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/users` | List all users with their proficiencies |
| `GET` | `/api/proficiencies` | List all available proficiencies (predefined attributes) |
| `PUT` | `/api/users/{userId}/proficiencies` | Update a user's proficiencies |
| `GET` | `/api/audit` | List audit log entries |
| `POST` | `/api/audit` | Write an audit log entry |
| `GET` | `/api/groups` | List group permissions |
| `POST` | `/api/groups` | Create a group permission |
| `PUT` | `/api/groups/{groupName}` | Update a group permission |
| `DELETE` | `/api/groups/{groupName}` | Delete a group permission |
| `GET` | `/api/user/proficiencies` | Get the current user's allowed proficiencies |
| `GET` | `/api/config/users` | List user-level permission overrides |
| `POST` | `/api/config/users` | Create a user-level permission |
| `PUT` | `/api/config/users/{userId}` | Update a user-level permission |
| `DELETE` | `/api/config/users/{userId}` | Delete a user-level permission |

---

## AWS Resources Created by the SAM Template

The `template.yaml` will create the following resources in your AWS account:

| Resource | Type | Purpose |
|---|---|---|
| `SBRPortalApi` | API Gateway | REST API with Cognito authorizer |
| `ListUsersFunction` | Lambda | Fetches users + proficiencies from Connect |
| `ListProficienciesFunction` | Lambda | Fetches predefined attributes from Connect |
| `UpdateProficienciesFunction` | Lambda | Writes proficiency changes to Connect |
| `ListAuditLogsFunction` | Lambda | Reads audit trail from DynamoDB |
| `WriteAuditLogFunction` | Lambda | Writes audit entries to DynamoDB |
| `GetUserProficienciesFunction` | Lambda | Checks group-based access permissions |
| `ManageGroupsFunction` | Lambda | CRUD for group permission rules |
| `ManageUsersFunction` | Lambda | CRUD for user permission rules |
| `AuditLogTable` | DynamoDB | Stores proficiency change audit trail |

> **Note:** The SAM template does **not** create Cognito, S3, CloudFront, or the Connect instance — you must set these up separately (Steps 2, 3, and 8).

---

## IAM Permissions Required

The Lambda execution role needs the following permissions (the SAM template handles this automatically):

- **Amazon Connect**: `connect:ListUsers`, `connect:DescribeUser`, `connect:DescribeRoutingProfile`, `connect:ListUserProficiencies`, `connect:AssociateUserProficiencies`, `connect:DisassociateUserProficiencies`, `connect:SearchPredefinedAttributes`
- **S3**: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on your cache bucket
- **DynamoDB**: `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:Scan`, `dynamodb:DeleteItem` on the audit and permissions tables
- **CloudWatch Logs**: `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` (standard Lambda logging)

---

## Adding More Regions

To support additional AWS regions (e.g. EU, Tokyo):

1. Deploy the SAM stack in the new region:
   ```bash
   sam build
   sam deploy --guided --region eu-central-1
   ```
   Provide the Connect Instance ID for that region.

2. Add the new region to `REGION_CONFIG` in `app.js`:
   ```javascript
   'eu-central-1': {
       name: 'EU (Frankfurt)',
       apiBaseUrl: 'https://xxxxxxxxxx.execute-api.eu-central-1.amazonaws.com/prod/api',
       connectInstanceId: 'your-eu-instance-id'
   }
   ```

3. Add a `<option>` to the region dropdown in `index.html`:
   ```html
   <option value="eu-central-1">EU (Frankfurt)</option>
   ```

4. Re-upload the updated `app.js` and `index.html` to S3.

---

## Caching

To reduce Amazon Connect API costs and improve response times:

| Data | Cache Duration | Cache Location |
|---|---|---|
| User list + proficiencies | 10 minutes | `s3://{bucket}/sbr-portal/cache/users-{region}.json` |
| Available proficiencies | 60 minutes | `s3://{bucket}/sbr-portal/cache/all-proficiencies-{region}.json` |

- Cache is automatically invalidated when you update a user's proficiencies
- Click **Refresh Users** to bypass the cache manually
- Adjust cache durations in the Lambda files (`CACHE_DURATION_MINUTES`)

---

## Cost Estimate

For a typical admin tool with ~5-10 users accessing it daily:

| Service | Estimated Monthly Cost |
|---|---|
| Lambda | < $1 (minimal invocations) |
| API Gateway | < $1 |
| DynamoDB (on-demand) | < $1 |
| S3 (caching + hosting) | < $1 |
| CloudFront | Free tier or < $1 |
| **Total** | **< $5/month** |

> **Warning:** The `listUsers` Lambda calls `DescribeUser` and `ListUserProficiencies` for every user in your Connect instance. For instances with 1000+ users, this can generate significant API calls. The S3 cache mitigates this, but monitor your costs during initial setup.

---

## Customisation

- **Branding**: Edit `styles.css` to change colours and fonts. The accent colour (`--accent`) defaults to `#EF7200`.
- **Regions**: Add or remove regions in `app.js` and `index.html` as described above.
- **Admin Group**: Change `RequiredGroup` in `COGNITO_CONFIG` if you want to use a different Cognito group name.
- **Cache Duration**: Adjust `CACHE_DURATION_MINUTES` in the Lambda files.
- **Theme**: The portal defaults to light mode. Users can toggle dark mode with the moon/sun button.

---

## License

MIT — free to use, modify, and distribute.
