const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/;

export interface LogSource {
  podName: string;
  containerName: string;
  color?: string;
}

export interface MergedLogLine {
  sourceId: string;
  ts: Date;
  raw: string;
  podName: string;
  containerName: string;
}

export function parseLogLine(raw: string, source: LogSource, includeTimestamp: boolean): MergedLogLine | null {
  let timestamp: Date;
  let content = raw;

  if (includeTimestamp) {
    const match = raw.match(RFC3339_PATTERN);
    if (match) {
      try {
        timestamp = new Date(match[0]);
        content = raw.slice(match[0].length).trim();
      } catch {
        timestamp = new Date();
      }
    } else {
      timestamp = new Date();
    }
  } else {
    timestamp = new Date();
  }

  return {
    sourceId: `${source.podName}/${source.containerName}`,
    ts: timestamp,
    raw: content,
    podName: source.podName,
    containerName: source.containerName,
  };
}

export function mergeLogStreams(
  existingLines: MergedLogLine[],
  newLines: Array<{ raw: string; source: LogSource; includeTimestamp: boolean }>,
): MergedLogLine[] {
  const all = [...existingLines];

  for (const line of newLines) {
    const parsed = parseLogLine(line.raw, line.source, line.includeTimestamp);
    if (parsed) {
      all.push(parsed);
    }
  }

  all.sort((a, b) => {
    const timeDiff = a.ts.getTime() - b.ts.getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.sourceId.localeCompare(b.sourceId);
  });

  return all;
}

export function boundedMerge(existingLines: MergedLogLine[], maxLines = 5000): MergedLogLine[] {
  if (existingLines.length <= maxLines) return existingLines;
  return existingLines.slice(existingLines.length - maxLines);
}
