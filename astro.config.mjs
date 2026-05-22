import { defineConfig } from 'astro/config';

// Set this to your real domain before deploy.
// (Re-add @astrojs/sitemap once versions are matched: `npx astro add sitemap`)
export default defineConfig({
  site: 'https://xpressdjs.com',
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'es'],
    routing: { prefixDefaultLocale: false },
  },
});
