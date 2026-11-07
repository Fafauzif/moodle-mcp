#!/usr/bin/env bash
# One-shot deploy of the Moodle MCP API to Azure Container Apps (consumption tier).
# Paste this file's contents into Azure Cloud Shell (Bash) or an Ubuntu VM with the az CLI,
# or run it as a script:  bash deploy.sh
#
# It:
#   1. creates a resource group, an Azure Container Registry and a Container Apps environment
#      (if they don't exist yet),
#   2. clones this repo and builds deploy/docker/Dockerfile.api into the registry,
#   3. creates the container app with MOODLE_TOKEN and APP_ACCESS_KEY as secrets,
#   4. prints the public HTTPS URL.
#
# Secrets are read with hidden prompts so they never land in your shell history.
# Cost note: the container app itself is on the consumption tier (scale-to-zero, covered by the
# monthly free grant for light use). The registry is the one paid piece, about $5/month billed
# against your Azure for Students credit.

set -euo pipefail

REPO_URL="https://github.com/Fafauzif/moodle-mcp"
BRANCH="${BRANCH:-main}"
APP_NAME="${APP_NAME:-moodle-mcp-api}"
RG_NAME="${RG_NAME:-moodle-mcp-rg}"
LOCATION="${LOCATION:-southeastasia}"
ACR_NAME="${ACR_NAME:-moodlemcp$RANDOM}"
ENV_NAME="${ENV_NAME:-moodle-mcp-env}"

say() { printf '\n== %s\n' "$1"; }

say "Checking az login"
az account show >/dev/null 2>&1 || az login
SUBSCRIPTION="$(az account show --query name -o tsv)"
say "Using subscription: $SUBSCRIPTION (location: $LOCATION)"

say "Resource group $RG_NAME"
az group show -n "$RG_NAME" >/dev/null 2>&1 || az group create -n "$RG_NAME" -l "$LOCATION"

say "Container registry $ACR_NAME (Basic SKU, ~$5/month from your student credit)"
az acr show -n "$ACR_NAME" >/dev/null 2>&1 || az acr create -n "$ACR_NAME" -g "$RG_NAME" --sku Basic --admin-enabled true

say "Container Apps environment $ENV_NAME"
if ! az containerapp env show -g "$RG_NAME" -n "$ENV_NAME" >/dev/null 2>&1; then
  # Try without a Log Analytics workspace first; fall back if this CLI version insists on one.
  az containerapp env create -g "$RG_NAME" -n "$ENV_NAME" -l "$LOCATION" \
    --logs-destination none >/dev/null 2>&1 \
  || az containerapp env create -g "$RG_NAME" -n "$ENV_NAME" -l "$LOCATION"
fi

say "Secrets (input is hidden, nothing goes into shell history)"
read -rsp "MOODLE_TOKEN (your Moodle web service token): " MOODLE_TOKEN; echo
read -rsp "APP_ACCESS_KEY (any long random string you invent, used by Vibe): " APP_ACCESS_KEY; echo
if [ -z "$MOODLE_TOKEN" ] || [ -z "$APP_ACCESS_KEY" ]; then
  echo "Both values are required." >&2
  exit 1
fi

say "Cloning $REPO_URL (branch $BRANCH) and building the image"
BUILD_DIR="$(mktemp -d)"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$BUILD_DIR"
az acr build --registry "$ACR_NAME" \
  --image "$APP_NAME:latest" \
  --file deploy/docker/Dockerfile.api \
  "$BUILD_DIR"
rm -rf "$BUILD_DIR"

IMAGE="$ACR_NAME.azurecr.io/$APP_NAME:latest"

say "Creating container app $APP_NAME (scale to zero: min 0 replicas)"
az containerapp show -g "$RG_NAME" -n "$APP_NAME" >/dev/null 2>&1 \
&& az containerapp update -g "$RG_NAME" -n "$APP_NAME" \
     --image "$IMAGE" \
     --set-env-vars MOODLE_TOKEN=secretref:moodle-token APP_ACCESS_KEY=secretref:app-access-key \
|| az containerapp create -g "$RG_NAME" -n "$APP_NAME" \
     --environment "$ENV_NAME" \
     --image "$IMAGE" \
     --target-port 3000 --ingress external --transport auto \
     --min-replicas 0 --max-replicas 1 \
     --secrets moodle-token="$MOODLE_TOKEN" app-access-key="$APP_ACCESS_KEY" \
     --set-env-vars MOODLE_TOKEN=secretref:moodle-token APP_ACCESS_KEY=secretref:app-access-key \
     --cpu 0.25 --memory 0.5Gi

# Give the registry pull permission to the app's managed identity.
APP_ID="$(az containerapp show -g "$RG_NAME" -n "$APP_NAME" --query identity.principalId -o tsv)"
if [ -n "$APP_ID" ] && [ "$APP_ID" != "null" ]; then
  az role assignment create --assignee "$APP_ID" \
    --role "AcrPull" \
    --scope "$(az acr show -n "$ACR_NAME" --query id -o tsv)" >/dev/null
fi

URL="$(az containerapp show -g "$RG_NAME" -n "$APP_NAME" --query properties.configuration.ingress.fqdn -o tsv)"

say "Done"
echo "  URL:            https://$URL"
echo "  Health check:   https://$URL/api/health/live"
echo "  Try it:         curl -H 'x-app-access-key: <your key>' https://$URL/api/v1/moodle/courses"
echo
echo "Register this URL as a custom MCP connector in Mistral Studio, or call it directly from Vibe."
