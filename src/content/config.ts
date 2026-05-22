import { defineCollection, z } from 'astro:content';

const postSchema = z.object({
  title: z.string(),
  description: z.string(),
  date: z.coerce.date(),
  image: z.string().optional(),
  author: z.string().default('Xpress Entertainment'),
  tag: z.string().default('Wedding Tips'),
});

const blog = defineCollection({ type: 'content', schema: postSchema });
const blogEs = defineCollection({ type: 'content', schema: postSchema });

export const collections = { blog, blogEs };
