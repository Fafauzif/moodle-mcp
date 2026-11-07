# Azure deployment (Container Apps)

Hosts the Moodle MCP API on Azure Container Apps (consumption tier, scale-to-zero) so Mistral —
web and mobile — can reach it without a paid Mistral Apps plan.

## What you need

- An Azure for Students account ($100 credit, no credit card).
- A browser (Azure Cloud Shell) or any machine with the `az` CLI.
- A fresh Moodle web service token (never commit it; see "Getting a token" below).

## Cost

- The container app is on the **consumption tier** with `--min-replicas 0`, so idle hours cost
  nothing; light use stays inside the monthly free grant.
- The one paid piece is the **Azure Container Registry** (Basic SKU, roughly $5/month), billed
  against the student credit.

## Deploy

1. Open https://portal.azure.com, click the terminal icon (`>_`) in the top bar and choose
   **Bash**. Accept the storage-account prompt the first time.
2. Paste the whole contents of [deploy.sh](./deploy.sh) and press Enter. It is idempotent —
   re-running it rebuilds the image and updates the app.
3. When prompted, enter `MOODLE_TOKEN` and `APP_ACCESS_KEY` (hidden input, not stored in shell
   history). Invent `APP_ACCESS_KEY` yourself, e.g. `openssl rand -hex 32`.
4. The script prints the HTTPS URL, something like
   `https://moodle-mcp-api.<random>.southeastasia.azurecontainerapps.io`.

To rotate the Moodle token later, re-run the script with the new token.

## Smoke test

```bash
curl https://<your-app-url>/api/health/live
curl -H "x-app-access-key: <your key>" https://<your-app-url>/api/v1/moodle/courses
```

Without the access-key header the API answers 401; with it you get your course list.

## Registering the custom connector in Mistral Studio

1. Go to https://studio.mistral.ai and open **Connectors** (or **Integrations**).
2. Choose **Add custom connector / MCP connector** and give it a name.
3. For the server URL enter `https://<your-app-url>/api` (the MCP endpoint the OpenAPI spec
   describes lives under `/api`; if Studio asks for the spec itself, use
   `https://<your-app-url>/api/openapi.json`).
4. Authentication: choose **Custom header**. Name: `x-app-access-key`, value: your
   `APP_ACCESS_KEY`.
5. Save and test — you should see the Moodle tools (courses, get_deadlines, assignments, grades,
   quizzes, submission status, files, submit flows, raw_call).

If your plan refuses custom connectors, use the fallback: paste the `APP_ACCESS_KEY` into a Vibe
session once (or store it in `/workspace/.secrets/`) and let the agent call the Azure REST API
directly.

## Getting a Moodle token

```
https://emas3.ui.ac.id/login/token.php?service=moodle_mobile_app&username=<you>&password=<pw>
```

The JSON response's `token` field is `MOODLE_TOKEN`. Treat any token pasted into a chat as
compromised and rotate it by re-running this flow.

## Files

- [deploy.sh](./deploy.sh) — the one-shot deploy script (also runs on a VM that has `az`).
- The image it builds: [../docker/Dockerfile.api](../docker/Dockerfile.api), target `api`.
