import { inlineText, prepareEntityLinkExport } from '../../notes/linkLabels';
import { presentationScript } from './presentationScript';

export async function preparePresentationScript(contentJson: string, options: { script?: boolean } = {}): Promise<ReturnType<typeof presentationScript>> {
  await prepareEntityLinkExport(JSON.parse(contentJson));
  return presentationScript(contentJson, { ...options, resolveMention: inlineText });
}
