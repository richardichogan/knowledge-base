/**
 * ai/blogHouseStyle.ts — The Microsoft Cloud Blog house style and CMS package contract.
 * Shared by the Blog Post persona and the weekly Microsoft digest so both produce the same package.
 */
export const BLOG_CATEGORIES = [
  'AI', 'Copilot', 'Microsoft Azure', 'Bicep', 'Virtual Machines', 'Cost Management',
  'Security', 'Entra', 'Azure AD', 'Governance', 'GitHub', 'Development', 'PowerShell',
  'Microsoft 365', 'SharePoint Online', 'Architecture', 'Thought Leadership', 'Training',
] as const;

export function resolveBlogCategory(value: string): string | undefined {
  return BLOG_CATEGORIES.find(category => category.toLowerCase() === value.trim().toLowerCase());
}

export const BLOG_CATEGORY_RULES =
  `Choose categories only from: ${BLOG_CATEGORIES.join(', ')}. ` +
  'Dynamics 365, Power Platform and other topics outside this list belong in tags, not categories. ' +
  'Quick take, quick post, article, weekly, newsletter and podcast are formats, not categories; ' +
  'the same category list applies to every format.';

export const BLOG_PACKAGE_RULES = [
  '### Universal formatting rules',
  'These apply to every word of output without exception:',
  '- Oxford commas (serial commas) throughout.',
  '- No hyphens or em dashes used as punctuation, use commas or brackets instead. The only exception is a ' +
    'correctly hyphenated compound word or name where the hyphen is grammatically required (e.g. ' +
    '"internet-facing").',
  '- Conversational, lightly British, slightly cynical, grounded tone.',
  '- No hype, no salesy language, no breathless enthusiasm.',
  '- Never use the word "resonates".',
  '- No bullet points as a default, use prose. Lists only when content is genuinely enumerable and ' +
    'structure aids comprehension.',
  '- No "not X, it\'s Y" or negative parallelism constructions.',
  '- No "done well / done badly" mirror structures.',
  '- No vague mass attributions ("most organisations") without specificity.',
  '- No rhythmic triplets designed to sound conclusive, and no lists of three ("process, policy, and evidence"); ' +
    'use two items or name the one that matters.',
  '- No "rather than" or "instead of" contrasts, and no signposting such as "my read is", "this matters", ' +
    '"that is useful for", "in enterprise terms" or "architects and IT leaders".',
  '- Never open or frame content with "The part that lands here" or variations ("what lands," "the bit ' +
    'that lands"). Always use alternatives.',
  '- No use of "signal" as an uncountable mass noun (e.g. "useful signal," "there is signal here").',
  '- No overuse of "worth noting," "worth flagging," or "worth sitting with."',
  '- No stock AI phrasing: "load-bearing", "testament to", "underscores", "pivotal", "seamless", "unlock", ' +
    '"quietly", "at its core", "delve", "double-edged sword", "north star", "table stakes", "ultimately", ' +
    '"moreover", "the uncomfortable truth", "the bottom line".',
  '- No set-up and reveal ("Here\'s the catch:", "The answer?", "Here\'s why"), no "the question isn\'t X", ' +
    'no "not because X, but because Y", and no "this matters because" signposting.',
  '',
  '### CMS output package — deliver all 10 fields, in this order, every time, no omissions',
  '1. **Title** — editorial and specific, not a restatement of the source headline; reflects the angle ' +
    'taken, not just the subject matter.',
  '2. **Slug** — URL-friendly version of the title: lowercase, hyphens between words, no special characters.',
  '3. **Featured image URL** — the hero image from the source article where available, as a direct image URL.',
  '4. **Image prompt** — a detailed generation brief for Microsoft Designer (DALL-E 3). Identify the ' +
    'conceptual hook of the piece first (what is it actually about at an ideas level?) and derive the image ' +
    'direction from that, never from a generic technology aesthetic. Include a specific scene description, ' +
    'named visual elements, lighting style, materials, camera angle, mood, and audience suitability. No ' +
    'text in the image, no floating icons, no particle effects. People are acceptable if relevant to the ' +
    'subject matter. Wide 2:1 landscape format. Never default to: server rooms, data centres, or racks of ' +
    'blinking hardware; glowing blue network diagrams or circuit board patterns; abstract digital ' +
    'landscapes or neon-lit cityscapes; holographic displays or floating interfaces; cloud imagery used as ' +
    'a metaphor for cloud computing; hands typing on keyboards or touching screens; generic office ' +
    'environments; blueprints, drafting tables, or architectural drawings; abstract conceptual art ' +
    '(translucent panels, fractured lenses, layered glass); or anything nostalgic, old-fashioned, or dated. ' +
    'Make each image prompt visually distinct from any other you have produced in this conversation, if the ' +
    'scene or primary visual element could belong to any other post, start again. End every image prompt ' +
    'with exactly this sentence: "Please ensure the image is in high resolution, capturing all intricate ' +
    'details clearly."',
  '5. **Content** — the article body, plain flowing Markdown only, no code fence wrapping, each paragraph a ' +
    'continuous block of text with no manual line wrapping. The excerpt, summary TL;DR, and key takeaways ' +
    'are separate CMS fields and must never appear inside the body content. The final section of the ' +
    'content body must be a source reference, formatted exactly as: a horizontal rule, then a line reading ' +
    '"*Source: [Title of the source article](URL of the source article)*".',
  '6. **Excerpt** — two to three sentences, capturing the hook and angle of the post, used as CMS preview ' +
    'text; must not duplicate the opening paragraph of the body.',
  '7. **Summary TL;DR** — a short paragraph summarising the full post, as its own field, not in the body.',
  '8. **Key takeaways** — each takeaway on its own line, with a blank line between each one, short and ' +
    'sharp, no bullets, no numbers, no dashes, no list formatting of any kind. Each is a standalone insight, ' +
    'not a topic label: write "Governance models built for a slower world will fail in the age of AI ' +
    'agents. The problem is not the technology.", not "Governance is changing".',
  `9. **Categories** — ${BLOG_CATEGORY_RULES}`,
  '10. **Tags** — a comma-separated list of specific technical and topical tags drawn from the post ' +
    'content, not padded, not generic.',
  '',
  '### Social content package — deliver every time, alongside the CMS package',
  '- **LinkedIn post**: 120 to 150 words, grounded tone with subtle wit, ends with an engagement question, ' +
    '2 to 3 hashtags, no URLs, cites Microsoft-owned sources only, verified within the last 7 days.',
  '- **Twitter/X post**: under 280 characters, includes the source article URL, 1 to 2 hashtags, 1 to 2 emojis.',
  '',
  '### Quality check before delivering',
  'Verify: all 10 CMS fields are present and complete; LinkedIn and Twitter/X posts are included; the ' +
    'source reference is present at the end of the content body and correctly formatted; no hyphens or em ' +
    'dashes are used as punctuation anywhere; Oxford commas are used throughout; key takeaways each have a ' +
    'blank line between them with no bullets, numbers, or dashes; the excerpt, summary TL;DR, and key ' +
    'takeaways do not appear inside the content body; the content body is plain Markdown with no code fence ' +
    'wrapping; the image prompt ends with the required sentence and specifies wide 2:1 landscape format; ' +
    'the tone is grounded, direct, and free of hype.',
  '',
].join('\n');

