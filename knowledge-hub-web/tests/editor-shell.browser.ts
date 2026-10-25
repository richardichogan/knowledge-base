function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Document navigation did not finish.');
    await new Promise(resolve => { setTimeout(resolve, 25); });
  }
}

/** Run against an open local Design with two ordinary notes visible in its list. Does not edit or send content. */
export async function runEditorShellChecks(): Promise<string[]> {
  const host = document.querySelector('.notes-editor-host');
  const actions = document.querySelector('button[aria-label="Note actions"]');
  const panel = document.querySelector('[aria-label="Think side panel"]');
  const chat = document.querySelector('.think-athena-panel');
  const composer = document.querySelector<HTMLTextAreaElement>('.think-athena-panel textarea');
  const navigation = document.querySelector('[aria-label="Design documents"]');
  const designId = new URL(location.href).searchParams.get('design');
  const originalTab = [...navigation?.querySelectorAll('[role="tab"]') ?? []].findIndex(tab => tab.getAttribute('aria-selected') === 'true');
  check(host && actions && panel && chat && composer && navigation && designId && originalTab >= 0, 'Open a loaded Design with the Athena side panel first.');
  const draft = composer.value;
  const noteIds = [...document.querySelectorAll<HTMLElement>('.notes-list-item')]
    .filter(row => row.querySelector('.kh-content-type--note'))
    .map(row => row.dataset.ctxRefId).filter((id): id is string => !!id).slice(0, 2);
  check(noteIds.length === 2, 'Two ordinary notes must be visible to check note-to-note navigation.');
  const unchanged = (): void => {
    check(host === document.querySelector('.notes-editor-host'), 'Workspace shell remounted.');
    check(actions === document.querySelector('button[aria-label="Note actions"]'), 'Actions button remounted.');
    check(panel === document.querySelector('[aria-label="Think side panel"]'), 'Side panel remounted.');
    check(chat === document.querySelector('.think-athena-panel'), 'Athena chat remounted.');
    check(composer === document.querySelector('.think-athena-panel textarea'), 'Composer remounted.');
  };
  const rowFor = (id: string): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>('.notes-list-item')]
    .find(row => row.dataset.ctxRefId === id);
  try {
    for (const tab of [...navigation.querySelectorAll<HTMLButtonElement>('[role="tab"]')]) {
      tab.click();
      await waitFor(() => tab.getAttribute('aria-selected') === 'true' && !tab.disabled);
      unchanged();
      check(navigation === document.querySelector('[aria-label="Design documents"]'), 'Design navigation remounted.');
      check(composer.value === draft, 'Switching Design tabs changed the chat draft.');
    }
    for (const id of noteIds) {
      const row = rowFor(id);
      check(row, 'The target note is no longer listed.');
      row.click();
      await waitFor(() => !document.querySelector('[aria-label="Design documents"]')
        && document.querySelector<HTMLElement>('.notes-editor-scroll')?.dataset.ctxRefId === id
        && !actions.closest('fieldset')?.disabled);
      unchanged();
      actions.click();
      await waitFor(() => actions.getAttribute('aria-expanded') === 'true');
      actions.click();
    }
    return ['Design tabs retain navigation, Actions, side panel, chat and draft.', 'Note changes retain controls and Actions remains operable.'];
  } finally {
    rowFor(designId)?.click();
    await waitFor(() => new URL(location.href).searchParams.get('design') === designId
      && !!document.querySelector('[aria-label="Design documents"]'));
    const tab = document.querySelectorAll<HTMLButtonElement>('[aria-label="Design documents"] [role="tab"]')[originalTab];
    tab?.click();
    await waitFor(() => tab?.getAttribute('aria-selected') === 'true' && !tab.disabled);
  }
}
