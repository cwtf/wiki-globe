/**
 * wiki-globe fork only — deployment identity for the sub-app.
 *
 * The simulator is served as a statically exported Next.js app mounted at
 * `/blackhole/` on the wiki-globe domain. Next rewrites URLs it owns
 * (`_next/*`, `next/image` sources, metadata routes) using `basePath`, but it
 * does NOT rewrite plain string literals — manifest icon paths, `<img src>`,
 * `fetch()` targets, texture URLs. Anything in that second category must be
 * built from `BASE_PATH` here so it survives the mount point changing.
 */

/** Must match `basePath` in next.config.mjs. */
export const BASE_PATH = "/blackhole";

/** Canonical origin the exported build is published under. */
export const SITE_ORIGIN = "https://wikiglo.be";

/** Canonical URL of the simulator itself. */
export const SITE_URL = `${SITE_ORIGIN}${BASE_PATH}`;

/** Where the "back to the globe" control returns to. */
export const PARENT_APP_URL = "/";

/** Prefix a public/ asset path with the deployment base path. */
export function asset(path: string): string {
  return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}
