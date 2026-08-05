/**
 * Vision analysis using Azure OpenAI GPT-4V.
 * Analyzes image content semantically (diagrams, charts, layouts, etc)
 * to provide context Athena can understand and search.
 */

import { env } from '../config/env.js';

/**
 * Analyze an image buffer using GPT-4V vision capabilities via Azure OpenAI.
 * Returns a semantic description of the image content.
 */
export async function analyzeImageWithVision(imageBuffer: Buffer, mimeType: string): Promise<string> {
  try {
    if (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_API_KEY) {
      console.warn('[visionAnalyzer] Azure OpenAI credentials not configured, skipping vision analysis');
      return '';
    }

    const base64Image = imageBuffer.toString('base64');

    // Use Azure OpenAI REST API directly to avoid SDK version issues
    const response = await fetch(`${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${env.AZURE_OPENAI_DEPLOYMENT_GPT4O}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`, {
      method: 'POST',
      headers: {
        'api-key': env.AZURE_OPENAI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analyze this screenshot or image in detail. Describe: 1) What UI elements or content are visible? 2) What data, charts, or diagrams are shown? 3) What is the main purpose or context of this image? 4) Any text, numbers, or labels that appear? Provide a comprehensive description that would help someone understand the image without seeing it.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[visionAnalyzer] Azure OpenAI API error:', response.status, error);
      return '';
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;

    if (!content || typeof content !== 'string') {
      console.warn('[visionAnalyzer] No text content in vision response');
      return '';
    }

    return content;
  } catch (err) {
    console.error('[visionAnalyzer] Vision analysis failed:', err);
    // Return empty string on failure so processing continues with OCR fallback
    return '';
  }
}
