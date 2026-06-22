// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Hub — Azure Infrastructure (Bicep)
// Target: ibm-alliance tenant / Alliance Tenant Reporting subscription
// Region: UK South
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

// ─── App Service Plan ────────────────────────────────────────────────────────

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${prefix}-plan'
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  kind: 'linux'
  properties: {
    reserved: true // Required for Linux
  }
}

// ─── App Service (Backend — Node.js) ─────────────────────────────────────────

resource appService 'Microsoft.Web/sites@2023-12-01' = {
  name: '${prefix}-api-${take(uniqueSuffix, 6)}'
  location: location
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      alwaysOn: true
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'PORT', value: '8080' }
        { name: 'DATABASE_URL', value: 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgresServer.properties.fullyQualifiedDomainName}:5432/knowledge_hub?sslmode=require' }
        { name: 'JWT_SECRET', value: jwtSecret }
        { name: 'ADMIN_PASSWORD', value: adminPassword }
        { name: 'AZURE_BLOB_ACCOUNT_URL', value: storageAccount.properties.primaryEndpoints.blob }
        { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storageAccount.name }
        { name: 'CMS_BLOB_CONTAINER', value: 'blogcontent' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
      ]
    }
  }
}

// Grant App Service Managed Identity → Storage Blob Data Contributor
resource storageRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, appService.id, 'Storage Blob Data Contributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: appService.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ─── Static Web App (Frontend) ───────────────────────────────────────────────

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-web'
  location: location
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    buildProperties: {
      appLocation: '/knowledge-hub-web'
      outputLocation: 'dist'
    }
  }
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

@description('Backend App Service URL')
output backendUrl string = 'https://${appService.properties.defaultHostName}'

@description('Static Web App URL')
output frontendUrl string = 'https://${staticWebApp.properties.defaultHostname}'

@description('PostgreSQL FQDN')
output postgresHost string = postgresServer.properties.fullyQualifiedDomainName

@description('Storage Account name')
output storageAccountName string = storageAccount.name

@description('Storage Account blob endpoint')
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
