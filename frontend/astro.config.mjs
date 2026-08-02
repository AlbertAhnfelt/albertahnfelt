// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';

import sitemap from '@astrojs/sitemap';

/**
 * Mirrors the `/vault/:path*` rewrite in vercel.json. Note paths cannot be
 * prerendered — knowing them at build time would mean baking the vault into the
 * static site — so every one of them is served by the single /vault page, which
 * reads the path client-side. Without this, `astro dev` 404s on any deep note
 * URL and dev stops resembling production.
 */
const vaultRewrite = {
  name: 'vault-deep-link-rewrite',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/vault\/[^?]/.test(req.url)) req.url = '/vault'
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
    plugins: [vaultRewrite],
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
