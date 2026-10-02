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
      // Falls back to the quick read below if the detailed one fails or runs long.
      const detailed = await readScreenForDesignReview(imageBuffer, mimeType, userQuestion).catch((err: unknown) => {
        console.warn('[visionAnalyzer] Design-review read failed; using the quick read.', err);
        return '';
      });
      if (detailed !== '') return detailed;
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
        max_completion_tokens: 3000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[visionAnalyzer] Azure OpenAI API error:', response.status, error);
      return '';
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string }; finish_reason?: string }>;
    };
    const content = data.choices?.[0]?.message?.content;

    if (!content || typeof content !== 'string') {
      console.warn('[visionAnalyzer] No text content in vision response');
      return '';
    }

    return data.choices[0]?.finish_reason === 'length' ? `${content}\n\n${CUT_OFF_NOTE}` : content;
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
const SCREEN_READ_TIMEOUT_MS = 75_000;

async function readScreenForDesignReview(imageBuffer: Buffer, mimeType: string, userQuestion?: string): Promise<string> {
  const response = await fetch(`${env.AZURE_OPENAI_ENDPOINT_GPT54}/openai/deployments/${env.AZURE_OPENAI_DEPLOYMENT_SCREEN_READ ?? env.AZURE_OPENAI_DEPLOYMENT_GPT54}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`, {
    method: 'POST',
    headers: { 'api-key': env.AZURE_OPENAI_API_KEY_GPT54 ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'You are reading a screenshot (usually an application screen) so someone can work with it, and a UX or demo designer can review it, without seeing it.',
              'Be exhaustive and exact. Cover, in this order:',
              '1) Screen identity: product, screen name, which journey step it appears to be.',
              '2) Layout: regions (header, nav, main, side panels, footer), their position and relative size, and what the eye lands on first, second and third.',
              '3) Every component per region, top to bottom: headings, cards, tables (columns and every row), buttons (label, style, primary or secondary, enabled or disabled), chips, badges, tabs, inputs, icons.',
              '4) All visible text verbatim, including labels, values, helper text, status text and numbers.',
              '5) State signals: what is selected or highlighted, what shows progress, ownership, status or pending work, and anything that looks contradictory.',
              '6) Layout and visual design, as a reviewer would see it. Describe, then flag specific problems with where they are on screen:',
              '   - grid and alignment: do edges, columns and baselines line up; anything off-grid;',
              '   - visual hierarchy: what is most prominent (size, weight, colour, position) and whether that matches what matters most on this screen;',
              '   - spacing and density: cramped or uneven gaps, crowded areas, wasted space;',
              '   - typography: sizes and weights used, too many styles, hard-to-read text;',
              '   - colour and contrast: what colours signal, low-contrast text, colour-only meaning;',
              '   - consistency: similar things styled differently (buttons, chips, cards, icons);',
              '   - truncated, clipped or overlapping text and elements;',
              '   - accessibility concerns visible from the image (small targets, low contrast, missing labels).',
              'Separate what is visible from your inference. Do not invent anything that is not on screen.',
              userQuestion?.trim() ? `The designer's question, so note evidence relevant to it: ${userQuestion.trim()}` : '',
            ].filter(Boolean).join('\n'),
          },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}`, detail: 'high' } },
        ],
      }],
      max_completion_tokens: 8000,
    }),
    signal: AbortSignal.timeout(SCREEN_READ_TIMEOUT_MS),
  });
  if (!response.ok) {
    console.error('[visionAnalyzer] Design-review read failed:', response.status, await response.text());
    return '';
  }
  const data = (await response.json()) as { choices: Array<{ message: { content: string }; finish_reason?: string }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  return content !== '' && data.choices[0]?.finish_reason === 'length' ? `${content}\n\n${CUT_OFF_NOTE}` : content;
}

/** Added when a read hit its length limit, so Athena says so instead of guessing what's missing. */
const CUT_OFF_NOTE = '[This read was cut off before the end of the screenshot — anything after this point is missing. Say so and ask him to crop or split the screenshot if it matters.]';

/** One screen sent to reviewScreensWithVision. */
export interface ScreenImage {
  buffer: Buffer;
  mimeType: string;
  /** Step name, e.g. "Case detail". */
  label: string;
  /** What he wrote about the areas he marked on this screen (marked as numbered orange boxes). */
  note?: string | undefined;
}

const SCREEN_REVIEW_TIMEOUT_MS = 150_000;

/**
 * Looks at several screens together (the reasoning model sees the images
 * themselves): a journey review focused on what changes between steps, or a
 * focused look at the areas he marked. Returns '' if it can't run.
 */
export async function reviewScreensWithVision(
  screens: ScreenImage[],
  mode: 'journey' | 'focus',
  question: string,
): Promise<string> {
  if (!env.AZURE_OPENAI_ENDPOINT_GPT54 || screens.length === 0) return '';
  const brief = mode === 'journey'
    ? [
        `These ${screens.length.toString()} screenshots are one user journey, in order: ${screens.map((s, i) => `${(i + 1).toString()}. ${s.label}`).join(', ')}.`,
        'Review it as a senior UX and demo designer. Be concrete: cite screen numbers and the exact on-screen text.',
        '1) For each transition (1→2, 2→3 …): what the user just did, what should visibly change as a result (state, status, ownership, confirmation, what is no longer actionable), what actually changes, and what is missing or contradictory.',
        '2) Consistency across the screens: names, status labels, data values, terminology.',
        '3) The top issues for a live demo, ranked, each with the specific fix.',
        'Orange numbered boxes are areas he marked; give them particular attention, with his notes.',
      ]
    : [
        'He marked areas on this screen as numbered orange boxes and wants them looked at closely.',
        'Describe exactly what is inside each marked area (all text verbatim, state, what it implies), then answer his note and question with specific fixes.',
      ];
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: [...brief, question.trim() !== '' ? `His question: ${question.trim()}` : ''].filter(Boolean).join('\n') },
  ];
  screens.forEach((s, i) => {
    content.push({ type: 'text', text: `Screen ${(i + 1).toString()}: ${s.label}${s.note ? ` — his note on the marked areas: ${s.note}` : ''}` });
    content.push({ type: 'image_url', image_url: { url: `data:${s.mimeType};base64,${s.buffer.toString('base64')}`, detail: 'high' } });
  });
  try {
    const response = await fetch(`${env.AZURE_OPENAI_ENDPOINT_GPT54}/openai/deployments/${env.AZURE_OPENAI_DEPLOYMENT_SCREEN_READ ?? env.AZURE_OPENAI_DEPLOYMENT_GPT54}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`, {
      method: 'POST',
      headers: { 'api-key': env.AZURE_OPENAI_API_KEY_GPT54 ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content }], max_completion_tokens: 10_000 }),
      signal: AbortSignal.timeout(SCREEN_REVIEW_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error('[visionAnalyzer] Screen review failed:', response.status, await response.text());
      return '';
    }
    const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    console.error('[visionAnalyzer] Screen review failed:', err);
    return '';
  }
}
