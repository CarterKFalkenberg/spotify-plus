// Shared by Spotify Web API requests and token refresh; invalid delays use the caller fallback.
export function retryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) {
    const ms = Math.ceil(Number(value) * 1000);
    return Number.isSafeInteger(ms) ? ms : null;
  }
  // Date.parse also accepts strings like "-1" and "12" as dates. Only a real
  // HTTP date may use this branch; malformed numeric delays get the fallback.
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/
      .test(value.trim())
  ) return null;
  const timestamp = Date.parse(value);
  const ms = Math.max(0, timestamp - now);
  return Number.isSafeInteger(ms) ? ms : null;
}
