// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';

import sitemap from '@astrojs/sitemap';

/**
 * Mirrors the `/vault/:path*` and `/abbe/:path*` rewrites in vercel.json.
 * Neither a note path nor a conversation id can be prerendered — knowing them at
 * build time would mean baking the vault, or the chat history, into the static
 * site — so every one of them is served by the single /vault or /abbe page,
 * which reads the path client-side. Without this, `astro dev` 404s on any deep
 * URL and dev stops resembling production.
 */
const deepLinkRewrite = {
  name: 'private-deep-link-rewrite',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const match = req.url && /^\/(vault|abbe)\/[^?]/.exec(req.url)
      if (match) req.url = `/${match[1]}`
      next()
    })
  }
}

export default defineConfig({
  site: 'https://albertahnfelt.com',
  integrations: [
    svelte(),
    // /abbe and /vault are private surfaces, not something to invite crawlers into.
    sitemap({ filter: (page) => !page.includes('/abbe') && !page.includes('/vault') })
  ],
  vite: {
    plugins: [deepLinkRewrite],
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
