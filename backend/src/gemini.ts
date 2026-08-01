/**
 * Minimal Gemini REST client — just enough for a tool-calling loop.
 *
 * Deliberately not the SDK: this needs one endpoint, and a hand-rolled fetch is
 * easier to reason about in a Worker than a dependency that assumes Node. When
 * a second provider arrives, this is the shape to copy.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export const DEFAULT_MODEL = "gemini-2.5-flash";

const TIMEOUT_MS = 60_000;

export type Part =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export type Content = { role: "user" | "model"; parts: Part[] };

export type FunctionDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** Thrown for anything the caller should treat as "the model did not answer". */
export class GeminiError extends Error {}

export async function generate(opts: {
  apiKey: string;
  model: string;
  system: string;
  contents: Content[];
  tools: FunctionDeclaration[];
}): Promise<Part[]> {
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}/${encodeURIComponent(opts.model)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Header rather than a ?key= query param: URLs turn up in logs and
        // error traces, and this one is a credential.
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: opts.contents,
        ...(opts.tools.length ? { tools: [{ functionDeclarations: opts.tools }] } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new GeminiError(`request failed: ${cause instanceof Error ? cause.name : "unknown"}`);
  }

  if (!res.ok) {
    // Status only. The body can echo the request, and this is the one place a
    // provider error could otherwise carry prompt content into our logs.
    throw new GeminiError(`upstream ${res.status}`);
  }

  const body = (await res.json()) as {
    candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  const blocked = body.promptFeedback?.blockReason;
  if (blocked) throw new GeminiError(`blocked: ${blocked}`);

  return body.candidates?.[0]?.content?.parts ?? [];
}
