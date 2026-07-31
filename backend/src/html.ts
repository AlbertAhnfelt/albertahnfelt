/** Minimal server-rendered pages, shared by the browser-facing flows. */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 ui-sans-serif, system-ui, sans-serif; max-width: 30rem;
         margin: 12vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.3rem; margin-bottom: 1rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem .9rem;
       margin: 1.25rem 0; font-size: .9rem; }
  dt { opacity: .6; }
  dd { margin: 0; overflow-wrap: anywhere; }
  button { font: inherit; padding: .6rem 1.4rem; border: 0; border-radius: .5rem;
           background: #2563eb; color: #fff; cursor: pointer; }
  code { font-size: .9em; }
</style>
${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
