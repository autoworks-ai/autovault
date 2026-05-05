import { MAX_SKILL_MD_BYTES } from "../util/limits.js";
import { assertContentLength, fetchWithDeadline, readBoundedText } from "../util/bounded-fetch.js";
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
    const label = currentUrl.toString();
    const response = await fetchWithDeadline(
      fetcher,
      currentUrl,
      {
        headers: { "User-Agent": "autovault" },
        redirect: "manual"
      },
      label
    );

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

    // Pre-check on Content-Length when present, then enforce the cap during
    // the body read in case the upstream lied or omitted the header.
    assertContentLength(label, response.headers.get("content-length"), MAX_SKILL_MD_BYTES);
    const skillMd = await readBoundedText(response, MAX_SKILL_MD_BYTES, label);
    return { skillMd, sourceUrl: label };
  }

  throw new Error(`Unexpected URL fetch failure: ${url}`);
}
