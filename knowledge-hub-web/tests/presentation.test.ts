import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { presentationScript, requiresVisualCraft, requiresVisualMotion } from '../src/features/autocue/presentationScript';
import { appendVoiceTranscript, finishVoiceTranscript, submitVoiceTranscript } from '../src/services/voiceTranscript';
import { encodeWav, resampleVoiceAudio } from '../src/components/athena/speech';
import { parseScriptBullets, scriptSentenceLines } from '../src/features/podcasts/scriptFormatting';
import { episodeScriptText } from '../src/types/podcastEpisodes';
import { scriptRichDocument, scriptRichText } from '../src/features/podcasts/scriptRichText';
import { scriptAnnotationRuns, scriptInlineContent, scriptReadingText, spokenScriptText } from '../../knowledge-hub-backend/src/podcasts/scriptAnnotations';
import { annotatedPresentation } from '../src/features/podcasts/scriptAnnotations';
import { SCRIPT_COLOUR_VALUES } from '../src/features/podcasts/scriptRichText';
import { parseScriptVisuals, parseVisualArtwork, parseVisualComposition, scriptVisualSource, visualSourceCurrent, type VisualScriptBlock } from '../../knowledge-hub-backend/src/utils/scriptVisuals';
import { parsePresentationVisuals } from '../../athena-desktop/src/elgatoProtocol';

test('layered compositions preserve semantic links and reject unsafe geometry and impossible reveal order', () => {
  const node = { id: 'worker', kind: 'panel', x: 100, y: 300, width: 320, height: 240,
    label: 'Worker', detail: '', icon: 'worker', tone: 'teal', reveal: 0 };
  const composition = { label: '', imagePrompt: '', nodes: [node, { ...node, id: 'owner', x: 1000, reveal: 2 }],
    links: [{ from: 'worker', to: 'owner', label: 'Exception', tone: 'warning', reveal: 2, style: 'solid' }] };
  assert.deepEqual(parseVisualComposition(composition, 2), composition);
  assert.throws(() => parseVisualComposition({ ...composition, nodes: [{ ...node, width: 1500 }] }, 2), /geometry|area/);
  assert.throws(() => parseVisualComposition({ ...composition, nodes: [{ ...node, x: NaN }] }, 2), /geometry/);
  assert.throws(() => parseVisualComposition({ ...composition, nodes: [{ ...node, kind: 'html' }] }, 2), /node/);
  assert.throws(() => parseVisualComposition({ ...composition, nodes: [node, node] }, 2), /unique/);
  assert.throws(() => parseVisualComposition({ ...composition, links: [{ ...composition.links[0], reveal: 1 }] }, 2), /endpoints/);
  assert.throws(() => parseVisualComposition(composition, 1), /reveal/);
});

test('visual motion is typed, reversible by reveal index and backward compatible with existing compositions', () => {
  const node = { id: 'worker', kind: 'icon', x: 100, y: 300, width: 340, height: 240,
    label: 'Delegated work', detail: '', icon: 'worker', tone: 'teal', reveal: 0 };
  const base = { label: 'Workforce', imagePrompt: '', nodes: [node, { ...node, id: 'owner', x: 1000, reveal: 1 }],
    links: [{ from: 'worker', to: 'owner', label: 'Exception', tone: 'warning', reveal: 1, style: 'solid' }] };
  for (const entrance of ['fade', 'rise', 'left', 'right', 'scale', 'wipe']) {
    for (const emphasis of ['highlight', 'underline', 'strike']) {
      const composition = { ...base, nodes: [{ ...node, entrance, emphasis }, base.nodes[1]],
        links: [{ ...base.links[0], route: 'arc', motion: 'flow', fromPort: 'right', toPort: 'top' }] };
      assert.deepEqual(parseVisualComposition(composition, 1), composition);
    }
  }
  assert.deepEqual(parseVisualComposition(base, 1), base);
  assert.throws(() => parseVisualComposition({ ...base, nodes: [{ ...node, entrance: 'url(secret)' }] }, 1), /entrance/);
  assert.throws(() => parseVisualComposition({ ...base, nodes: [{ ...node, emphasis: 'html' }] }, 1), /emphasis/);
  assert.throws(() => parseVisualComposition({ ...base, links: [{ ...base.links[0], motion: 'forever' }] }, 1), /motion/);
  assert.throws(() => parseVisualComposition({ ...base, links: [{ ...base.links[0], route: 'javascript:run()' }] }, 1), /route/);
  assert.throws(() => parseVisualComposition({ ...base, links: [{ ...base.links[0], fromPort: 'middle' }] }, 1), /port/);
  assert.throws(() => parseVisualComposition({ ...base, links: [{ ...base.links[0], fromPort: ['right'] }] }, 1), /port/);
  assert.throws(() => parseVisualComposition({ ...base, links: [{ ...base.links[0], toPort: 'url(secret)' }] }, 1), /port/);
});

