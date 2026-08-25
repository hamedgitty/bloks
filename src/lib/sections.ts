// Filing the sidebar.
//
// A section is nothing but a name that agents and rooms agree to stand
// under; there is no sections table anywhere, so a section exists
// exactly as long as something is filed under it and vanishes when the
// last member leaves. That keeps the feature weightless: nothing to
// create first, nothing to clean up after.

interface Filed {
  section?: string | null;
}

/** Every section name in use, each once, in the order headings render.
 * Alphabetical, because the user named these and can predict it. */
export function sectionNames(...groups: Filed[][]): string[] {
  const names = new Set<string>();
  for (const rows of groups) {
    for (const row of rows) if (row.section) names.add(row.section);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** One section's slice of a list, in the list's own order. */
export function inSection<T extends Filed>(rows: T[], name: string | null): T[] {
  return rows.filter((row) => (row.section ?? null) === name);
}