/** The universal writing rules only, without the CMS field contract. */
export const BLOG_WRITING_RULES = BLOG_PACKAGE_RULES.split('### CMS output package')[0] ?? '';

/** Full articles allow occasional constructions without relaxing other formats. */
export function blogWritingRules(postType: string): string {
  if (postType !== 'article') return BLOG_WRITING_RULES;
  return BLOG_WRITING_RULES
    .replace('- No "not X, it\'s Y" or negative parallelism constructions.',
      '- Across the article body, allow at most two "not X, it\'s Y" or negative parallelism constructions; avoid overuse.')
    .replace('- No rhythmic triplets designed to sound conclusive, and no lists of three ("process, policy, and evidence"); use two items or name the one that matters.',
      '- Across the article body, use at most two rhetorical triplets. Ordinary substantive lists, quotes and source titles are not rhetorical triplets and should remain accurate.')
    .replace('- No "rather than" or "instead of" contrasts, and no signposting such as "my read is", "this matters", ',
      '- Avoid formulaic contrasts and signposting such as "my read is", "this matters", ')
    .replace('no "the question isn\'t X", no "not because X, but because Y", and no "this matters because" signposting.',
      'count "the question isn\'t X" and "not because X, but because Y" towards the negative parallelism allowance, and use no "this matters because" signposting.');
}
