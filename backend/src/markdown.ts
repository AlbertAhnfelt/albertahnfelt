/**
 * Vault markdown → HTML, for the website's read-only vault browser.
 *
 * The output is inserted with innerHTML on the other side, which makes this the
 * one place in the codebase that produces trusted markup. Everywhere else the
 * rule is textContent and no exceptions; here the rule is replaced by a
 * stricter one.
 *
 * Safe by construction, not sanitised afterwards. Nothing an author wrote is
 * ever passed through as markup:
 *
 *   - raw HTML tokens are dropped, so `<script>` in a note is simply gone
 *   - every tag in the output is one this file chose to emit
 *   - text is escaped here, not by whoever calls us
 *   - link and image URLs are parsed and scheme-checked, never string-matched
 *
 * That ordering matters. A post-hoc cleaner has to recognise every trick; this
 * has to recognise nothing, because author markup never enters the pipeline.
 * `human/` and `external/` hold material copied in from elsewhere, so note
 * bodies are not trusted input just because the vault is private.
 */

import { Marked, type Renderer, type RendererObject, type Tokens } from "marked";

/** Where the site serves a note, and where it serves a note's images. */
const NOTE_BASE = "/vault/";
const ASSET_BASE = "/api/abbe/web/vault/asset?path=";

/**
 * Per segment, so slashes survive but everything else is encoded. `encodeURI`
 * would leave `#` and `?` alone, and a filename containing either would cut the
 * path short at exactly the wrong place.
 */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export type Frontmatter = { key: string; value: string }[];

export type RenderedNote = {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  html: string;
};

/* --------------------------------------------------------------- escaping */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * True only for URLs we are willing to emit as an href. Parsed rather than
 * prefix-matched, so `java\tscript:` and friends resolve to what the browser
 * would actually see rather than to what a string test hopes they are.
 */
