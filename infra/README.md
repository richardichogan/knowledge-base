# Infrastructure — Knowledge Hub on Azure

Deploys all resources to the **ibm-alliance** tenant under the **Alliance Tenant Reporting** subscription in **UK South**.

## Resources Provisioned

| Resource | SKU | Purpose |
|----------|-----|---------|
| PostgreSQL Flexible Server | B1ms (Burstable) | Application database |
| Storage Account (Blob) | Standard LRS | CMS content + images |
| App Service (Linux, Node 20) | B1 Basic | Express backend |
| Static Web App | Free | React frontend SPA |

## Prerequisites

1. Azure CLI installed and logged into the ibm-alliance tenant:
   ```powershell
   az login --tenant <ibm-alliance-tenant-id>
   az account set --subscription "Alliance Tenant Reporting"
   ```

2. Create the resource group:
   ```powershell
   az group create --name rg-knowledge-hub-prod --location uksouth
   ```

## Deploy

```powershell
az deployment group create `
  --resource-group rg-knowledge-hub-prod `
  --template-file infra/main.bicep `
  --parameters infra/main.bicepparam `
  --parameters postgresAdminPassword="<STRONG_PASSWORD>" `
               jwtSecret="<RANDOM_SECRET>" `
               adminPassword="<ADMIN_PASSWORD>"
```

## Post-Deployment

1. **Run database migrations:**
   ```powershell
   # Set DATABASE_URL to the output postgresHost value
   cd knowledge-hub-backend
   npm run migrate
   ```

2. **Update `.env` with AI Foundry credentials** (you said you'll handle this):
   - `AZURE_OPENAI_ENDPOINT`
   - `AZURE_OPENAI_API_KEY`
   - Deployment names if different from defaults

3. **Configure Static Web App:**
   - Set `VITE_API_URL` environment variable to the backend URL output
   - Link to GitHub repo for CI/CD, or deploy manually:
     ```powershell
     cd knowledge-hub-web
     npm run build
     npx @azure/static-web-apps-cli deploy dist --env production
     ```

4. **Backend deployment:**
   ```powershell
   cd knowledge-hub-backend
   npm run build
   zip -r deploy.zip dist/ node_modules/ package.json
   az webapp deploy --resource-group rg-knowledge-hub-prod --name <app-service-name> --src-path deploy.zip
   ```

## Outputs

After deployment, `az deployment group show` will return:
- `backendUrl` — HTTPS URL for the Express backend
- `frontendUrl` — HTTPS URL for the Static Web App
- `postgresHost` — FQDN for PostgreSQL connection string
- `storageAccountName` — Name of the blob storage account
- `blobEndpoint` — Blob endpoint URL
