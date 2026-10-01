import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { embedTexts } from '../llm/embeddings.js';
import { logDebug, logError, logInfo } from '../logger.js';
import { chunkMarkdown } from './chunker.js';

export interface DocSource {
  /** Canonical kubernetes.io URL — what the assistant cites back to the user. */
  url: string;
  title: string;
  /** Path (no leading slash, no .md) inside kubernetes/website's content/en/docs/ tree, e.g.
   * "tasks/debug/debug-application/debug-pods". Fetched as plain raw Markdown from GitHub —
   * this is the actual source kubernetes.io itself is built from (CC BY 4.0), not a scrape of
   * the rendered site. */
  repoPath: string;
}

const RAW_BASE = 'https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/';
const FETCH_TIMEOUT_MS = 15_000;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function fetchRawMarkdown(repoPath: string): Promise<string> {
  const candidates = [`${repoPath}.md`, `${repoPath}/_index.md`];
  let lastError: unknown;
  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${RAW_BASE}${candidate}`, { signal: controller.signal });
      if (res.ok) return await res.text();
      lastError = new Error(`HTTP ${res.status} fetching ${candidate}`);
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Strips YAML front-matter and the Hugo shortcodes kubernetes/website's source uses
 * ({{< note >}}...{{< /note >}}, {{% capture %}}, etc.) down to their inner text — good enough
 * for a knowledge base (the reader never sees Hugo template syntax), not a full Hugo renderer. */
function cleanMarkdown(raw: string): string {
  let text = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  text = text.replace(/{{[%<]\s*\/?[a-zA-Z0-9_-]+[^%>]*?[%>]}}/g, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export interface IngestResult {
  source: string;
  chunksTotal: number;
  chunksEmbedded: number;
  chunksUnchanged: number;
  error?: string;
}

/** Idempotent — safe to re-run on a schedule or after adding new sources. Only calls the
 * (paid) embeddings API for chunks whose content actually changed since the last run. */
export async function ingestSources(sources: DocSource[]): Promise<IngestResult[]> {
  const startedAt = Date.now();
  logInfo('Documentation ingestion started', { sourceCount: sources.length });
  const results: IngestResult[] = [];
  const existingHash = db.prepare('SELECT content_hash FROM doc_chunks WHERE id = ?');
  const upsert = db.prepare(`
    INSERT INTO doc_chunks (id, source, url, title, heading, content, content_hash, embedding, updated_at)
    VALUES (@id, @source, @url, @title, @heading, @content, @contentHash, @embedding, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      heading = excluded.heading,
      content = excluded.content,
      content_hash = excluded.content_hash,
      embedding = excluded.embedding,
      updated_at = excluded.updated_at
  `);

  for (const source of sources) {
    const sourceStartedAt = Date.now();
    try {
      logDebug('Fetching documentation source', { source: source.repoPath });
      const raw = await fetchRawMarkdown(source.repoPath);
      const cleaned = cleanMarkdown(raw);
      const chunks = chunkMarkdown(cleaned);

      const toEmbed: Array<{ index: number; content: string; contentHash: string }> = [];
      let unchanged = 0;
      chunks.forEach((chunk, index) => {
        const id = sha256(`${source.url}#${index}`);
        const contentHash = sha256(chunk.content);
        const existing = existingHash.get(id) as { content_hash: string } | undefined;
        if (existing?.content_hash === contentHash) {
          unchanged += 1;
        } else {
          toEmbed.push({ index, content: chunk.content, contentHash });
        }
      });

      const embeddings = toEmbed.length > 0 ? await embedTexts(toEmbed.map((c) => c.content)) : [];
      const now = new Date().toISOString();
      const txn = db.transaction(() => {
        toEmbed.forEach((item, i) => {
          const chunk = chunks[item.index];
          upsert.run({
            id: sha256(`${source.url}#${item.index}`),
            source: 'kubernetes.io',
            url: source.url,
            title: source.title,
            heading: chunk.heading,
            content: chunk.content,
            contentHash: item.contentHash,
            embedding: JSON.stringify(embeddings[i]),
            updatedAt: now,
          });
        });
      });
      txn();

      results.push({
        source: source.url,
        chunksTotal: chunks.length,
        chunksEmbedded: toEmbed.length,
        chunksUnchanged: unchanged,
      });
      logInfo('Documentation source ingested', {
        source: source.repoPath,
        chunksTotal: chunks.length,
        chunksEmbedded: toEmbed.length,
        chunksUnchanged: unchanged,
        durationMs: Date.now() - sourceStartedAt,
      });
    } catch (err) {
      logError('Documentation source ingestion failed', err, {
        source: source.repoPath,
        durationMs: Date.now() - sourceStartedAt,
      });
      results.push({
        source: source.url,
        chunksTotal: 0,
        chunksEmbedded: 0,
        chunksUnchanged: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const failedSourceCount = results.filter((result) => result.error).length;
  logInfo('Documentation ingestion completed', {
    sourceCount: sources.length,
    failedSourceCount,
    durationMs: Date.now() - startedAt,
  });
  return results;
}
