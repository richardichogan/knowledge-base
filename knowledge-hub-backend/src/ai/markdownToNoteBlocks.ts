import { Lexer, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';

type Styles = Partial<Record<'bold' | 'italic' | 'code' | 'strike', boolean>>;
export interface NoteText { type: 'text'; text: string; styles: Styles }
export type NoteInline = NoteText | { type: 'link'; href: string; content: NoteText[] };
export interface NoteInlineBlock {
  type: 'heading' | 'paragraph' | 'codeBlock' | 'bulletListItem' | 'numberedListItem' | 'checkListItem' | 'quote';
  props?: { level?: number; language?: string; checked?: boolean; start?: number };
  content: NoteInline[];
  children?: NoteMarkdownBlock[];
}
export type NoteMarkdownBlock = NoteInlineBlock | {
  type: 'table';
  content: {
    type: 'tableContent'; headerRows: number;
    rows: { cells: { type: 'tableCell'; props: { textAlignment: 'left' | 'center' | 'right' }; content: NoteInline[] }[] }[];
  };
} | { type: 'divider'; content?: undefined };

function plain(text: string, styles: Styles = {}): NoteText {
  return { type: 'text', text, styles };
}

function safeLink(href: string): boolean {
  return /^(?:https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href);
}

function inline(tokens: Token[], styles: Styles = {}): NoteInline[] {
  return tokens.flatMap((token): NoteInline[] => {
    switch (token.type) {
      case 'strong': return inline((token as Tokens.Strong).tokens, { ...styles, bold: true });
      case 'em': return inline((token as Tokens.Em).tokens, { ...styles, italic: true });
      case 'del': return inline((token as Tokens.Del).tokens, { ...styles, strike: true });
      case 'codespan': return [plain((token as Tokens.Codespan).text, { ...styles, code: true })];
      case 'br': return [plain('\n', styles)];
      case 'link': {
        const link = token as Tokens.Link;
        const content = inline(link.tokens, styles).flatMap(part => part.type === 'text' ? [part] : part.content);
        const href = decodeHTML(link.href);
        return safeLink(href) ? [{ type: 'link', href, content }] : content;
      }
      case 'image': {
        const image = token as Tokens.Image;
        // Keep a reference without fetching externally hosted images when the note opens.
        const href = decodeHTML(image.href);
        const content = [plain(decodeHTML(image.text) || href, styles)];
        return safeLink(href) ? [{ type: 'link', href, content }] : content;
      }
      case 'text': {
        const text = token as Tokens.Text;
        return text.tokens ? inline(text.tokens, styles) : [plain(decodeHTML(text.text), styles)];
      }
      case 'escape': return [plain((token as Tokens.Escape).text, styles)];
      default: return [plain(token.raw, styles)];
    }
  });
}

function blocks(tokens: Token[]): NoteMarkdownBlock[] {
  return tokens.flatMap((token): NoteMarkdownBlock[] => {
    switch (token.type) {
      case 'space': case 'def': return [];
      case 'heading': {
        const heading = token as Tokens.Heading;
        return [{ type: 'heading', props: { level: heading.depth }, content: inline(heading.tokens) }];
      }
      case 'paragraph': case 'text': {
        const paragraph = token as Tokens.Paragraph | Tokens.Text;
        return [{ type: 'paragraph', content: paragraph.tokens ? inline(paragraph.tokens) : [plain(paragraph.text)] }];
      }
      case 'code': {
        const code = token as Tokens.Code;
        return [{ type: 'codeBlock', props: { language: code.lang?.split(/\s+/)[0] || 'text' }, content: [plain(code.text)] }];
      }
      case 'list': {
        const list = token as Tokens.List;
        return list.items.map((item, index): NoteInlineBlock => {
          const contents = blocks(item.tokens);
          const first = contents[0];
          const firstIsParagraph = first?.type === 'paragraph';
          const children = firstIsParagraph ? contents.slice(1) : contents;
          return {
            type: item.task ? 'checkListItem' : list.ordered ? 'numberedListItem' : 'bulletListItem',
            ...(item.task ? { props: { checked: item.checked === true } }
              : list.ordered && index === 0 && typeof list.start === 'number' ? { props: { start: list.start } } : {}),
            content: firstIsParagraph ? first.content : [],
            ...(children.length > 0 ? { children } : {}),
          };
        });
      }
      case 'blockquote': {
        const quoted = blocks((token as Tokens.Blockquote).tokens);
        const first = quoted[0];
        if (first && first.type !== 'table' && first.type !== 'divider') {
          return [{ type: 'quote', content: first.content,
            ...(quoted.length > 1 || first.children ? { children: [...(first.children ?? []), ...quoted.slice(1)] } : {}) }];
        }
        return [{ type: 'quote', content: [], children: quoted }];
      }
      case 'table': {
        const table = token as Tokens.Table;
        return [{ type: 'table', content: { type: 'tableContent', headerRows: 1,
          rows: [table.header, ...table.rows].map(row => ({
            cells: row.map(cell => ({ type: 'tableCell', props: { textAlignment: cell.align ?? 'left' }, content: inline(cell.tokens) })),
          })),
        } }];
      }
      case 'hr': return [{ type: 'divider' }];
      // HTML is source text, never executable markup.
      default: return [{ type: 'paragraph', content: [plain(token.raw)] }];
    }
  });
}

/** Shared by chat drafts, chat exports and saved Outputs; never split Markdown by blank lines. */
export function textToBlocks(markdown: string): NoteMarkdownBlock[] {
  return blocks(Lexer.lex(markdown, { gfm: true }));
}
