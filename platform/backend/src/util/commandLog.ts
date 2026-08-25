import type { LogLevel } from './logger.types.js';
import { logError, logInfo, logWarn } from './logger.js';

export type CommandStatus = 'success' | 'failed' | 'timedout' | 'stuck';

export function commandLine(cmd: string, args: string[]): string {
  return `${cmd} ${args.join(' ')}`.trim();
}

export function commandReason(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Error) return value.message.trim();
  return String(value).trim();
}

export function commandOutcomeMessage(status: CommandStatus, cmd: string, args: string[], detail?: string): string {
  const line = commandLine(cmd, args);
  const suffix = detail ? `: ${detail}` : '';
  return `${status}: ${line}${suffix}`;
}

export function logCommandOutcome(
  level: LogLevel,
  event: string,
  status: CommandStatus,
  cmd: string,
  args: string[],
  fields: Record<string, unknown> = {},
  detail?: string,
): void {
  const payload = {
    event,
    status,
    ...fields,
  };
  const message = commandOutcomeMessage(status, cmd, args, detail);
  if (level === 'error') {
    logError(message, payload);
    return;
  }
  if (level === 'warn') {
    logWarn(message, payload);
    return;
  }
  logInfo(message, payload);
}