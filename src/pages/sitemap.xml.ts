import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { translated } from '../i18n/ui';

const SITE = 'https://xpressdjs.com';

// Unlisted/private pages to keep out of the sitemap.
const exclude = new Set(['/photobooth-templates']);

// Indexable English-only pages (no Spanish translation) — emitted without
// hreflang alternates so we never point search engines at a missing /es page.
const enOnly = ['/lgbtq-wedding-dj-south-florida', '/keychain-photo-booth-station'];

export const GET: APIRoute = async () => {
  const routes = Array.from(translated).filter((r) => !exclude.has(r));
  const emitted = new Set<string>();
  const blocks: string[] = [];

  const altBlock = (en: string, es: string) =>
    `<xhtml:link rel="alternate" hreflang="en" href="${en}"/>` +
    `<xhtml:link rel="alternate" hreflang="es" href="${es}"/>` +
    `<xhtml:link rel="alternate" hreflang="x-default" href="${en}"/>`;

  const addEnOnly = (loc: string) => {
    if (emitted.has(loc)) return;
    emitted.add(loc);
    blocks.push(`<url><loc>${loc}</loc></url>`);
  };

  const addPair = (en: string, es: string) => {
    if (emitted.has(en)) return;
    emitted.add(en);
    emitted.add(es);
    const alts = altBlock(en, es);
    blocks.push(`<url><loc>${en}</loc>${alts}</url>`);
    blocks.push(`<url><loc>${es}</loc>${alts}</url>`);
  };

  for (const r of enOnly) addEnOnly(SITE + r);

  for (const r of routes) {
    addPair(SITE + r, SITE + (r === '/' ? '/es/' : '/es' + r));
  }

  // Auto-include every blog post so new posts never need a manual sitemap edit.
  // Posts with a Spanish translation (a matching slug in the blogEs collection)
  // get hreflang alternates; the rest are emitted English-only.
  const esSlugs = new Set((await getCollection('blogEs')).map((p) => p.slug));
  for (const post of await getCollection('blog')) {
    const en = `${SITE}/wedding-blog/${post.slug}`;
    if (emitted.has(en)) continue;
    if (esSlugs.has(post.slug)) {
      addPair(en, `${SITE}/es/wedding-blog/${post.slug}`);
    } else {
      addEnOnly(en);
    }
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    blocks.join('\n') +
    `\n</urlset>\n`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
