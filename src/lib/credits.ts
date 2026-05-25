// Central photographer-credit lookup, keyed by image path. Lets any page
// (blog hero, blog cards, etc.) show the right credit for a reused photo.
export interface Credit { name: string; href?: string; }

export const imageCredits: Record<string, Credit> = {
  '/images/dj-drew-djing.jpg': { name: 'Sid Rashlich', href: 'https://photovsl.com/' },
  '/images/dancing-on-the-clouds.jpg': { name: 'Sid Rashlich', href: 'https://photovsl.com/' },
  '/images/heroes/pricing-hero.jpg': { name: 'Sid Rashlich', href: 'https://photovsl.com/' },
  '/images/heroes/dj-services-hero.jpg': { name: 'Romina Raggio Photography', href: 'https://rominaraggio.com/' },
  '/images/heroes/wedding-blog-hero.jpg': { name: 'Romina Raggio Photography', href: 'https://rominaraggio.com/' },
  '/images/atmosphere-lighting.jpg': { name: 'Romina Raggio Photography', href: 'https://rominaraggio.com/' },
  '/images/vibing-on-the-dance-floor.jpg': { name: 'The Schau Photography', href: 'https://theschau.com/' },
  '/images/heroes/dj-drew-hero.jpg': { name: 'The Schau Photography', href: 'https://theschau.com/' },
  '/images/heroes/services-hero.jpg': { name: 'Jupiter Wedding Photo', href: 'https://www.jupiterweddingphoto.com/' },
  '/images/sax-live-dance-floor.jpg': { name: 'Jupiter Wedding Photo', href: 'https://www.jupiterweddingphoto.com/' },
  '/images/couple-grand-entrance.jpg': { name: 'Scribbled Moments Photography', href: 'https://www.scribbledmomentsphotography.com/' },
  '/images/heroes/about-hero.jpg': { name: 'Cassandra Trcka Photography', href: 'https://www.cassandratrckaphotography.com/' },
  '/images/drew-newlyweds-dance-floor.jpg': { name: 'E + B Photography and Film Co.', href: 'https://www.ebphotographyandfilmco.com/' },
};

export function creditFor(src?: string): Credit | undefined {
  if (!src) return undefined;
  return imageCredits[src];
}