test('static header treatments and typographic titles round-trip without mixing images with animated subjects', () => {
  const section: VisualScriptBlock = { id: 'section', type: 'heading', props: { scriptSection: true }, children: [
    { id: 'spoken', type: 'paragraph', content: [{ text: 'Introduce responsible delegation.' }] },
  ] };
  const composition = { label: 'Delegation', imagePrompt: '', nodes: [], links: [] };
  const title = { id: 'opening', template: 'title', title: 'Responsibility stays human', subtitle: '',
    imageUrl: '', imageAlt: '', cue: { blockId: 'spoken', quote: '' }, items: [], composition };
  const pack = { version: 1, source: scriptVisualSource(section), scenes: [title] };
  assert.deepEqual(parseScriptVisuals(pack, section).scenes[0]?.composition, composition);
  assert.throws(() => parseVisualComposition(composition, 0), /nodes/);
  assert.throws(() => parseVisualComposition(composition, 1, true), /title-only/);
  for (const imageTreatment of ['full', 'blend']) {
    const header = { ...title, imageUrl: 'https://images.example/header.png', imageAlt: 'A clear responsibility boundary',
      composition: { ...composition, imageTreatment } };
    const stored = { ...pack, scenes: [header] };
    assert.deepEqual(parseScriptVisuals(stored, section).scenes[0]?.composition, header.composition);
    section.props!['scriptVisuals'] = JSON.stringify(stored);
    const result = presentationScript(JSON.stringify([section]), { script: true });
    assert.deepEqual(result.visuals[0]?.composition, header.composition);
    assert.equal(requiresVisualCraft(result.visuals), true);
    assert.throws(() => parseScriptVisuals({ ...pack, scenes: [{ ...header, template: 'concept' }] }, section), /header|image/i);
    assert.throws(() => parseScriptVisuals({ ...pack, scenes: [{ ...header, imageUrl: '' }] }, section), /image/i);
    assert.throws(() => parseScriptVisuals({ ...pack, scenes: [{ ...header, items: [
      { label: 'Build', detail: '', cue: { blockId: 'spoken', quote: '' } },
    ] }] }, section), /header image/i);
  }
  section.props!['scriptVisuals'] = JSON.stringify(pack);
  assert.equal(requiresVisualCraft(presentationScript(JSON.stringify([section]), { script: true }).visuals), true);
  assert.throws(() => parseScriptVisuals({ ...pack, scenes: [{ ...title,
    composition: { ...composition, imageTreatment: 'inset' },
  }] }, section), /image/i);
});

test('illustrated scenes retain bounded vector art and reject executable paths and invalid geometry', () => {
  const shape = { kind: 'path', x: 0, y: 0, width: 0, height: 0, radius: 0, d: 'M 800 200 L 1100 450 Z', tone: 'teal', opacity: 0.6 };
  const artwork = { description: 'A boundary around delegated work', shapes: [shape] };
  assert.deepEqual(parseVisualArtwork(artwork), artwork);
  assert.throws(() => parseVisualArtwork({ ...artwork, shapes: [{ ...shape, d: '<script>run()</script>' }] }), /path/);
  assert.throws(() => parseVisualArtwork({ ...artwork, shapes: [{ ...shape, x: Infinity }] }), /geometry/);
  assert.throws(() => parseVisualArtwork({ ...artwork, shapes: [{ ...shape, tone: 'url(secret)' }] }), /tone/);
  assert.throws(() => parseVisualArtwork({ ...artwork, shapes: Array(33).fill(shape) }), /32/);
});

test('visual source ignores editor formatting defaults but tracks spoken text and cue identities', () => {
  const section: VisualScriptBlock = { children: [{ id: 'spoken', type: 'paragraph', content: [{ text: 'Explain the idea.' }] }] };
  const source = scriptVisualSource(section);
  section.children![0]!.props = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };
  section.children![0]!.content = [{ type: 'text', text: 'Explain the idea.', styles: {} }];
  assert.equal(scriptVisualSource(section), source);
  section.children![0]!.id = 'replacement';
  assert.notEqual(scriptVisualSource(section), source);
  section.children![0]!.id = 'spoken';
  section.children![0]!.content = [{ text: 'Explain a different idea.' }];
  assert.notEqual(scriptVisualSource(section), source);
  section.children![0]!.content = [{ type: 'noteMention', props: { noteId: 'original' } }];
  const linkedSource = scriptVisualSource(section);
  section.children![0]!.content = [{ type: 'noteMention', props: { noteId: 'replacement' } }];
  assert.notEqual(scriptVisualSource(section), linkedSource);
});

test('visual cues map exact script blocks into the presented text without copying headings or altering rich runs', () => {
  const section: VisualScriptBlock = { id: 'section', type: 'heading', props: { scriptSection: true }, content: [{ text: 'Not spoken' }], children: [
    { id: 'first', type: 'paragraph', content: [{ type: 'text', text: 'Explain the idea. ', styles: { bold: true } }, { type: 'text', text: 'Then connect it.' }] },
    { id: 'second', type: 'bulletListItem', content: [{ type: 'text', text: 'Show the result.' }] },
  ] };
  const visuals = { version: 1, source: scriptVisualSource(section), scenes: [{
    id: 'concept', template: 'concept', title: 'Connected thinking', subtitle: '', imageUrl: '', imageAlt: '', layout: 'split', presenterLayout: true,
    artwork: { description: 'Connected ideas', shapes: [{ kind: 'circle', x: 1100, y: 450, width: 0, height: 0, radius: 120, d: '', tone: 'teal', opacity: 0.5 }] },
    composition: { label: '', imagePrompt: '', nodes: [
      { id: 'connection', kind: 'icon', x: 100, y: 300, width: 350, height: 240, label: 'Connection', detail: '', tone: 'teal', icon: 'system', reveal: 1 },
      { id: 'result', kind: 'icon', x: 1000, y: 300, width: 350, height: 240, label: 'Result', detail: '', tone: 'success', icon: 'check', reveal: 2 },
    ], links: [{ from: 'connection', to: 'result', label: '', tone: 'teal', reveal: 2, style: 'solid' }] },
    cue: { blockId: 'first', quote: '' }, items: [
      { label: 'Connection', detail: '', cue: { blockId: 'first', quote: 'Then connect' } },
      { label: 'Result', detail: '', cue: { blockId: 'second', quote: 'Show the result' } },
    ],
  }] };
  const plain = presentationScript(JSON.stringify([section]), { script: true });
  section.props!['scriptVisuals'] = JSON.stringify(visuals);
  const result = presentationScript(JSON.stringify([section]), { script: true });
  assert.equal(result.text, plain.text);
  assert.deepEqual(result.runs, plain.runs);
  assert.equal(result.visuals[0]?.at, 0);
  assert.equal(result.visuals[0]?.layout, 'split');
  assert.equal(result.visuals[0]?.presenterLayout, true);
  assert.equal(requiresVisualMotion(result.visuals), true);
  assert.equal(requiresVisualMotion(result.visuals.map(scene => ({ ...scene, presenterLayout: false }))), false);
  assert.equal(requiresVisualMotion(result.visuals.map(scene => ({ ...scene, presenterLayout: false,
    composition: { ...scene.composition!, nodes: scene.composition!.nodes.map(node => ({ ...node, emphasis: 'highlight' as const })) },
  }))), true);
  assert.throws(() => parseScriptVisuals({ ...visuals, scenes: [{ ...visuals.scenes[0], presenterLayout: 'true' }] }, section), /presenter layout/);
  assert.deepEqual(result.visuals[0]?.artwork, visuals.scenes[0]?.artwork);
  assert.deepEqual(result.visuals[0]?.composition, visuals.scenes[0]?.composition);
  assert.equal(result.visuals[0]?.items[0]?.at, result.text.indexOf('Then connect'));
  assert.equal(result.visuals[0]?.items[1]?.at, result.text.indexOf('Show the result'));
  assert.equal(result.text.includes('Not spoken'), false);
  section.children![0]!.content = [{ text: 'The script changed.' }];
  const changed = presentationScript(JSON.stringify([section]), { script: true });
  assert.equal(changed.text.includes('The script changed.'), true);
  assert.deepEqual(changed.visuals, []);
  assert.match(changed.visualIssue ?? '', /out of date/);
});

