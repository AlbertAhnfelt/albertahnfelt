// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';

import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://albertahnfelt.com',
  integrations: [
    svelte(),
    // /abbe is a private surface, not something to invite crawlers into.
    sitemap({ filter: (page) => !page.includes('/abbe') })
  ],
  vite: {
    server: {
      proxy: {
        // Mirrors the Vercel rewrite in vercel.json so `astro dev` behaves like
        // production against a local `wrangler dev` on :8787.
        '/api/abbe/web': {
          target: 'http://localhost:8787',
          rewrite: (path) => path.replace(/^\/api\/abbe/, '')
        }
      }
    }
  }
});
