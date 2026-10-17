export const connectionCredentials = [
  { id: 'gitlab', name: 'GitLab', envKey: 'GITLAB_ACCESS_TOKEN', detail: 'Personal access token with read_api access.', helpUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
  { id: 'github', name: 'GitHub', envKey: 'GITHUB_ACCESS_TOKEN', detail: 'Personal access token for repository sync and content publishing.', helpUrl: 'https://github.com/settings/personal-access-tokens' },
  { id: 'github-agents', name: 'GitHub build agents', envKey: 'GITHUB_AGENT_TOKEN', detail: 'Optional fine-grained token for the Build pipeline.', fallbackKey: 'GITHUB_ACCESS_TOKEN', fallbackName: 'GitHub token', helpUrl: 'https://github.com/settings/personal-access-tokens' },
  { id: 'blog', name: 'Blog publishing', envKey: 'BLOG_POSTS_API_KEY', detail: 'API key for The Microsoft Cloud Blog.' },
  { id: 'bluesky', name: 'Bluesky', envKey: 'BLUESKY_APP_PASSWORD', detail: 'App password for the configured Bluesky account.', helpUrl: 'https://bsky.app/settings/app-passwords' },
  { id: 'ica', name: 'IBM ICA', envKey: 'ICA_API_KEY', detail: 'Coding-agent API key for ICA chat.' },
  { id: 'ica-consulting', name: 'IBM ICA consulting', envKey: 'ICA_CONSULTING_KEY', detail: 'Consulting API key for ICA document collections and files.' },
  { id: 'tavily', name: 'Tavily web search', envKey: 'TAVILY_API_KEY', detail: 'API key for internet search.', helpUrl: 'https://app.tavily.com/' },
  { id: 'azure-openai', name: 'Azure OpenAI', envKey: 'AZURE_OPENAI_API_KEY', detail: 'API key for the main Azure OpenAI resource.' },
  { id: 'azure-reasoning', name: 'Azure OpenAI reasoning', envKey: 'AZURE_OPENAI_API_KEY_GPT54', detail: 'API key for the separate reasoning-model resource.', requiresKey: 'AZURE_OPENAI_ENDPOINT_GPT54' },
  { id: 'azure-speech', name: 'Azure Speech', envKey: 'AZURE_SPEECH_KEY', detail: 'Optional separate Speech resource key.', fallbackKey: 'AZURE_OPENAI_API_KEY', fallbackName: 'Azure OpenAI key' },
  { id: 'azure-tts', name: 'Azure text-to-speech', envKey: 'AZURE_TTS_API_KEY', detail: 'API key for the configured text-to-speech endpoint.', requiresKey: 'AZURE_TTS_ENDPOINT' },
  { id: 'azure-vision', name: 'Azure Vision', envKey: 'AZURE_VISION_KEY', detail: 'API key for image OCR.', requiresKey: 'AZURE_VISION_ENDPOINT' },
  { id: 'azure-search', name: 'Azure AI Search', envKey: 'FOUNDRY_IQ_SEARCH_ADMIN_KEY', detail: 'API key for Foundry IQ search and indexing.', requiresKey: 'FOUNDRY_IQ_SEARCH_ENDPOINT' },
  { id: 'screenshot', name: 'Screenshot service', envKey: 'SCREENSHOT_SERVICE_KEY', detail: 'API key for the configured screenshot service.', requiresKey: 'SCREENSHOT_SERVICE_URL' },
] as const;

export type CredentialName = typeof connectionCredentials[number]['envKey'];

let savedValues: ReadonlyMap<CredentialName, string> = new Map();

export function credentialValue(name: CredentialName, fallback: string | undefined): string | undefined {
  return savedValues.get(name) ?? fallback;
}

export function replaceCredentialValues(values: ReadonlyMap<CredentialName, string>): void {
  savedValues = new Map(values);
}

export function setCredentialValue(name: CredentialName, value: string): void {
  savedValues = new Map([...savedValues, [name, value]]);
}
