// SPDX-License-Identifier: AGPL-3.0-or-later
// ridrs Scenic lives under a path of ridrs.app (BASE_PATH, "/scenic"): the worker strips it before routing,
// static assets sit under dist/scenic/, and every URL the worker builds for itself starts with origin + base.

/** "/scenic" (no trailing slash), or "" when the site runs at the root. */
export const basePath = (env) => {
  const b = String(env?.BASE_PATH ?? '').trim().replace(/\/+$/, '');
  return b && !b.startsWith('/') ? `/${b}` : b;
};

/**
 * Splits a request path into the part after the base. Returns {path} for paths inside the base,
 * {redirect} for the base itself without its slash (and the root, when served on its own), or {outside}.
 */
export function routePath(pathname, base) {
  if (!base) return { path: pathname };
  if (pathname === base || pathname === '/') return { redirect: `${base}/` };
  if (pathname === `${base}/admin`) return { redirect: `${base}/admin/` };
  if (!pathname.startsWith(`${base}/`)) return { outside: true };
  return { path: pathname.slice(base.length) };
}