test('visual cues survive blank lines and paragraph splits, and broken visuals never block presenting', () => {
  const spoken = (id: string, text: string): VisualScriptBlock => ({ id, type: 'paragraph', content: text ? [{ text }] : [] });
  const section: VisualScriptBlock = { id: 'section', type: 'heading', props: { scriptSection: true }, content: [{ text: 'Why' }], children: [
    spoken('first', 'Your AI strategy is not enough.'), spoken('second', 'Copilots, agents and automation can each help.'),
  ] };
  const visuals = { version: 1, source: scriptVisualSource(section), scenes: [{
    id: 'intro', template: 'concept', title: 'Operating model', subtitle: '', imageUrl: '', imageAlt: '',
    cue: { blockId: 'second', quote: '' }, items: [{ label: 'Help', detail: '', cue: { blockId: 'second', quote: 'each help' } }],
  }] };
  section.props!['scriptVisuals'] = JSON.stringify(visuals);
  // Enter at the start of a paragraph keeps its id on the new blank line and moves the text to a new block id.
  section.children = [spoken('first', 'Your AI strategy is not enough.'), spoken('second', ''), spoken('moved', 'Copilots, agents and automation can each\nhelp.')];
  assert.equal(visualSourceCurrent(visuals.source, section), true);
  assert.equal(parseScriptVisuals(visuals, section).scenes.length, 1);
  const result = presentationScript(JSON.stringify([section]), { script: true });
  assert.equal(result.visualIssue, null);
  assert.equal(result.visuals[0]?.at, result.text.indexOf('Copilots'));
  assert.equal(result.visuals[0]?.items[0]?.at, result.text.indexOf('each\nhelp'));
  section.children = [spoken('first', 'Your AI strategy is not enough.'), spoken('moved', 'Copilots and agents can help.')];
  assert.equal(visualSourceCurrent(visuals.source, section), false);
  const stale = presentationScript(JSON.stringify([section]), { script: true });
  assert.equal(stale.text.includes('Copilots and agents can help.'), true);
  assert.deepEqual(stale.visuals, []);
  assert.match(stale.visualIssue ?? '', /Section "Why".*out of date/);
});

test('Script autocue starts each sentence on its own line and gaps sections only where no break already exists', () => {
  const card = (id: string, children: VisualScriptBlock[]): VisualScriptBlock =>
    ({ id, type: 'heading', props: { level: 2, scriptSection: true }, content: [{ text: id }], children });
  const result = presentationScript(JSON.stringify([
    card('one', [
      { type: 'paragraph', content: [{ text: 'Explain the idea. Then connect it! Why? Mr. Smith paid £3.50 at 9 a.m. today.' }] },
      { type: 'paragraph', content: [{ text: 'Already split.\nNext line. ' }, { type: 'hardBreak' }, { text: 'After break.' }] },
      { type: 'paragraph', content: [{ text: '• Bullet one. Still bullet.\nPlain one. ' }, { text: 'Plain two.', styles: { bold: true } }] },
      { type: 'bulletListItem', content: [{ text: 'List one. List two.' }] },
      { type: 'paragraph', content: [{ text: '* * * . . .' }] },
    ]),
    card('two', [{ type: 'paragraph', content: [] }, { type: 'paragraph', content: [{ text: 'Second section.' }] }]),
    card('three', [{ type: 'paragraph', content: [{ text: 'Third section.' }] }]),
  ]), { script: true });
  assert.equal(result.text, 'Explain the idea.\nThen connect it!\nWhy?\nMr. Smith paid £3.50 at 9 a.m. today.\n'
    + 'Already split.\nNext line. \nAfter break.\n• Bullet one. Still bullet.\nPlain one.\nPlain two.\n- List one. List two.\n* * * . . .\n'
    + '\nSecond section.\n\nThird section.');
  assert.equal(result.runs.map(run => run.text).join(''), result.text);
  assert.deepEqual(result.runs.find(run => run.text === 'Plain two.')?.styles, ['bold']);
  assert.equal(presentationScript(JSON.stringify([{ type: 'paragraph', content: [{ text: 'One. Two.' }] }])).text, 'One. Two.');
});

