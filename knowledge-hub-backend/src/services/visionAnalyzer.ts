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
export async function analyzeImageWithVision(
  imageBuffer: Buffer,
  mimeType: string,
  userQuestion?: string,
  options: { designReview?: boolean } = {},
): Promise<string> {
  try {
    if (options.designReview === true && env.AZURE_OPENAI_ENDPOINT_GPT54) {
      return await readScreenForDesignReview(imageBuffer, mimeType, userQuestion);
    }
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
                text: [
                  'Analyze this screenshot or image in detail so another AI assistant can reason over it.',
                  'Describe: 1) What UI elements or content are visible? 2) What data, charts, diagrams, people, ' +
                    'or objects are shown? 3) What is the main purpose or context? 4) All legible text, numbers, ' +
                    'labels, warnings, and relationships that matter. Distinguish direct visual evidence from ' +
                    'your inference, and do not invent details that are not visible.',
                  userQuestion?.trim()
                    ? `Pay particular attention to evidence relevant to this user question: ${userQuestion.trim()}`
                    : '',
                ].filter(Boolean).join('\n'),
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
        max_completion_tokens: 1000,
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

/**
 * Demo Designer screenshots: the reasoning model (gpt-5.4) reads the screen
 * with a design-review brief and a much larger budget, so the review is based
 * on layout, hierarchy, states and every label, not a short general summary.
 */
async function readScreenForDesignReview(imageBuffer: Buffer, mimeType: string, userQuestion?: string): Promise<string> {
  const response = await fetch(`${env.AZURE_OPENAI_ENDPOINT_GPT54}/openai/deployments/${env.AZURE_OPENAI_DEPLOYMENT_GPT54}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`, {
    method: 'POST',
    headers: { 'api-key': env.AZURE_OPENAI_API_KEY_GPT54 ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'You are reading an application screen so a UX and demo designer can review it without seeing it.',
              'Be exhaustive and exact. Cover, in this order:',
              '1) Screen identity: product, screen name, which journey step it appears to be.',
              '2) Layout: regions (header, nav, main, side panels, footer), their position and relative size, and what the eye lands on first, second and third.',
              '3) Every component per region, top to bottom: headings, cards, tables (columns and every row), buttons (label, style, primary or secondary, enabled or disabled), chips, badges, tabs, inputs, icons.',
              '4) All visible text verbatim, including labels, values, helper text, status text and numbers.',
              '5) State signals: what is selected or highlighted, what shows progress, ownership, status or pending work, and anything that looks contradictory.',
              '6) Visual design: colour use and meaning, contrast concerns, density, spacing and alignment, consistency, truncated or cramped text.',
              'Separate what is visible from your inference. Do not invent anything that is not on screen.',
              userQuestion?.trim() ? `The designer's question, so note evidence relevant to it: ${userQuestion.trim()}` : '',
            ].filter(Boolean).join('\n'),
          },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}`, detail: 'high' } },
        ],
      }],
      max_completion_tokens: 8000,
    }),
  });
  if (!response.ok) {
    console.error('[visionAnalyzer] Design-review read failed:', response.status, await response.text());
    return '';
  }
  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}
