import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    image: z.string().optional(),
    author: z.string().default('Xpress Entertainment'),
    tag: z.string().default('Wedding Tips'),
  }),
});

export const collections = { blog };