test('visual cues follow sentence line breaks and carry their script section for the section pause', () => {
  const section = (id: string, text: string, quote: string): VisualScriptBlock => {
    const block: VisualScriptBlock = { id, type: 'heading', props: { scriptSection: true }, content: [{ text: id }],
      children: [{ id: `${id}-spoken`, type: 'paragraph', content: [{ text }] }] };
    block.props!['scriptVisuals'] = JSON.stringify({ version: 1, source: scriptVisualSource(block), scenes: [{
      id, template: 'concept', title: id, subtitle: '', imageUrl: '', imageAlt: '', cue: { blockId: `${id}-spoken`, quote: '' },
      items: [{ label: 'Point', detail: '', cue: { blockId: `${id}-spoken`, quote } }],
    }] });
    return block;
  };
  const result = presentationScript(JSON.stringify([
    section('first', 'Explain the idea.   Then connect it.', 'Then connect'),
    { type: 'heading', props: { scriptSection: true }, content: [{ text: 'No visuals' }], children: [{ type: 'paragraph', content: [{ text: 'Bridge.' }] }] },
    section('last', 'Close the loop. Show the result.', 'Show the result'),
  ]), { script: true });
  assert.equal(result.visualIssue, null);
  assert.equal(result.text, 'Explain the idea.\nThen connect it.\n\nBridge.\n\nClose the loop.\nShow the result.');
  assert.equal(result.visuals[0]?.items[0]?.at, result.text.indexOf('Then connect'));
  assert.equal(result.visuals[1]?.at, result.text.indexOf('Close the loop'));
  assert.equal(result.visuals[1]?.items[0]?.at, result.text.indexOf('Show the result'));
  assert.deepEqual(result.visuals.map(scene => scene.section), [0, 2]);
  assert.deepEqual(parsePresentationVisuals(result.visuals, result.text.length)?.map(scene => scene.section), [0, 2]);
  assert.throws(() => parsePresentationVisuals([{ ...result.visuals[0], section: -1 }], result.text.length), /section/);
});

test('scene validation rejects unknown templates, ambiguous cues, wrong comparisons and out-of-order reveals', () => {
  const section = { children: [{ id: 'spoken', type: 'paragraph', content: [{ text: 'One then two then one.' }] }] };
  const scene = { id: 'scene', template: 'concept', title: 'Idea', subtitle: '', imageUrl: '', imageAlt: '',
    cue: { blockId: 'spoken', quote: '' }, items: [{ label: 'Part', detail: '', cue: { blockId: 'spoken', quote: 'two' } }] };
  const pack = { version: 1, source: scriptVisualSource(section), scenes: [scene] };
  assert.equal(parseScriptVisuals(pack, section).scenes[0]?.template, 'concept');
  assert.throws(() => parseScriptVisuals({ ...pack, scenes: [{ ...scene, template: 'html' }] }, section), /template/);
  assert.throws(() => parseScriptVisuals({ ...pack, scenes: [{ ...scene, template: 'comparison' }] }, section), /two sides/);
  assert.throws(() => parseScriptVisuals({ ...pack, scenes: [{ ...scene, cue: { blockId: 'missing', quote: '' } }] }, section), /existing spoken block/);
  assert.throws(() => parseScriptVisuals({ ...pack, scenes: [{ ...scene, cue: { blockId: 'spoken', quote: 'then' } }] }, section), /unique exact/);
  assert.throws(() => parseScriptVisuals({ ...pack, scenes: [{ ...scene, cue: { blockId: 'spoken', quote: 'one' },
    items: [{ ...scene.items[0], cue: { blockId: 'spoken', quote: 'One' } }] }] }, section), /order/);
  assert.throws(() => parseScriptVisuals({ ...pack, scenes: [{ ...scene, imageUrl: 'javascript:alert(1)' }] }, section), /HTTPS/);
});

test('standalone script emphasis styles target BlockNote inline colour attributes, not only block colours', async () => {
  const styles = await readFile(new URL('../src/styles/global.scss', import.meta.url), 'utf8');
  for (const value of Object.values(SCRIPT_COLOUR_VALUES)) {
    assert.ok(styles.includes(`[data-style-type="textColor"][data-value="${value}"]`),
      `Missing inline editor styling for ${value}`);
  }
});

