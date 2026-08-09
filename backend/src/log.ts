/**
 * Writing a distilled session into the vault's log — the one way it happens.
 *
 * Two callers, and they must not drift: the `log_session` tool (an agent, or
 * Albert, asking for it explicitly) and the nightly sweep in `sweep.ts` (a
 * website conversation that has gone quiet). They differ in who decides to
 * write and in the provenance stamped on the page; everything else — the path,
 * the frontmatter, the refusal to overwrite — is here.
 *
 * `DISTILL_INSTRUCTIONS` is the other half of that: the wording that says what a
 * log should contain. Both callers hand it to a model, so it lives here too
 * rather than being written out twice and slowly diverging.
 */

import { LOG_PREFIX, isSafeLogSlug, vaultDate } from "./vault";

const MD = { httpMetadata: { contentType: "text/markdown; charset=utf-8" } };

/** R2 put precondition for "create only if the key does not exist yet". */
const CREATE_ONLY = { onlyIf: new Headers({ "If-None-Match": "*" }) };

/** How many ` 2`, ` 3`… variants to try before giving up on a taken path. */
const MAX_SLUG_ATTEMPTS = 5;

export type LogType = "changes" | "ideas";

export type LogInput = {
  /** Human title. Validated by `isSafeLogSlug` before it becomes a path. */
  titleSlug: string;
  type: LogType;
  /** Distilled markdown, without frontmatter — that is added here. */
  body: string;
  tags?: string[];
  /** Extra frontmatter lines, as key/value pairs. Used to record provenance. */
  extra?: [string, string][];
};

export type LogResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * What a log should say, and what it should leave out.
 *
 * Shared wording, not shared prompt: the MCP prompt wraps this in an
 * instruction to call the tool, and the sweep wraps it in an instruction to
 * answer with the body directly. Only the wrapper differs.
 */
export const DISTILL_INSTRUCTIONS = `What to capture — only what future-you (or the user, months from now) would actually need:
- Decisions made, and the WHY behind each — reasoning is the most valuable thing to preserve.
- Concrete changes shipped (code, config, deployments): what and where, as file paths or names — never code dumps.
- Core conclusions or ideas arrived at, stated plainly.
- Open threads: what was deliberately deferred or left unresolved.

What to leave out — be ruthless:
- Play-by-play narrative, false starts, debugging detours that led nowhere.
- Anything derivable from the code or git history itself.
- Pleasantries, process talk, tool mechanics.

Form: aim for well under a page. Short declarative bullets over prose. It is better to drop a detail than to bury a decision.`;

/**
 * Turn a display title into something that can be part of a filename.
 *
 * A title is user- or model-supplied text, so this strips rather than escapes:
 * what survives is letters, digits, spaces and dashes, and the result is checked
 * by `isSafeLogSlug` at the call site regardless. Nothing that fails to reduce
 * to a safe slug is allowed to name a file — it falls back to a fixed word.
 */
export function slugFromTitle(title: string, fallback = "konversation"): string {
  const slug = title
    .replace(/[^\p{L}\p{N} -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    // isSafeLogSlug allows one leading character plus 80 more.
    .slice(0, 81)
    .trimEnd();
  return isSafeLogSlug(slug) ? slug : fallback;
}

function frontmatter(input: LogInput): string {
  const tags = [input.type, ...(input.tags ?? []).filter((tag) => tag !== input.type)];
  return [
    "---",
    "provenance: ai",
    `date: ${vaultDate()}`,
    `type: ${input.type}`,
    ...(input.extra ?? []).map(([key, value]) => `${key}: ${value}`),
    `tags: [${tags.join(", ")}]`,
    "---",
    "",
  ].join("\n");
}

/**
 * Write a log page, refusing to overwrite anything.
 *
 * Create-only is the point: a log is a record of something that happened, and a
 * second session on the same day with the same title is a second record, not a
 * correction of the first. So a taken path becomes ` 2` rather than a
 * replacement, and only an exhausted set of variants is a failure.
 */
export async function writeLog(vault: R2Bucket, input: LogInput): Promise<LogResult> {
  if (!isSafeLogSlug(input.titleSlug)) {
    return {
      ok: false,
      error: `Invalid title_slug "${input.titleSlug}": letters, digits, spaces and dashes only.`,
    };
  }
  if (input.type !== "changes" && input.type !== "ideas") {
    return { ok: false, error: `Invalid type "${input.type}": expected "changes" or "ideas".` };
  }

  const date = vaultDate();
  const content = frontmatter(input) + input.body;

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 1 ? input.titleSlug : `${input.titleSlug} ${attempt}`;
    const path = `${LOG_PREFIX}${date.slice(0, 7)}/${date} ${slug}.md`;
    const res = await vault.put(path, content, { ...MD, ...CREATE_ONLY });
    if (res) return { ok: true, path };
  }

  return {
    ok: false,
    error:
      `Refused: ${LOG_PREFIX} already holds a log for today named "${input.titleSlug}" ` +
      `(and ${MAX_SLUG_ATTEMPTS - 1} numbered variants). Pick a different title_slug.`,
  };
}
