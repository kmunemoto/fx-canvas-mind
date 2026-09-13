// READING WHAT THE ANALYST SENT BACK.
//
// Both the new-entry call (analyze) and the held-position review
// (position-review) parse the same thing the same way: text blocks out of an
// Anthropic response, then the JSON out of that text. They used to be two
// copies in one file, which was fine while they lived in one file. Since the
// review moved to its own function (docs/OPERATIONS.md §6.1.1 — the analyze
// bundle outgrew the deploy path), two copies would be two files that drift.
//
// A drift here is not cosmetic: if the review's parser stops accepting a shape
// the main parser accepts, the review starts reporting `parse_*` failures for
// answers the analyst actually gave, and the screen says "判定できない" about a
// verdict that exists.
//
// Deno-free on purpose so both functions and the tests can import it.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The assistant's text, with every text block joined. Server tools interleave
// non-text blocks (search results, tool uses); those are skipped rather than
// stringified, or the JSON parse below would choke on them.
export const extractAnthropicText = (value: unknown): string => {
  if (!isRecord(value)) return "";

  const content = value.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];

  for (const block of content) {
    if (typeof block === "string") {
      textParts.push(block);
      continue;
    }

    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }

  return textParts.join("").trim();
};

// The JSON inside the text. Three fallbacks, in order: the <json> tags the
// prompt asks for, a fenced block, and finally the outermost braces — because
// a turn that ran long can lose the closing tag while the object itself is
// intact, and throwing that answer away costs a whole paid call.
export const parseAnalysisJson = (finalText: string): unknown => {
  const tagMatch = finalText.match(/<json>([\s\S]*?)<\/json>/);
  const source = tagMatch ? tagMatch[1] : finalText;
  const cleaned = source.replace(/```json\n?|```\n?/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};
