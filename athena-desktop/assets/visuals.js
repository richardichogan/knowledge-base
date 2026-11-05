/* Trusted DOM renderer; scene data never contributes executable markup. */
let nextRenderer = 0;
export function createVisualRenderer(stage, status, footerHost) {
  const document = stage.ownerDocument;
  const rendererId = `visual-${++nextRenderer}`;
  const footer = document.createElement('footer');
  footer.className = 'presentation-footer';
  const presentationTitle = document.createElement('span');
  const pageNumber = document.createElement('span');
  pageNumber.className = 'presentation-footer__page';
  footer.append(presentationTitle, pageNumber);
  footerHost.append(footer);
  let signature = '';
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const iconPaths = {
    person: 'M16 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM5 29v-4a11 8 0 0 1 22 0v4',
    worker: 'M16 3v4M12 3h8M5 8h22v18H5ZM10 14h2v3h-2ZM20 14h2v3h-2ZM11 22h10M1 14v7M31 14v7',
    document: 'M7 2h12l7 7v21H7ZM19 2v8h7M11 16h11M11 21h11M11 26h8',
    check: 'M27 8 12 24 5 17',
    system: 'M9 9h14v14H9ZM13 1v8M19 1v8M13 23v8M19 23v8M1 13h8M1 19h8M23 13h8M23 19h8',
    arrow: 'M3 16h25M19 7l9 9-9 9',
    boundary: 'M16 2 29 8v9c0 6-7 11-13 14C10 28 3 23 3 17V8ZM10 16l4 4 9-10',
  };
  function svgElement(tag, attributes = {}) {
    const element = document.createElementNS(svgNamespace, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }
  function setReveals(revealed) {
    stage.querySelectorAll('[data-reveal]').forEach(element => {
      const visible = Number(element.getAttribute('data-reveal')) <= revealed;
      element.classList.toggle('composition-visible', visible);
      element.setAttribute('aria-hidden', String(!visible));
    });
  }
  function composed(scene, revealed) {
    const composition = scene.composition;
    const svg = svgElement('svg', { viewBox: '0 0 1600 900', role: 'group', 'aria-label': scene.title });
    svg.classList.add('composition');
    const defs = svgElement('defs');
    for (const tone of ['teal', 'blue', 'purple', 'neutral', 'warning', 'success']) {
      const marker = svgElement('marker', { id: `${rendererId}-${tone}`, viewBox: '0 0 12 12', refX: 10, refY: 6,
        markerWidth: 10, markerHeight: 10, orient: 'auto-start-reverse' });
      marker.classList.add('composition-arrow', `visual-tone--${tone}`);
      marker.append(svgElement('path', { d: 'M1 1L11 6L1 11Z' }));
      defs.append(marker);
    }
    svg.append(defs);
    const heading = svgElement('foreignObject', { x: 80, y: 56, width: 1440, height: 174 });
    const header = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    header.className = 'composition-heading';
    const title = document.createElement('h1');
    title.textContent = scene.title;
    header.append(title);
    if (scene.subtitle) {
      const subtitle = document.createElement('p');
      subtitle.className = 'subtitle';
      subtitle.textContent = scene.subtitle;
      header.append(subtitle);
    }
    heading.append(header);
    svg.append(heading);
    for (const link of composition.links) {
      const from = composition.nodes.find(node => node.id === link.from);
      const to = composition.nodes.find(node => node.id === link.to);
      if (!from || !to) continue;
      const dx = to.x + to.width / 2 - from.x - from.width / 2;
      const dy = to.y + to.height / 2 - from.y - from.height / 2;
      const horizontal = Math.abs(dx) / (from.width + to.width) >= Math.abs(dy) / (from.height + to.height);
      const start = horizontal
        ? [from.x + (dx >= 0 ? from.width : 0), from.y + from.height / 2]
        : [from.x + from.width / 2, from.y + (dy >= 0 ? from.height : 0)];
      const end = horizontal
        ? [to.x + (dx >= 0 ? 0 : to.width), to.y + to.height / 2]
        : [to.x + to.width / 2, to.y + (dy >= 0 ? 0 : to.height)];
      const mx = (start[0] + end[0]) / 2, my = (start[1] + end[1]) / 2;
      const path = horizontal
        ? `M${start}C${mx},${start[1]} ${mx},${end[1]} ${end}`
        : `M${start}C${start[0]},${my} ${end[0]},${my} ${end}`;
      const group = svgElement('g', { 'data-reveal': link.reveal });
      group.classList.add('composition-reveal', `visual-tone--${link.tone}`, `composition-link--${link.style}`);
      group.append(svgElement('path', { d: path, class: 'composition-link', pathLength: 1,
        'marker-end': `url(#${rendererId}-${link.tone})` }));
      if (link.label) {
        const label = svgElement('text', { x: mx, y: my - 18, 'text-anchor': 'middle', class: 'composition-link-label' });
        label.textContent = link.label;
        group.append(label);
      }
      svg.append(group);
    }
    for (const node of composition.nodes) {
      const holder = svgElement('foreignObject', { x: node.x, y: node.y, width: node.width, height: node.height,
        'data-reveal': node.reveal });
      holder.classList.add('composition-reveal', 'composition-subject');
      const element = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      element.className = `visual-node visual-node--${node.kind} visual-tone--${node.tone}`;
      if (node.kind === 'image') {
        if (/^https:\/\//i.test(scene.imageUrl)) {
          const image = document.createElement('img');
          image.src = scene.imageUrl;
          image.alt = scene.imageAlt;
          image.referrerPolicy = 'no-referrer';
          image.onerror = () => { status.hidden = false; status.textContent = 'The scene illustration could not be loaded. Reload to retry.'; };
          element.append(image);
        }
      } else {
        if (node.icon && iconPaths[node.icon]) {
          const icon = svgElement('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true', class: 'visual-node__icon' });
          icon.append(svgElement('path', { d: iconPaths[node.icon] }));
          element.append(icon);
        }
        if (node.label) {
          const label = document.createElement('h2');
          label.textContent = node.label;
          element.append(label);
        }
        if (node.detail) {
          const detail = document.createElement('p');
          detail.textContent = node.detail;
          element.append(detail);
        }
      }
      holder.append(element);
      svg.append(holder);
    }
    stage.append(svg);
    setReveals(revealed);
  }
  function illustration(artwork) {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 1600 900');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', artwork.description);
    svg.classList.add('artwork');
    artwork.shapes.forEach(shape => {
      if (!['circle', 'rect', 'path'].includes(shape.kind) || !['teal', 'blue', 'purple', 'neutral'].includes(shape.tone)) return;
      const element = document.createElementNS(namespace, shape.kind);
      element.classList.add(`artwork__${shape.tone}`);
      element.setAttribute('opacity', String(shape.opacity));
      if (shape.kind === 'circle') {
        element.setAttribute('cx', String(shape.x));
        element.setAttribute('cy', String(shape.y));
        element.setAttribute('r', String(shape.radius));
      } else if (shape.kind === 'rect') {
        for (const key of ['x', 'y', 'width', 'height']) element.setAttribute(key, String(shape[key]));
        element.setAttribute('rx', String(shape.radius));
      } else {
        if (!/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/.test(shape.d)) return;
        element.setAttribute('d', shape.d);
      }
      svg.append(element);
    });
    return svg;
  }
  function render(packet) {
    if (!packet || typeof packet !== 'object') return;
    status.textContent = packet.error || '';
    status.hidden = !packet.error;
    const scene = packet.scene;
    presentationTitle.textContent = packet.presentationTitle || '';
    pageNumber.textContent = packet.total > 0 && packet.page > 0
      ? `${String(packet.page).padStart(2, '0')} / ${String(packet.total).padStart(2, '0')}` : '';
    footer.hidden = !scene;
    const key = JSON.stringify(scene);
    if (signature === key) {
      if (scene?.composition) { setReveals(packet.revealed); return; }
      stage.querySelectorAll('.item').forEach((item, index) => {
        const visible = index < packet.revealed;
        item.classList.toggle('item--visible', visible);
        item.setAttribute('aria-hidden', String(!visible));
      });
      return;
    }
    signature = key;
    stage.replaceChildren();
    if (!scene) return;
    if (scene.composition) {
      stage.className = 'scene scene--composed';
      composed(scene, packet.revealed);
      return;
    }
    stage.className = `scene scene--${scene.template} scene--${scene.layout || (scene.template === 'title' ? 'hero' : 'diagram')}${scene.artwork ? ' scene--illustrated' : ''}`;
    if (scene.artwork) stage.append(illustration(scene.artwork));
    if (scene.template === 'image' && /^https:\/\//i.test(scene.imageUrl)) {
      const image = document.createElement('img');
      image.className = 'scene-image';
      image.src = scene.imageUrl;
      image.alt = scene.imageAlt;
      image.referrerPolicy = 'no-referrer';
      image.onerror = () => { status.hidden = false; status.textContent = 'The scene image could not be loaded.'; };
      stage.append(image);
    }
    const content = document.createElement('div');
    content.className = 'scene-content';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'scene-eyebrow';
    eyebrow.textContent = scene.template === 'title' ? 'Perspective' : {
      concept: 'Connected ideas', steps: 'How it works', comparison: 'The distinction', statistic: 'In focus', image: 'A closer look',
    }[scene.template] || '';
    content.append(eyebrow);
    const title = document.createElement('h1');
    title.textContent = scene.title;
    content.append(title);
    if (scene.subtitle) {
      const subtitle = document.createElement('p');
      subtitle.className = 'subtitle';
      subtitle.textContent = scene.subtitle;
      content.append(subtitle);
    }
    const items = document.createElement('div');
    items.className = 'items';
    scene.items.forEach((item, index) => {
      const card = document.createElement('div');
      const visible = index < packet.revealed;
      card.className = `item${visible ? ' item--visible' : ''}`;
      card.setAttribute('aria-hidden', String(!visible));
      const label = document.createElement('h2');
      label.textContent = item.label;
      const marker = document.createElement('span');
      marker.className = 'item__marker';
      marker.textContent = String(index + 1).padStart(2, '0');
      marker.setAttribute('aria-hidden', 'true');
      const detail = document.createElement('p');
      detail.textContent = item.detail;
      card.append(marker, label, detail);
      items.append(card);
    });
    if (scene.items.length) content.append(items);
    stage.append(content);
  }
  return render;
}

if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-athena-visual-output')) {
    const status = document.getElementById('status');
    const render = createVisualRenderer(document.getElementById('stage'), status, document.body);
    const events = new EventSource('./events');
    events.onmessage = event => {
      try { render(JSON.parse(event.data)); }
      catch { status.hidden = false; status.textContent = 'The presentation update could not be read.'; }
    };
    events.onerror = () => {
      status.hidden = false;
      status.textContent = 'Presentation disconnected. The last visual is held; return to Athena to reconnect.';
    };
}
