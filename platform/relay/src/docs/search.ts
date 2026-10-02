import { mongoCollections } from '../mongoCollections.js';
import { embedText } from '../llm/embeddings.js';

interface DocChunkRow {
  url: string;
  title: string;
  heading: string | null;
  content: string;
  embedding: number[] | string;
}

export interface DocSearchResult {
  url: string;
  title: string;
  heading: string | null;
  content: string;
  score: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const MAX_RESULTS = 8;

/** Brute-force cosine scan over every stored chunk Ã¢â‚¬â€ fine at the scale a curated doc set sits
 * at (low thousands of rows at most); revisit with a real vector index only if that changes. */
export async function searchDocs(query: string, k: number): Promise<DocSearchResult[]> {
  const queryEmbedding = await embedText(query);
  const rows = await mongoCollections.doc_chunks.find({}, {
    projection: { url: 1, title: 1, heading: 1, content: 1, embedding: 1 },
  }).toArray();

  const scored = rows.map((row) => ({
    url: row.url,
    title: row.title,
    heading: row.heading,
    content: row.content,
    score: cosineSimilarity(queryEmbedding, typeof row.embedding === 'string' ? JSON.parse(row.embedding) as number[] : row.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(Math.max(k, 1), MAX_RESULTS));
}
