/** Keep reader filters together when changing one part of the view. */
export function readerHref(state: Record<string, string | readonly string[] | undefined>, changes: Record<string, string | readonly string[] | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...state, ...changes })) {
    if (typeof value === "string") { if (value) params.set(key, value); }
    else value?.forEach(entry => params.append(key, entry));
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}
