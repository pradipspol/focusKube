export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogPayload = {
  ts: string;
  level: LogLevel;
  msg: string;
} & Record<string, unknown>;

export interface LoggerBackend {
  write(payload: LogPayload): void;
}