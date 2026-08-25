export const DEFAULT_CLOUD_ORIGIN = "https://autovault.dev";

export function cloudOrigin(): string {
  const raw =
    process.env.AUTOVAULT_CLOUD_ORIGIN?.trim() || DEFAULT_CLOUD_ORIGIN;
  return raw.replace(/\/+$/, "");
}

export function cloudApiUrl(pathname: string): URL {
  if (!pathname.startsWith("/")) {
    throw new Error(`Cloud API path must be absolute (got ${pathname})`);
  }
  return new URL(pathname, `${cloudOrigin()}/`);
}

export function isCloudOriginUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    const origin = new URL(`${cloudOrigin()}/`);
    return url.protocol === origin.protocol && url.host === origin.host;
  } catch {
    return false;
  }
}
