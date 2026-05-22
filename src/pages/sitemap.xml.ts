import type { APIRoute } from 'astro';
import { translated } from '../i18n/ui';

const SITE = 'https://xpressdjs.com';

// Unlisted/private pages to keep out of the sitemap.
const exclude = new Set(['/photobooth-templates']);

export const GET: APIRoute = () => {
  const routes = Array.from(translated).filter((r) => !exclude.has(r));
  const blocks: string[] = [];

  for (const r of routes) {
    const en = SITE + r;
    const es = SITE + (r === '/' ? '/es/' : '/es' + r);
    const alts =
      `<xhtml:link rel="alternate" hreflang="en" href="${en}"/>` +
      `<xhtml:link rel="alternate" hreflang="es" href="${es}"/>` +
      `<xhtml:link rel="alternate" hreflang="x-default" href="${en}"/>`;
    blocks.push(`<url><loc>${en}</loc>${alts}</url>`);
    blocks.push(`<url><loc>${es}</loc>${alts}</url>`);
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
