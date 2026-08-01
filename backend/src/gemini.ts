/**
 * Minimal Gemini REST client — just enough for a tool-calling loop.
 *
 * Deliberately not the SDK: this needs one endpoint, and a hand-rolled fetch is
 * easier to reason about in a Worker than a dependency that assumes Node. When
 * a second provider arrives, this is the shape to copy.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export const DEFAULT_MODEL = "gemini-3.6-flash";

const TIMEOUT_MS = 60_000;

/**
 * Open on purpose. Gemini 3 attaches a `thoughtSignature` to the parts it
 * emits and rejects the next request with 400 if a functionCall comes back
 * without it, so a part the model produced must be echoed exactly as received
 * — never rebuilt from the fields we happen to care about.
 */
export type Part = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
  [passthrough: string]: unknown;
};

export type Content = { role: "user" | "model"; parts: Part[] };

export type FunctionDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** Thrown for anything the caller should treat as "the model did not answer". */
export class GeminiError extends Error {}

type Request = {
  apiKey: string;
  model: string;
  system: string;
  contents: Content[];
  tools: FunctionDeclaration[];
};

function body(opts: Request): string {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: opts.contents,
    ...(opts.tools.length ? { tools: [{ functionDeclarations: opts.tools }] } : {}),
  });
}

/**
 * One event per part the model emits, carrying the raw part so the caller can
 * echo the turn back verbatim. `text` and `call` are conveniences on top of it,
 * not replacements for it.
 */
export type StreamEvent = {
  part: Part;
  text?: string;
  call?: { name: string; args?: Record<string, unknown> };
};

/**
 * The same request as `generate`, delivered incrementally.
 *
 * Gemini's SSE frames are whole JSON responses, so each one is parsed and its
 * parts emitted; only `text` is genuinely partial. A frame that fails to parse
 * is skipped rather than killing the turn — a truncated frame at the tail is
 * not worth losing a complete answer over.
 */
export async function* generateStream(opts: Request): AsyncGenerator<StreamEvent> {
  let res: Response;
  try {
    res = await fetch(
      `${ENDPOINT}/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
        body: body(opts),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (cause) {
    throw new GeminiError(`request failed: ${cause instanceof Error ? cause.name : "unknown"}`);
  }

  if (!res.ok) throw new GeminiError(`upstream ${res.status}`);
  if (!res.body) throw new GeminiError("upstream sent no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are blank-line delimited; the tail is kept for the next
      // read. Google sends CRLF, so both endings have to be accepted — matching
      // only "\n\n" leaves every frame stuck in the buffer and emits nothing.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const payload = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!payload || payload === "[DONE]") continue;

        let chunk: { candidates?: { content?: { parts?: Part[] } }[] };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        // Every part is yielded, including signature-only ones with empty text:
        // dropping them here would drop the signature the next round needs.
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          yield {
            part,
            ...(part.functionCall ? { call: part.functionCall } : {}),
            ...(part.text ? { text: part.text } : {}),
          };
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
