const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const configured = process.env.BUZZ_GATEWAY_LOG_LEVEL as Level | undefined;
const threshold = configured && Object.hasOwn(levels, configured) ? levels[configured] : levels.info;

export function log(level: Level, event: string, fields: Record<string, string | number | boolean> = {}): void {
  if (levels[level] < threshold) return;
  const line = JSON.stringify({ ...fields, event, level, timestamp: new Date().toISOString() });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
