export type ExportFormat = 'csv' | 'json' | 'txt';

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(headers: string[], rows: string[][]): string {
  return [headers.map(csvEscape).join(','), ...rows.map((cells) => cells.map(csvEscape).join(','))].join('\n');
}

export function toTxt(headers: string[], rows: string[][]): string {
  return [headers.join('\t'), ...rows.map((cells) => cells.join('\t'))].join('\n');
}

/** Trigger a browser download of `content`. */
export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
