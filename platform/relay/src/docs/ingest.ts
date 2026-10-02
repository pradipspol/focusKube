import { createHash } from 'node:crypto';
import { mongoCollections } from '../mongoCollections.js';
import { embedTexts } from '../llm/embeddings.js';
import { logDebug, logError, logInfo } from '../logger.js';
import { chunkMarkdown } from './chunker.js';

export interface DocSource {
  /** Canonical kubernetes.io URL Ã¢â‚¬â€ what the assistant cites back to the user. */
  url: string;
  title: string;
  /** Path (no leading slash, no .md) inside kubernetes/website's content/en/docs/ tree, e.g.
   * "tasks/debug/debug-application/debug-pods". Fetched as plain raw Markdown from GitHub Ã¢â‚¬â€
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
 * ({{< note >}}...{{< /note >}}, {{% capture %}}, etc.) down to their inner text Ã¢â‚¬â€ good enough
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

/** Idempotent Ã¢â‚¬â€ safe to re-run on a schedule or after adding new sources. Only calls the
 * (paid) embeddings API for chunks whose content actually changed since the last run. */
export async function ingestSources(sources: DocSource[]): Promise<IngestResult[]> {
  const startedAt = Date.now();
  logInfo('Documentation ingestion started', { sourceCount: sources.length });
  const results: IngestResult[] = [];
  const collection = mongoCollections.doc_chunks;

  for (const source of sources) {
    const sourceStartedAt = Date.now();
    try {
      logDebug('Fetching documentation source', { source: source.repoPath });
      const raw = await fetchRawMarkdown(source.repoPath);
      const cleaned = cleanMarkdown(raw);
      const chunks = chunkMarkdown(cleaned);

      const chunkRows = chunks.map((chunk, index) => ({
        id: sha256(`${source.url}#${index}`),
        index,
        content: chunk.content,
        contentHash: sha256(chunk.content),
      }));
      const existingRows = await collection.find(
        { id: { $in: chunkRows.map((chunk) => chunk.id) } },
        { projection: { id: 1, content_hash: 1 } },
      ).toArray() as Array<{ id: string; content_hash: string }>;
      const existingHashes = new Map(existingRows.map((row) => [row.id, row.content_hash]));
      const toEmbed: Array<{ index: number; id: string; content: string; contentHash: string }> = [];
      let unchanged = 0;
      chunkRows.forEach((chunk) => {
        if (existingHashes.get(chunk.id) === chunk.contentHash) {
          unchanged += 1;
        } else {
          toEmbed.push(chunk);
        }
      });

      const embeddings = toEmbed.length > 0 ? await embedTexts(toEmbed.map((c) => c.content)) : [];
      const now = new Date().toISOString();
      if (toEmbed.length) {
        await collection.bulkWrite(toEmbed.map((item, index) => {
          const chunk = chunks[item.index];
          return {
            updateOne: {
              filter: { id: item.id },
              update: { $set: {
                source: 'kubernetes.io', url: source.url, title: source.title,
                heading: chunk.heading, content: chunk.content, content_hash: item.contentHash,
                embedding: embeddings[index], updated_at: now,
              } },
              upsert: true,
            },
          };
        }), { ordered: false });
      }

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
