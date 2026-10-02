// Run with: npm run ingest:k8s-docs (see package.json)
//
// Populates/refreshes the k8s-docs knowledge base (see src/docs/ingest.ts) from the curated
// source list in src/docs/k8sSources.ts. Needs outbound HTTPS access to
// raw.githubusercontent.com (to fetch doc source) and to your Azure OpenAI endpoint (to
// embed changed chunks) — run it from wherever the relay itself normally reaches those, not
// necessarily this same machine if your network restricts general internet access.
import { ingestSources } from '../src/docs/ingest.js';
import { K8S_DOC_SOURCES } from '../src/docs/k8sSources.js';
import { embeddingsConfigured } from '../src/llm/embeddings.js';
import { closeDb, connectDb } from '../src/db.js';

async function main() {
  if (!embeddingsConfigured()) {
    console.error(
      'AZURE_OPENAI_API_KEY/AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT are not all set — ' +
        'provision an embeddings deployment (e.g. text-embedding-3-small) in your Azure OpenAI resource and set them first.',
    );
    process.exit(1);
  }

  await connectDb();
  console.log(`Ingesting ${K8S_DOC_SOURCES.length} source page(s)...`);
  const results = await ingestSources(K8S_DOC_SOURCES);

  let totalEmbedded = 0;
  let totalFailed = 0;
  for (const r of results) {
    if (r.error) {
      totalFailed += 1;
      console.error(`✗ ${r.source}: ${r.error}`);
    } else {
      totalEmbedded += r.chunksEmbedded;
      console.log(
        `✓ ${r.source}: ${r.chunksTotal} chunk(s) (${r.chunksEmbedded} embedded, ${r.chunksUnchanged} unchanged)`,
      );
    }
  }

  console.log(`\nDone. ${totalEmbedded} chunk(s) newly embedded, ${totalFailed} source(s) failed.`);
  await closeDb();
  if (totalFailed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Ingestion failed:', err instanceof Error ? err.message : err);
  void closeDb().finally(() => { process.exitCode = 1; });
});
