// One typed line into the arguments a process actually receives.
//
// The settings screen takes arguments as a single line, the way a person
// would type them into a terminal, and splitting that on whitespace is
// wrong the moment a path contains a space. On macOS that is not an edge
// case: "Application Support", "Mobile Documents", and anybody whose
// folder has a space in its name all land here. The failure is quiet,
// because the command still runs, just with the path torn in half.
//
// So this splits the way a shell does for the part that matters: quotes
// group, backslash escapes the next character, and nothing else is
// interpreted. No globbing, no variables, no substitution. A person who
// needs those can point the command at a script.

/**
 * Split a command line into arguments.
 *
 * An unterminated quote is treated as if it were closed at the end of
 * the line, because the alternative is refusing to run a command over a
 * typo the person can plainly see.
 */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (quote === "'") {
      // Single quotes are literal, all the way to the closing quote.
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (ch === "\\") {
      // Inside double quotes a backslash only escapes a quote or itself;
      // elsewhere it escapes anything. Matches how sh behaves closely
      // enough that a pasted path keeps working.
      const next = line[i + 1];
      if (next === undefined) {
        current += "\\";
        started = true;
        continue;
      }
      if (quote === '"' && next !== '"' && next !== "\\") {
        current += ch;
        started = true;
        continue;
      }
      current += next;
      started = true;
      i++;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      // An empty quoted string is still an argument.
      started = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }

    current += ch;
    started = true;
  }

  if (started) args.push(current);
  return args;
}
