// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Hub — Azure Infrastructure (Bicep)
// Target: ibm-alliance tenant / Alliance Tenant Reporting subscription
// Region: UK South
// Uses Container Apps (consumption) to avoid App Service VM quota limits.
// ─────────────────────────────────────────────────────────────────────────────

targetScope = 'resourceGroup'

@description('Environment name used for resource naming')
@allowed(['prod', 'dev'])
param environment string = 'prod'

@description('Azure region for all resources')
param location string = 'uksouth'

@description('PostgreSQL administrator login')
param postgresAdminLogin string = 'khadmin'

@secure()
@description('PostgreSQL administrator password')
param postgresAdminPassword string

@secure()
@description('JWT secret for backend auth')
param jwtSecret string

@secure()
@description('Admin password for the app')
param adminPassword string

// ─── Naming ──────────────────────────────────────────────────────────────────

var prefix = 'kh-${environment}'
var uniqueSuffix = uniqueString(resourceGroup().id)

// ─── Storage Account (Blob — CMS content) ────────────────────────────────────

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'kh${environment}${take(uniqueSuffix, 8)}'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource blogContentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'blogcontent'
  properties: { publicAccess: 'None' }
}

resource imagesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'images'
  properties: { publicAccess: 'None' }
}

// ─── PostgreSQL Flexible Server ──────────────────────────────────────────────

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${prefix}-pg-${take(uniqueSuffix, 6)}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32 }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
  }
}

resource postgresDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgresServer
  name: 'knowledge_hub'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Allow Azure services to access PostgreSQL
resource postgresFirewallAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: postgresServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ─── Log Analytics (required for Container Apps Environment) ──────────────────

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs-${take(uniqueSuffix, 6)}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ─── Container Apps Environment (consumption — no VM quota) ──────────────────

resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ─── Container App (Backend — Node.js) ───────────────────────────────────────

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-api'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
      }
      registries: []
      secrets: [
        { name: 'database-url', value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgresServer.properties.fullyQualifiedDomainName}:5432/knowledge_hub?sslmode=require' }
        { name: 'jwt-secret', value: jwtSecret }
        { name: 'admin-password', value: adminPassword }
      ]
    }
    template: {
      containers: [
        {
          name: 'backend'
          image: 'node:20-slim'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
            { name: 'ADMIN_PASSWORD', secretRef: 'admin-password' }
            { name: 'AZURE_BLOB_ACCOUNT_URL', value: storageAccount.properties.primaryEndpoints.blob }
            { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storageAccount.name }
            { name: 'CMS_BLOB_CONTAINER', value: 'blogcontent' }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
        // IMPORTANT: keep this at 1. Each replica runs its own sync scheduler
        // AND its own pg pool (DB_POOL_MAX). The Burstable Postgres caps
        // max_connections at 50, so multiple replicas (e.g. 3 × 20 = 60)
        // exhaust the connection limit → "timeout exceeded when trying to
        // connect" outages even though DB CPU/memory are idle. A single replica
        // also guarantees exactly one sync scheduler runs.
        rules: []
      }
    }
  }
}

// Grant Container App Managed Identity → Storage Blob Data Contributor
resource storageRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, containerApp.id, 'Storage Blob Data Contributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: containerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ─── Static Web App (Frontend) ───────────────────────────────────────────────

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-web'
  location: 'westeurope' // SWA has limited region support; serves globally via CDN
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    buildProperties: {
      appLocation: '/knowledge-hub-web'
      outputLocation: 'dist'
    }
  }
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

@description('Backend Container App URL')
output backendUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'

@description('Static Web App URL')
output frontendUrl string = 'https://${staticWebApp.properties.defaultHostname}'

@description('PostgreSQL FQDN')
output postgresHost string = postgresServer.properties.fullyQualifiedDomainName

@description('Storage Account name')
output storageAccountName string = storageAccount.name

@description('Storage Account blob endpoint')
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