test('standalone script controls stay sticky within the existing editor scroll area', async () => {
  const tools = await readFile(new URL('../src/notes/ScriptTools.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles/global.scss', import.meta.url), 'utf8');
  assert.ok(tools.includes('kh-script-tools kh-script-tools--sticky'));
  assert.match(styles, /&--sticky\s*\{\s*position: sticky;\s*top: 0;/);
  assert.ok(tools.includes('editor.onSelectionChange(refresh)'));
});

test('podcast sentence spacing leaves a blank line between sentences, preserving versions and links', () => {
  const text = 'Welcome to the podcast. Here is the running order.\r\n\r\nDiscuss version 5.4 and Microsoft 365. See https://example.com/news.\nKeep this deliberate break.';
  const expected = 'Welcome to the podcast.\n\nHere is the running order.\n\nDiscuss version 5.4 and Microsoft 365.\n\nSee https://example.com/news.\n\nKeep this deliberate break.';
  assert.equal(scriptSentenceLines(text), expected);
  assert.equal(scriptSentenceLines(expected), expected);
  assert.equal(scriptSentenceLines('  '), '');
});

test('podcast Elgato export separates sentences without altering stored cards or adding bullet items', () => {
  const cards = [{ id: 'card', title: 'Enterprise use', synopsis: 'Start here. Then explain the impact.\n\nThis part is optional.',
    bullets: ['First feature. Its constraint.', 'A possible enterprise use.'] }];
  const original = JSON.stringify(cards);
  assert.equal(episodeScriptText('Welcome. Recorded as live.', cards),
    'Welcome.\n\nRecorded as live.\n\nTopic 1\n\nStart here.\n\nThen explain the impact.\n\nThis part is optional.'
    + '\n\n• First feature.\n\nIts constraint.\n\n• A possible enterprise use.');
  assert.equal(JSON.stringify(cards), original);
});

test('podcast presentation numbers topics in current order without including full titles', () => {
  const cards = [
    { id: 'second', title: 'A very long second topic title', synopsis: 'Second topic script.', bullets: [] },
    { id: 'first', title: 'A very long first topic title', synopsis: 'First topic script.', bullets: ['Key point.'] },
    { id: 'untitled', title: '', synopsis: 'Untitled topic script.', bullets: [] },
  ];
  assert.equal(episodeScriptText('', cards),
    'Topic 1\n\nSecond topic script.\n\nTopic 2\n\nFirst topic script.\n\n• Key point.\n\nTopic 3\n\nUntitled topic script.');
  assert.equal(episodeScriptText('Intro only.', []), 'Intro only.');
});

test('podcast bullet continuation lines round-trip without becoming extra bullet points', () => {
  const bullets = ['A feature.\n\nIts constraint.', 'A possible enterprise use.'];
  const displayed = bullets.map(item => `• ${item}`).join('\n\n');
  assert.deepEqual(parseScriptBullets(displayed, displayed.length), { bullets, caret: displayed.length });
  const continuationCaret = displayed.indexOf('constraint') + 4;
  assert.equal(parseScriptBullets(displayed, continuationCaret).caret, continuationCaret);
  const pasted = '- First.\nContinuation.\n- Second.';
  assert.deepEqual(parseScriptBullets(pasted, pasted.length).bullets, ['First.\nContinuation.', 'Second.']);
  const continuation = '• A feature.\n';
  assert.deepEqual(parseScriptBullets(continuation, continuation.length), { bullets: ['A feature.\n'], caret: continuation.length });
  assert.deepEqual(parseScriptBullets('• ', 2), { bullets: [''], caret: 2 });
  assert.deepEqual(parseScriptBullets('', 0), { bullets: [], caret: 0 });
});

test('visual script documents round-trip saved emphasis and cues without displaying annotation syntax', () => {
  const saved = 'A [colour=teal]focus[/colour] now[pause]\n\nNext [colour=pink]point[/colour][beat]';
  const doc = scriptRichDocument(saved);
  assert.equal(scriptRichText(doc), saved);
  assert.equal(JSON.stringify(doc).includes('[colour='), false);
  assert.equal(JSON.stringify(doc).includes('[pause]'), false);
  assert.equal(scriptRichText(doc, 3, 8, false), 'focus');
  assert.equal(scriptRichText(doc, 12, 13, false), '[pause]');
  assert.equal(scriptRichText(doc, 3, 8), '[colour=teal]focus[/colour]');
  const changed = structuredClone(doc);
  const focus = changed.content![0]!.content![1]!;
  focus.marks = [{ type: 'scriptColour', attrs: { colour: 'yellow' } }];
  assert.match(scriptRichText(changed), /\[colour=yellow\]focus\[\/colour\]/);
  focus.marks = [];
  assert.match(scriptRichText(changed), /^A focus now\[pause\]/);
  assert.equal(scriptRichText(scriptRichDocument(scriptRichText(changed))), scriptRichText(changed));
  assert.throws(() => scriptRichDocument('[colour=teal]Unclosed'), /Close each/);
});

test('rich bullet editing keeps markers outside emphasis and retains continuation paragraphs', () => {
  const bullets = ['A [colour=yellow]feature[/colour].\n\nIts constraint.[pause]', 'A second point.[beat]'];
  const saved = bullets.map(item => `• ${item}`).join('\n\n');
  const doc = scriptRichDocument(saved, true);
  assert.equal(doc.content![0]!.type, 'bulletList');
  assert.equal(doc.content![0]!.content!.length, 2);
  assert.equal(scriptRichText(doc), saved);
  assert.deepEqual(parseScriptBullets(scriptRichText(doc), 0).bullets, bullets);
  assert.equal(scriptRichText(scriptRichDocument('', true)), '• ');
  assert.equal(scriptRichText(scriptRichDocument('One\nline\n\nAnother')), 'One\nline\n\nAnother');
});

test('script title, chapter and section blocks round-trip without exposing Markdown in the editor', () => {
  const script = '# My script\n\nOpening words.[pause]\n\n## Chapter one\n\n'
    + '[colour=teal]Important[/colour] words.\n\n### Detail\n\nClosing words.';
  const doc = scriptRichDocument(script);
  assert.deepEqual(doc.content!.map(block => block.type),
    ['heading', 'paragraph', 'heading', 'paragraph', 'heading', 'paragraph']);
  assert.deepEqual(doc.content!.filter(block => block.type === 'heading').map(block => block.attrs?.['level']), [1, 2, 3]);
  assert.equal(scriptRichText(doc), script);
  assert.equal(scriptRichText(scriptRichDocument(scriptRichText(doc))), script);
  assert.equal(doc.content![0]!.content![0]!.text, 'My script');
  assert.equal(scriptRichText(doc, 1, 3, false), 'My');
  assert.equal(scriptRichText(scriptRichDocument('## Chapter\nSpoken words.')), '## Chapter\n\nSpoken words.');
  const bullets = '• ## Supporting section\n\nKeep these words.';
  assert.equal(scriptRichText(scriptRichDocument(bullets, true)), bullets);
});

test('standalone Script autocue omits heading labels but preserves their child and following spoken content', () => {
  const document = JSON.stringify([
    { type: 'heading', props: { level: 1 }, content: [{ type: 'text', text: 'Not spoken title' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Opening words.' }] },
    { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Not spoken chapter' }],
      children: [{ type: 'paragraph', content: scriptInlineContent('[colour=teal]Nested words[/colour][pause]') }] },
    { type: 'heading', props: { level: 3 }, content: [{ type: 'text', text: 'Not spoken section' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Closing words.' }] },
  ]);
  const result = presentationScript(document, { script: true });
  assert.equal(result.text, 'Opening words.\n\nNested wordsPAUSE\n\nClosing words.');
  assert.ok(result.runs.some(run => run.text === 'Nested words' && run.styles.includes('colour-teal')));
  assert.ok(result.runs.some(run => run.styles.includes('cue-pause')));
  assert.equal(result.text.includes('Not spoken'), false);
  assert.equal(presentationScript(document).text.includes('Not spoken title'), true);
  assert.equal(presentationScript(JSON.stringify([
    { type: 'heading', content: [{ type: 'text', text: 'Only a title' }] },
  ]), { script: true }).text, '');
});

test('Script cards speak each body once without their rich titles or delivery directions', () => {
  const result = presentationScript(JSON.stringify([
    { id: 'opening', type: 'heading', props: { level: 2, scriptSection: true, scriptDirection: 'Never read this direction' },
      content: [{ type: 'text', text: 'Never read this title', styles: { bold: true } }],
      children: [{ id: 'body', type: 'paragraph', content: [
        { type: 'link', href: 'https://example.com/project', content: [{ type: 'text', text: 'Imagine', styles: { textColor: '#f1c21b' } }] },
        ...scriptInlineContent(' is ready.[pause]'),
      ] }] },
    { id: 'closing', type: 'heading', props: { level: 1, scriptSection: true, scriptDirection: 'Quietly' },
      content: [{ type: 'text', text: 'Closing title' }], children: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Thank you.' }] },
      ] },
  ]), { script: true });
  assert.equal(result.text, 'Imagine is ready.PAUSE\n\nThank you.');
  assert.ok(result.runs.some(run => run.text === 'Imagine' && run.styles.includes('colour-yellow')));
  assert.equal(result.text.includes('Never read'), false);
  assert.equal(result.text.includes('Quietly'), false);
});

test('podcast headings are editor-only even with sentence punctuation, colour spans and bullet continuations', () => {
  const script = '[colour=teal]# Title. Do not speak this.\n\nSpeak these words.[/colour][pause]\n\n## Chapter label\n\nContinue here.';
  const spoken = spokenScriptText(script);
  assert.equal(spoken.includes('Title'), false);
  assert.equal(spoken.includes('Chapter'), false);
  assert.match(spoken, /Speak these words/);
  assert.match(spoken, /Continue here/);
  const runs = annotatedPresentation(scriptReadingText(script));
  assert.ok(runs.runs.some(run => run.text.includes('Speak these words.') && run.styles.includes('colour-teal')));
  assert.ok(runs.runs.some(run => run.styles.includes('cue-pause')));
  const episode = episodeScriptText('# Episode title\n\nWelcome.', [{
    id: 'one', title: 'Saved card title', synopsis: '## Section. Editor only.\n\nActual story.',
    bullets: ['### Supporting label\n\nSpoken supporting point.', '## No spoken material'],
  }]);
  assert.equal(episode, 'Welcome.\n\nTopic 1\n\nActual story.\n\n• Spoken supporting point.');
});

test('standalone native script emphasis and atomic cues use the existing Elgato run protocol', () => {
  const content = scriptInlineContent('Begin [colour=teal]clearly[/colour][pause] then [colour=pink]finish[/colour][beat].');
  const result = presentationScript(JSON.stringify([{ type: 'paragraph', content }]));
  assert.equal(result.text, 'Begin clearlyPAUSE then finishBEAT.');
  assert.ok(result.runs.some(run => run.text === 'clearly' && run.styles.includes('colour-teal')));
  assert.ok(result.runs.some(run => run.text === 'finish' && run.styles.includes('colour-pink')));
  assert.deepEqual(result.runs.find(run => run.text === 'PAUSE')?.styles, ['cue-pause']);
  assert.deepEqual(result.runs.find(run => run.text === 'BEAT')?.styles, ['cue-beat']);
  assert.equal(result.text.includes('[colour'), false);
  assert.deepEqual(scriptAnnotationRuns('[colour=teal]One [colour=plain]plain[/colour] teal[/colour]')
    .map(run => [run.text, run.colour]), [['One ', 'teal'], ['plain', undefined], [' teal', 'teal']]);
});
test('desktop speech selects the available panel, restores earlier handlers and waits for a revealed panel', async () => {
  const bundled = await build({
    stdin: { contents: "export { useDesktopCommand, runDesktopCommand } from './desktopCommands'; export { cleanups } from 'react';",
      resolveDir: fileURLToPath(new URL('../src/services', import.meta.url)) },
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'command-hook-fixture', setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
        'export const cleanups = []; export const useRef = value => ({ current: value }); export const useEffect = effect => { cleanups.push(effect()); };' }));
    } }],
  });
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0]!.text, { module, exports: module.exports, setTimeout, Date });
  const { useDesktopCommand: register, runDesktopCommand: run, cleanups } = module.exports as {
    useDesktopCommand: (command: 'speak', handler: () => Promise<void>, available?: () => boolean) => void;
    runDesktopCommand: (command: 'speak') => Promise<void>;
    cleanups: (() => void)[];
  };
  const calls: string[] = [];
  let visible = false;
  try {
    register('speak', async () => { calls.push('current'); });
    register('speak', async () => { calls.push('preserved'); }, () => visible);
    await run('speak');
    assert.deepEqual(calls, ['current']);
    visible = true;
    await run('speak');
    assert.deepEqual(calls, ['current', 'preserved']);
    cleanups.pop()!();
    await run('speak');
    assert.equal(calls.at(-1), 'current');
    cleanups.pop()!();
    visible = false;
    register('speak', async () => { calls.push('revealed'); }, () => visible);
    const pending = run('speak');
    visible = true;
    await pending;
    assert.equal(calls.at(-1), 'revealed');
    register('speak', async () => { throw new Error('Microphone access failed'); });
    await assert.rejects(run('speak'), /Microphone access failed/);
  } finally { for (const cleanup of cleanups) cleanup(); }
});

