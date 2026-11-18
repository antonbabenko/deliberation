import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'
import { docsLoader, sourcesLoader } from './lib/docs-loader.ts'

const link = z.object({ slug: z.string(), title: z.string() })

const docs = defineCollection({
  loader: docsLoader(),
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    description: z.string(),
    source: z.string().nullable(),
    nav: z.string().nullable(),
    group: z.string(),
    order: z.number(),
    parent: link.nullable(),
    children: z.array(link),
  }),
})

const sources = defineCollection({
  loader: sourcesLoader(),
  schema: z.object({ file: z.string(), route: z.string(), order: z.number() }),
})

export const collections = { docs, sources }
