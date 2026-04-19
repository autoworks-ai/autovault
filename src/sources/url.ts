import type { FetchedSkill } from "./types.js";

const MAX_REDIRECTS = 5;

function resolveRedirectUrl(from: URL, location: string): URL {
  try {
    return new URL(location, from);
  } catch {
    throw new Error(`Invalid redirect location: ${location}`);
  }
}

export async function fetchSkillFromUrl(
  identifier: string,
  options: { fetch?: typeof fetch } = {}
): Promise<FetchedSkill> {
  const fetcher = options.fetch ?? fetch;
  let url: URL;
  try {
    url = new URL(identifier);
  } catch {
    throw new Error(`Invalid URL identifier: ${identifier}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Only https URLs are supported (got ${url.protocol})`);
  }

  let currentUrl = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const response = await fetcher(currentUrl, {
      headers: { "User-Agent": "autovault" },
      redirect: "manual"
    });

    if (response.status >= 300 && response.status < 400) {
      if (i === MAX_REDIRECTS) {
        throw new Error(`Too many redirects while fetching URL: ${url}`);
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect response missing location header: ${currentUrl}`);
      }
      const nextUrl = resolveRedirectUrl(currentUrl, location);
      if (nextUrl.protocol !== "https:") {
        throw new Error(`Redirect to non-https URL is not allowed: ${nextUrl}`);
      }
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(`URL fetch failed: ${response.status} ${response.statusText} (${currentUrl})`);
    }
    const skillMd = await response.text();
    return { skillMd, sourceUrl: currentUrl.toString() };
  }

  throw new Error(`Unexpected URL fetch failure: ${url}`);
}
