// Lightweight i18n helpers + UI dictionary for the site chrome (nav, footer,
// language toggle). Page body copy lives in the per-locale page files
// (English under /, Spanish under /es/).

export const locales = ['en', 'es'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

// English routes that have a Spanish translation. Add slugs here as pages are
// translated so the nav/footer/toggle automatically link to the /es version.
export const translated = new Set<string>([
  '/',
  '/the-experience',
  '/pricing',
  '/check-availability',
  '/dj-drew-segura',
  '/djphil',
  '/services',
  '/services/djs',
  '/services/fort-lauderdale-wedding-dj',
  '/epic-extras-1',
  '/epic-extras-1/lighting',
  '/epic-extras-1/dancing-on-the-clouds',
  '/epic-extras-1/cold-sparks',
  '/south-florida-photo-booth-rental',
  '/glam-booth',
  '/photobooth-templates',
  '/wedding-content-creator',
  '/vibo',
  '/wedding-dj-miami',
  '/about-xpress-entertainment',
  '/reviews',
  '/careers',
  '/privacy-policy',
  '/wedding-blog',
  '/wedding-blog/how-to-choose-the-perfect-dj-for-your-wedding',
  '/wedding-blog/how-to-keep-the-dance-floor-packed-all-night',
  '/wedding-blog/music-trends-for-weddings-in-south-florida',
]);

/** Current locale from the URL ( /es/... => 'es', otherwise 'en' ). */
export function getLocale(url: URL): Locale {
  return url.pathname === '/es' || url.pathname.startsWith('/es/') ? 'es' : 'en';
}

/** Normalize any pathname to its English-route form (strip /es, trailing slash). */
export function toEnPath(pathname: string): string {
  let p = pathname.replace(/^\/es(?=\/|$)/, '');
  if (!p) p = '/';
  if (p.length > 1) p = p.replace(/\/$/, '');
  return p;
}

/** Whether an English route has a Spanish version yet. */
export function hasES(enPath: string): boolean {
  return translated.has(enPath);
}

/** Build an href for an English route in the requested locale (graceful fallback to English when not translated). */
export function localize(enPath: string, locale: Locale): string {
  if (locale === 'en') return enPath;
  if (!translated.has(enPath)) return enPath; // not translated yet -> serve English
  return enPath === '/' ? '/es/' : '/es' + enPath;
}

type NavDict = {
  experience: string; djs: string; services: string; epicExtras: string;
  pricing: string; blog: string; about: string; reviews: string; checkDate: string;
  djDrew: string; djPhil: string; allDjs: string;
  allServices: string; photoBooths: string; glamBooth: string; photoTemplates: string; contentCreator: string; vibo: string;
  overview: string; clouds: string; coldSparks: string; lighting: string;
};
type FootDict = {
  tagline: string; explore: string; home: string; theExperience: string;
  services: string; pricing: string; weddingBlog: string; about: string;
  servicesHead: string; weddingDjs: string; photoBooths: string; epicExtras: string;
  contentCreator: string; viboPlanning: string; contact: string;
  checkAvailability: string; rightsSuffix: string; tagline2: string;
};

export const ui: Record<Locale, { nav: NavDict; foot: FootDict; toggle: string }> = {
  en: {
    nav: {
      experience: 'Experience', djs: 'DJs', services: 'Services', epicExtras: 'Epic Extras',
      pricing: 'Pricing', blog: 'Blog', about: 'About', reviews: 'Reviews', checkDate: 'Check Your Date',
      djDrew: 'Drew Segura', djPhil: 'DJ Phil', allDjs: 'All DJs →',
      allServices: 'All Services', photoBooths: 'Photo Booths', glamBooth: 'Glam Booth', photoTemplates: 'Photo Booth Templates', contentCreator: 'Content Creator', vibo: 'Vibo Planning App',
      overview: 'Overview', clouds: 'Dancing on the Clouds', coldSparks: 'Cold Sparks', lighting: 'Lighting & Monogram',
    },
    foot: {
      tagline: "South Florida's award-winning wedding DJ & entertainment company. Pembroke Pines, FL.",
      explore: 'Explore', home: 'Home', theExperience: 'The Experience', services: 'Services',
      pricing: 'Pricing', weddingBlog: 'Wedding Blog', about: 'About',
      servicesHead: 'Services', weddingDjs: 'Wedding DJs', photoBooths: 'Photo Booths', epicExtras: 'Epic Extras',
      contentCreator: 'Content Creator', viboPlanning: 'Vibo Planning', contact: 'Contact',
      checkAvailability: 'Check Availability', rightsSuffix: 'All rights reserved.',
      tagline2: 'The Ultimate Wedding Experience.',
    },
    toggle: '¿Prefieres en español?',
  },
  es: {
    nav: {
      experience: 'Experiencia', djs: 'DJs', services: 'Servicios', epicExtras: 'Extras Épicos',
      pricing: 'Precios', blog: 'Blog', about: 'Nosotros', reviews: 'Reseñas', checkDate: 'Consulta tu Fecha',
      djDrew: 'Drew Segura', djPhil: 'DJ Phil', allDjs: 'Todos los DJs →',
      allServices: 'Todos los Servicios', photoBooths: 'Cabinas de Fotos', glamBooth: 'Glam Booth', photoTemplates: 'Plantillas de Cabina', contentCreator: 'Creador de Contenido', vibo: 'App de Planeación Vibo',
      overview: 'Resumen', clouds: 'Bailando en las Nubes', coldSparks: 'Chispas Frías', lighting: 'Iluminación y Monograma',
    },
    foot: {
      tagline: 'Compañía de DJ y entretenimiento para bodas, galardonada en el sur de Florida. Pembroke Pines, FL.',
      explore: 'Explorar', home: 'Inicio', theExperience: 'La Experiencia', services: 'Servicios',
      pricing: 'Precios', weddingBlog: 'Blog de Bodas', about: 'Nosotros',
      servicesHead: 'Servicios', weddingDjs: 'DJs de Bodas', photoBooths: 'Cabinas de Fotos', epicExtras: 'Extras Épicos',
      contentCreator: 'Creador de Contenido', viboPlanning: 'Planeación Vibo', contact: 'Contacto',
      checkAvailability: 'Consulta Disponibilidad', rightsSuffix: 'Todos los derechos reservados.',
      tagline2: 'La Máxima Experiencia de Bodas.',
    },
    toggle: 'View in English',
  },
};

export function t(locale: Locale) {
  return ui[locale];
}