test('voice resampling delegates rate conversion to Web Audio without dropping input samples', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'OfflineAudioContext');
  const samples = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  const copied = new Float32Array(samples.length);
  const rendered = new Float32Array([0.2, 0.5]);
  let started = false;
  class OfflineFixture {
    destination = {};
    constructor(channels: number, length: number, rate: number) {
      assert.deepEqual([channels, length, rate], [1, 2, 16000]);
    }
    createBuffer(channels: number, length: number, rate: number) {
      assert.deepEqual([channels, length, rate], [1, 6, 48000]);
      return { getChannelData: () => copied };
    }
    createBufferSource() { return { buffer: null, connect: () => undefined, start: () => { started = true; } }; }
    async startRendering() { assert.ok(started); return { getChannelData: () => rendered }; }
  }
  Object.defineProperty(globalThis, 'OfflineAudioContext', { configurable: true, value: OfflineFixture });
  try {
    assert.equal(await resampleVoiceAudio(samples, 48000, 16000), rendered);
    assert.deepEqual(copied, samples);
    assert.equal(await resampleVoiceAudio(samples, 16000, 16000), samples);
    await assert.rejects(resampleVoiceAudio(new Float32Array(), 48000, 16000), /No valid microphone audio/);
    const wav = new DataView(await encodeWav(rendered, 16000).arrayBuffer());
    assert.equal(wav.getUint32(24, true), 16000);
    assert.equal(wav.getUint32(40, true), rendered.length * 2);
  } finally {
    if (original) Object.defineProperty(globalThis, 'OfflineAudioContext', original);
    else Reflect.deleteProperty(globalThis, 'OfflineAudioContext');
  }
});

