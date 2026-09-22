export interface DocChunk {
  /** Nearest enclosing heading (e.g. "My pod stays pending") — null for content before any
   * heading (a page's lead paragraph). Shown to the user as the citation's section label. */
  heading: string | null;
  content: string;
}

// Keeps each chunk small enough to be a focused, single-topic embedding target and cheap to
// include in a tool result — a whole kubernetes.io page is often 5-10x this and mixes several
// unrelated troubleshooting scenarios in one embedding otherwise.
const MAX_CHUNK_CHARS = 1500;
const MIN_CHUNK_CHARS = 40;

/** Splits Markdown into heading-bounded chunks, then further splits any section that's still
 * too big at paragraph boundaries. Deliberately simple (no token-aware splitting, no overlap
 * window) — good enough for reference-doc prose, where a paragraph rarely straddles two
 * unrelated ideas. */
export function chunkMarkdown(markdown: string): DocChunk[] {
  const lines = markdown.split('\n');
  const sections: Array<{ heading: string | null; body: string[] }> = [{ heading: null, body: [] }];

  for (const line of lines) {
    const headingMatch = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      sections.push({ heading: headingMatch[2].trim(), body: [] });
      continue;
    }
    sections[sections.length - 1].body.push(line);
  }

  const chunks: DocChunk[] = [];
  for (const section of sections) {
    const text = section.body.join('\n').trim();
    if (!text) continue;

    if (text.length <= MAX_CHUNK_CHARS) {
      if (text.length >= MIN_CHUNK_CHARS) chunks.push({ heading: section.heading, content: text });
      continue;
    }

    // Oversized section — split at paragraph breaks, packing consecutive paragraphs together
    // up to the size cap rather than one paragraph per chunk (keeps related sentences together).
    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let buffer = '';
    for (const paragraph of paragraphs) {
      const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (candidate.length > MAX_CHUNK_CHARS && buffer) {
        chunks.push({ heading: section.heading, content: buffer });
        buffer = paragraph;
      } else {
        buffer = candidate;
      }
    }
    if (buffer.length >= MIN_CHUNK_CHARS) chunks.push({ heading: section.heading, content: buffer });
  }

  return chunks;
}
