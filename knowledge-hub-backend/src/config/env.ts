import { ConfigurationError } from '../types/errors.js';

/**
 * Typed, validated environment configuration.
 * Throws ConfigurationError on startup if any required variable is missing.
 * Never reads process.env outside this module.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigurationError(name);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] ?? undefined;
}

function optionalWithDefault(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

/**
 * Integration credentials: required in production, optional in development.
 * This lets the dev server start without all credentials configured, while
 * ensuring production deployments fail fast if anything is missing.
 */
function integrationCredential(name: string): string | undefined {
  const value = process.env[name];
  if (!value && process.env['NODE_ENV'] === 'production') {
    throw new ConfigurationError(name);
  }
  return value ?? undefined;
}

export const env = {
  NODE_ENV: optionalWithDefault('NODE_ENV', 'development'),
  PORT: parseInt(optionalWithDefault('PORT', '3000'), 10),

  DATABASE_URL: required('DATABASE_URL'),

  JWT_SECRET: optionalWithDefault('JWT_SECRET', 'dev-secret-change-in-production'),
  JWT_EXPIRES_IN: optionalWithDefault('JWT_EXPIRES_IN', '7d'),

  // Azure Blob (CMS) — Managed Identity in production, conn string for local dev
  AZURE_BLOB_ACCOUNT_URL: optional('AZURE_BLOB_ACCOUNT_URL'),
  AZURE_STORAGE_CONNECTION_STRING: optional('AZURE_STORAGE_CONNECTION_STRING'),
  AZURE_STORAGE_ACCOUNT_NAME: optional('AZURE_STORAGE_ACCOUNT_NAME'),
  AZURE_STORAGE_ACCOUNT_KEY: optional('AZURE_STORAGE_ACCOUNT_KEY'),
  CMS_BLOB_CONTAINER: optionalWithDefault('CMS_BLOB_CONTAINER', 'blogcontent'),
  CMS_POSTS_PREFIX: optionalWithDefault('CMS_POSTS_PREFIX', 'posts/'),

  // Azure AI Foundry
  AZURE_OPENAI_ENDPOINT: integrationCredential('AZURE_OPENAI_ENDPOINT'),
  AZURE_OPENAI_API_KEY: integrationCredential('AZURE_OPENAI_API_KEY'),
  AZURE_OPENAI_DEPLOYMENT_GPT4O: optionalWithDefault('AZURE_OPENAI_DEPLOYMENT_GPT4O', 'gpt-4o'),
  AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI: optionalWithDefault('AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI', 'gpt-4o-mini'),
  AZURE_OPENAI_API_VERSION: optionalWithDefault('AZURE_OPENAI_API_VERSION', '2024-08-01-preview'),

  // Azure Speech (voice chat) — same pattern as client-demo's voiceProvider.ts.
  // The Azure AI Services multi-service key also covers the Speech REST API, so
  // AZURE_SPEECH_KEY falls back to AZURE_OPENAI_API_KEY when not set separately.
  AZURE_SPEECH_KEY: optional('AZURE_SPEECH_KEY'),
  AZURE_SPEECH_REGION: optionalWithDefault('AZURE_SPEECH_REGION', 'uksouth'),
  AZURE_SPEECH_VOICE: optionalWithDefault('AZURE_SPEECH_VOICE', 'en-US-Harper:MAI-Voice-2'),
  // Set to 'mock' to force the deterministic mock voice provider (no network).
  VOICE_PROVIDER: optional('VOICE_PROVIDER'),

  // Microsoft Graph (personal M365)
  GRAPH_CLIENT_ID: integrationCredential('GRAPH_CLIENT_ID'),
  GRAPH_CLIENT_SECRET: integrationCredential('GRAPH_CLIENT_SECRET'),
  GRAPH_TENANT_ID: integrationCredential('GRAPH_TENANT_ID'),
  GRAPH_REDIRECT_URI: optionalWithDefault('GRAPH_REDIRECT_URI', 'http://localhost:3000/auth/graph/callback'),
  GRAPH_REFRESH_TOKEN: optional('GRAPH_REFRESH_TOKEN'),

  // GitLab
  GITLAB_BASE_URL: optionalWithDefault('GITLAB_BASE_URL', 'https://gitlab.com'),
  GITLAB_ACCESS_TOKEN: integrationCredential('GITLAB_ACCESS_TOKEN'),
  GITLAB_USER_ID: integrationCredential('GITLAB_USER_ID'),
  GITLAB_GROUP: optional('GITLAB_GROUP'),

  // GitHub
  GITHUB_ACCESS_TOKEN: integrationCredential('GITHUB_ACCESS_TOKEN'),
  GITHUB_USERNAME: integrationCredential('GITHUB_USERNAME'),
  GITHUB_CONTENT_STORE_REPO: optionalWithDefault('GITHUB_CONTENT_STORE_REPO', 'richardichogan/content-store'),

  // Podcast — stored in config, never hardcoded in app logic
  PODCAST_RSS_URL: optional('PODCAST_RSS_URL'),

  // Whisper / OpenAI
  OPENAI_API_KEY: optional('OPENAI_API_KEY'),

  // Email (IMAP) — JSON array of account configs
  EMAIL_ACCOUNTS: optional('EMAIL_ACCOUNTS'),

  // Azure AI Vision — Change 003: OCR for uploaded images
  // Optional: if not set, OCR is skipped and ocrText is stored as empty string
  AZURE_VISION_ENDPOINT: optional('AZURE_VISION_ENDPOINT'),
  AZURE_VISION_KEY: optional('AZURE_VISION_KEY'),

  // SMTP (newsletter via SMTP2GO)
  SMTP_HOST: optionalWithDefault('SMTP_HOST', 'mail.smtp2go.com'),
  SMTP_PORT: parseInt(optionalWithDefault('SMTP_PORT', '2525'), 10),
  SMTP_USER: optional('SMTP_USER'),
  SMTP_PASS: optional('SMTP_PASS'),
  SMTP_FROM: optionalWithDefault('SMTP_FROM', 'newsletter@newsletter.themicrosoftcloudblog.com'),

  // Admin / CRON
  ADMIN_PASSWORD: optional('ADMIN_PASSWORD'),
  CRON_SECRET: optional('CRON_SECRET'),
  CRONJOB_API_KEY: optional('CRONJOB_API_KEY'),
  CRONJOB_JOB_ID: optional('CRONJOB_JOB_ID'),

  get isProduction(): boolean {
    return this.NODE_ENV === 'production';
  },

  get isDevelopment(): boolean {
    return this.NODE_ENV === 'development';
  },
} as const;

export type Env = typeof env;
