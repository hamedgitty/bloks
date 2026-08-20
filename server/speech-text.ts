// What a reply sounds like, as opposed to what it looks like.
//
// Agents write markdown for eyes: fences, links, tables, emoji. A voice
// reading that verbatim announces asterisks and URLs. This flattens a
// reply into something a person would actually say, ordered regex
// passes, not a parser, because the goal is speech, not fidelity.
const LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  py: "Python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  swift: "Swift",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  sql: "SQL",
};

export function speakable(text: string): string {
  let out = text;

  // fences become a mention, with the language when it names one
  out = out.replace(/```(\w*)[^`]*```/g, (_all, lang: string) => {
    const name = LANGUAGE_NAMES[lang?.toLowerCase()] ?? (lang ? lang : "");
    return name ? ` …there's a ${name} code block here… ` : " …there's a code block here… ";
  });

  // images speak their alt text; links speak their label; bare URLs
  // become a noun instead of a spelling bee
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_a, alt: string) => (alt ? ` an image: ${alt} ` : " an image "));
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  out = out.replace(/https?:\/\/\S+/g, " a link ");

  // short inline code reads fine; long code is a mention
  out = out.replace(/`([^`]+)`/g, (_a, code: string) => (code.length <= 40 ? code : " a code snippet "));

  // headings end with a period so the voice pauses; list and quote
  // markers, rules, and emphasis are visual only
  out = out.replace(/^#{1,6}\s*(.+)$/gm, "$1.");
  out = out.replace(/^\s*[-*+]\s+/gm, "");
  out = out.replace(/^\s*\d+\.\s+/gm, "");
  out = out.replace(/^\s*>\s?/gm, "");
  out = out.replace(/^[-*_]{3,}\s*$/gm, "");
  out = out.replace(/(\*\*|__|\*|_|~~)/g, "");

  // table rows read as comma lists; separator rows vanish
  out = out.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "");
  out = out.replace(/^\s*\|(.+)\|\s*$/gm, (_a, row: string) =>
    row
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(", "),
  );

  // emoji get announced by name by every engine; strip them
  out = out.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "");

  // newlines become sentence breaks; tidy the punctuation that leaves
  out = out
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, ". ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s*\.\s*\./g, ".")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  // whitespace-only input must return nothing: a lone period is an
  // audible click, not silence
  return /[\p{L}\p{N}]/u.test(out) ? out : "";
}