test('explicit voice review mode preserves the draft; on-screen mode remains send', async () => {
  let draft = 'Existing unsent work';
  let sent = '';
  await finishVoiceTranscript('  dictated text  ', true, text => { draft = appendVoiceTranscript(draft, text); }, async text => { sent = text; });
  assert.equal(draft, 'Existing unsent work\ndictated text');
  assert.equal(sent, '');
  await finishVoiceTranscript('on-screen', false, () => assert.fail('Should not change the draft'), async text => { sent = text; });
  assert.equal(sent, 'on-screen');
  await assert.rejects(finishVoiceTranscript(' ', true, () => assert.fail(), async () => assert.fail()), /No speech/);
});

test('voice submission sends through the composer exactly once, preserving the combined draft if blocked', async () => {
  let draft = 'Current draft';
  const sent: string[] = [];
  await submitVoiceTranscript(' new dictation ', draft, true, value => { draft = value; }, async value => { sent.push(value); });
  assert.deepEqual(sent, ['Current draft\nnew dictation']);
  await assert.rejects(submitVoiceTranscript('next dictation', draft, false, value => { draft = value; }, async () => { assert.fail('Must not send while busy'); }), /in your draft/);
  assert.equal(draft, 'Current draft\nnew dictation\nnext dictation');
  await assert.rejects(submitVoiceTranscript(' ', draft, true, () => assert.fail(), async () => assert.fail()), /No speech/);
  await assert.rejects(submitVoiceTranscript('retained speech', '', true, value => { draft = value; },
    async () => { throw new Error('Send failed'); }), /Send failed/);
  assert.equal(draft, 'retained speech');
});

test('on-screen dictation awaits the shared composer submission and preserves its errors', async () => {
  let draft = 'Existing context';
  const sent: string[] = [];
  const submit = (text: string): Promise<void> => submitVoiceTranscript(text, draft, true,
    value => { draft = value; }, async value => { sent.push(value); });
  await finishVoiceTranscript(' spoken instruction ', false, () => assert.fail('Not review mode'), submit);
  assert.deepEqual(sent, ['Existing context\nspoken instruction']);
  await assert.rejects(finishVoiceTranscript('more speech', false, () => assert.fail(),
    async () => { throw new Error('Composer submission failed'); }), /Composer submission failed/);
});

