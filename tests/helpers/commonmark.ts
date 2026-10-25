/**
 * @fileoverview Test helper: read Markdown back through a real CommonMark parser
 * (`markdown-it`, with the GFM table and strikethrough rules), so a test asserts
 * the text a `content[]` client renders rather than the bytes the framework wrote.
 * Tool error text is Markdown-escaped on the way out, so an assertion on the raw
 * bytes would pin the escaping instead of the message.
 * @module tests/helpers/commonmark
 */

import MarkdownIt, { type Token } from 'markdown-it';

const parser = new MarkdownIt('default', { html: true });

function readInline(children: Token[]): string {
  let out = '';
  for (const token of children) {
    if (token.type === 'text' || token.type === 'text_special') out += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') out += '\n';
    else if (token.nesting === 1) out += `⟨${token.tag}⟩`;
    else if (token.nesting === -1) out += `⟨/${token.tag}⟩`;
    else out += `⟨${token.type}:${token.content}⟩`;
  }
  return out;
}

/**
 * The text of `markdown` as a CommonMark client reads it: paragraphs joined by a
 * blank line, escapes resolved, and any live syntax (emphasis, code spans, links)
 * marked `⟨…⟩` so it cannot pass for plain text.
 */
export function readCommonMark(markdown: string): string {
  const parts: string[] = [];
  for (const token of parser.parse(markdown, {})) {
    if (token.type === 'inline') parts.push(readInline(token.children ?? []));
    else if (token.type !== 'paragraph_open' && token.type !== 'paragraph_close') {
      parts.push(`⟨${token.type}⟩`);
    }
  }
  return parts.join('\n\n');
}
