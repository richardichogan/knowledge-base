import { presentationScript } from './presentationScript';

export function autocueScriptText(content: string): string {
  try { return presentationScript(content).text; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return content.replace(/\r\n?/g, '\n')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/!\[.*?\]\(.+?\)/g, '')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .trim();
  }
}