test('presentation scripts preserve nested order, inline links, lists and table text', () => {
  const blocks = [
    { type: 'heading', content: [{ text: 'Opening' }] },
    { type: 'paragraph', content: [{ text: 'A ' }, { type: 'link', content: [{ text: 'linked phrase' }] }],
      children: [{ type: 'bulletListItem', content: [{ text: 'Nested' }] }] },
    { type: 'numberedListItem', content: [{ text: 'First' }] },
    { type: 'numberedListItem', content: [{ text: 'Second' }] },
    { type: 'table', content: { type: 'tableContent', rows: [{ cells: [[{ text: 'A' }], { type: 'tableCell', content: [{ text: 'B' }] }] }] } },
    { type: 'image', props: { caption: 'Caption' } },
  ];
  const original = JSON.stringify(blocks);
  const result = presentationScript(original);
  assert.equal(result.text, 'Opening\nA linked phrase\n  - Nested\n1. First\n2. Second\nA | B\nCaption');
  assert.equal(result.warnings.length, 1);
  assert.equal(JSON.stringify(blocks), original);
});
test('presentation spacing follows authored empty blocks and hard breaks without extra blank lines', () => {
  const result = presentationScript(JSON.stringify([
    { type: 'paragraph', content: [{ text: 'First' }, { type: 'hardBreak' }, { text: 'Second' }] },
    { type: 'paragraph', content: [] },
    { type: 'paragraph', content: [{ text: 'Third\r\nFourth\n\nFifth' }] },
    { type: 'paragraph', content: [] },
  ]));
  assert.equal(result.text, 'First\nSecond\n\nThird\nFourth\n\nFifth\n');
  assert.equal(result.runs.map(run => run.text).join(''), result.text);
});
test('presentation includes linked names in paragraphs, nested links and tables with inherited emphasis', () => {
  const document = JSON.stringify([
    { type: 'heading', content: [{ type: 'entityMention', props: { entityType: 'project', entityId: 'hidden' } }] },
    { type: 'paragraph', content: [
      { text: 'Introducing ' },
      { type: 'link', styles: { bold: true, textColor: '#3ddbd9' }, content: [
        { type: 'entityMention', props: { entityType: 'project', entityId: 'imagine' } },
      ] },
      { text: ' and ' },
      { type: 'noteMention', props: { noteId: 'notes' } },
    ] },
    { type: 'table', content: { rows: [{ cells: [[
      { type: 'entityMention', props: { entityType: 'company', entityId: 'company' } },
    ]] }] } },
  ]);
  const seen: unknown[] = [];
  const result = presentationScript(document, { script: true, resolveMention: value => {
    seen.push(value);
    const item = value as { props: { entityId?: string; noteId?: string } };
    return item.props.entityId === 'imagine' ? 'Imagine' : item.props.noteId ? 'Supporting notes' : 'Company';
  } });
  assert.equal(result.text, 'Introducing Imagine and Supporting notes\nCompany');
  assert.deepEqual(result.runs.find(run => run.text === 'Imagine')?.styles, ['bold', 'colour-teal']);
  assert.equal(seen.length, 3);
  assert.throws(() => presentationScript(document, { script: true }), /resolve a linked name/);
});

test('presentation preparation awaits linked-name retrieval and propagates lookup failures', async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../src/features/autocue/preparePresentationScript.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'presentation-link-fixture', setup(builder) {
      builder.onResolve({ filter: /notes\/linkLabels$/ }, () => ({ path: 'labels', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        let title;
        export async function prepareEntityLinkExport(blocks) {
          await Promise.resolve();
          if (blocks[0].props?.fail) throw new Error('Link lookup failed');
          title = 'Imagine';
        }
        export function inlineText() { return title; }
      ` }));
    } }],
  });
  const module = { exports: {} as { preparePresentationScript: (json: string) => Promise<{ text: string }> } };
  runInNewContext(bundled.outputFiles[0]!.text, { module, exports: module.exports });
  const content = [{ type: 'paragraph', content: [
    { type: 'entityMention', props: { entityType: 'project', entityId: 'imagine' } },
  ] }];
  assert.equal((await module.exports.preparePresentationScript(JSON.stringify(content))).text, 'Imagine');
  await assert.rejects(module.exports.preparePresentationScript(JSON.stringify([
    { ...content[0], props: { fail: true } },
  ])), /Link lookup failed/);
});
test('presentation retains inline formatting, heading emphasis, list markers and literal text safely', () => {
  const result = presentationScript(JSON.stringify([
    { type: 'heading', content: [{ text: 'Heading' }] },
    { type: 'bulletListItem', content: [
      { text: '<img src=x onerror=alert(1)>', styles: { bold: true, italic: true, textColor: 'red' } },
      { text: ' more', styles: { underline: true, strike: true, code: true } },
    ], children: [{ type: 'checkListItem', props: { checked: true }, content: [{ text: 'Nested', styles: { italic: true } }] }] },
    { type: 'codeBlock', content: [{ text: 'literal()' }] },
  ]));
  assert.equal(result.text, 'Heading\n- <img src=x onerror=alert(1)> more\n  [x] Nested\nliteral()');
  assert.deepEqual(result.runs.find(run => run.text === 'Heading')?.styles, ['bold']);
  assert.deepEqual(result.runs.find(run => run.text.startsWith('<img'))?.styles, ['bold', 'italic']);
  assert.deepEqual(result.runs.find(run => run.text === ' more')?.styles, ['underline', 'strike', 'code']);
  assert.deepEqual(result.runs.find(run => run.text === 'Nested')?.styles, ['italic']);
  assert.deepEqual(result.runs.find(run => run.text === 'literal()')?.styles, ['code']);
  assert.equal(result.runs.map(run => run.text).join(''), result.text);
});
test('presentation extraction rejects malformed, excessively large and unsupported documents', () => {
  assert.throws(() => presentationScript('{'));
  assert.throws(() => presentationScript('{}'), /block document/);
  assert.throws(() => presentationScript('[null]'), /invalid block/);
  assert.throws(() => presentationScript(JSON.stringify([{ type: 'table', content: { rows: [{}] } }])), /unsupported table/);
  assert.throws(() => presentationScript(JSON.stringify([{ content: 'a'.repeat(500_001) }])), /500,000/);
  assert.equal(presentationScript('[]').text, '');
});