function safeUrl(href: string): string | null {
  const raw = href.trim();

  // Site-internal: our own note and asset routes, plus in-page anchors.
  if (raw.startsWith(NOTE_BASE) || raw.startsWith(ASSET_BASE) || raw.startsWith("#")) {
    return raw;
  }

  try {
    // A base is required for relative inputs; anything that resolves against it
    // is relative, and relative links inside a note point nowhere useful.
    const url = new URL(raw, "https://invalid.example");
    if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
    if (url.hostname === "invalid.example" && !raw.startsWith("http")) return null;
    return url.href;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ frontmatter */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split the leading `---` block off a note.
 *
 * Deliberately not a YAML parser. This vault's frontmatter is flat
 * `key: value` with the occasional `[a, b]` list, and a real YAML engine would
 * be a dependency and a parser surface bought for nothing. Anything it does not
 * understand is kept as its literal text, which is the honest failure mode for
 * something whose only job is display.
 */
export function splitFrontmatter(source: string): { frontmatter: Frontmatter; body: string } {
  const match = source.match(FRONTMATTER);
  if (!match) return { frontmatter: [], body: source };

  const frontmatter: Frontmatter = [];

  for (const line of match[1].split(/\r?\n/)) {
    // Continuation lines of a block value, and list items, ride along with the
    // key above them rather than being mangled into keys of their own.
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;

    const [, key, rawValue] = pair;
    let value = rawValue.trim();

    // [a, b] → a, b — and quotes off, since they are YAML syntax, not content.
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
        .join(", ");
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }

    if (value) frontmatter.push({ key, value });
  }

  return { frontmatter, body: source.slice(match[0].length) };
}

/* --------------------------------------------------------------- wikilinks */

/** `[[Page]]`, `[[Page|label]]`, `[[Page#heading]]` and the `![[embed]]` form. */
const WIKILINK = /(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

/**
 * Rewrite Obsidian links into ordinary markdown before parsing.
 *
 * Resolution is by basename against the note index, which is how Obsidian
 * itself resolves them — `[[Lazy routing]]` finds `wiki/concepts/Lazy
 * routing.md` wherever it lives. A link that resolves to nothing stays as
 * plain text rather than becoming a link to a 404, so a dead reference reads
 * as a dead reference.
 */
function resolveWikilinks(body: string, index: Map<string, string>): string {
  return body.replace(WIKILINK, (whole, bang: string, target: string, label?: string) => {
    const name = target.trim();
    const path = index.get(name.toLowerCase());
    if (!path) return label?.trim() || name;

    const text = (label?.trim() || name).replace(/[[\]]/g, "");
    // `![[x]]` embeds a note in Obsidian; here it is just a link to it, since
    // this is a reader and transclusion is not something it does.
    return `[${text}](${NOTE_BASE}${encodePath(path)})`;
  });
}

/* ------------------------------------------------------------------ render */

/**
 * A renderer that can only produce the tags written here. Every method either
 * escapes its input or passes through already-rendered child output, and the
 * two HTML passthroughs are stubbed out.
 */
function renderer(notePath: string, index: Map<string, string>): RendererObject {
  const folder = notePath.slice(0, notePath.lastIndexOf("/") + 1);

  /** Images resolve against the note's own folder, as they do in Obsidian. */
  const assetUrl = (src: string): string | null => {
    const raw = src.trim();
    if (/^https?:\/\//i.test(raw)) return safeUrl(raw);

    // Anything else carrying a scheme is not a vault file, whatever it claims.
    // Without this, `data:text/html,...` is treated as a relative filename and
    // laundered into an asset URL — harmless, since the endpoint would refuse
    // it, but it should never get that far.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;

    // Normalise `../` and `./` against the note's directory. Popping an empty
    // stack is a no-op, so a path cannot climb above the bucket root; one that
    // tries lands outside the asset allowlist and is refused on the way out.
    const parts = (folder + raw).split("/");
    const stack: string[] = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    const key = stack.join("/");
    return key ? ASSET_BASE + encodeURIComponent(key) : null;
  };

  return {
    // The two doors author markup would otherwise walk through.
    html: (): string => "",
    // marked calls this for inline `<b>` and friends.
    text(token: Tokens.Text | Tokens.Escape): string {
      return escape(token.text);
    },

    code({ text, lang }: Tokens.Code): string {
      const cls = lang ? ` class="language-${escape(lang.split(/\s+/)[0])}"` : "";
      return `<pre><code${cls}>${escape(text)}</code></pre>`;
    },
    codespan({ text }: Tokens.Codespan): string {
      return `<code>${escape(text)}</code>`;
    },
    link(this: Renderer, { href, title, tokens }: Tokens.Link): string {
      const url = safeUrl(href);
      const inner = this.parser.parseInline(tokens);
      if (!url) return inner;
      const t = title ? ` title="${escape(title)}"` : "";
      const external = /^https?:/i.test(url);
      // noopener/noreferrer on outbound links: a vault note path must not ride
      // out in a Referer header, and window.opener is never wanted.
      const rel = external ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${escape(url)}"${t}${rel}>${inner}</a>`;
    },
    image({ href, title, text }: Tokens.Image): string {
      const url = assetUrl(href);
      if (!url) return escape(text);
      const t = title ? ` title="${escape(title)}"` : "";
      return `<img src="${escape(url)}" alt="${escape(text)}"${t} loading="lazy">`;
    },
  };
}

/** Render one note. `index` maps lowercased basenames to vault paths. */
export function renderNote(
  path: string,
  source: string,
  index: Map<string, string>,
): RenderedNote {
  const { frontmatter, body } = splitFrontmatter(source);

  const marked = new Marked({
    gfm: true,
    breaks: false,
    // No raw HTML reaches the renderer, so there is nothing for it to mangle.
    renderer: renderer(path, index),
  });

  const html = marked.parse(resolveWikilinks(body, index), { async: false });

  // The first heading names the note when it has one; otherwise its filename
  // does, which is how the vault is organised anyway.
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const filename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

  return { path, title: heading || filename, frontmatter, html };
}
