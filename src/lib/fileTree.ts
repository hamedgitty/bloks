// The Files panel's tree (src/components/dock/FilesPanel.tsx): an agent's
// shared files, which the server lists as names with their folders in
// them ("reports/q3.pdf"), drawn as folders and files, and narrowed by
// what is typed in its filter box.
//
// Only names the server listed are ever in it: the tree is the agent's
// own files folder (server/artifacts.ts), the one place a file is served
// from, never the folder it works in. No React and no page: the tests
// read it.

export interface FileLeaf {
  name: string;
  mime: string;
  size: number;
}

export interface TreeNode {
  /** The last part of the path: what the row says. */
  label: string;
  /** The whole path, folders included: what a file is opened by, and
   * what keeps a folder open. */
  path: string;
  folder: boolean;
  file?: FileLeaf;
  children: TreeNode[];
}

/** Folders first, then files, each in the order a person reads names
 * (numbers counted, case ignored). */
function sortNodes(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => (a.folder !== b.folder ? (a.folder ? -1 : 1) : a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" })));
  for (const node of nodes) if (node.folder) sortNodes(node.children);
  return nodes;
}

/** The listed files as a tree. A name with an empty part is skipped: the
 * server never lists one, and a row with no words would be no row. */
export function buildTree(files: readonly FileLeaf[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();
  for (const file of files) {
    const parts = file.name.split("/");
    if (parts.some((p) => !p)) continue;
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let folder = folders.get(path);
      if (!folder) {
        folder = { label: parts[i], path, folder: true, children: [] };
        folders.set(path, folder);
        level.push(folder);
      }
      level = folder.children;
    }
    level.push({ label: parts[parts.length - 1], path: file.name, folder: false, file, children: [] });
  }
  return sortNodes(root);
}

/** The tree narrowed to files whose path holds every word typed, in any
 * order and case, with the folders that lead to them. Nothing typed is
 * the whole tree. */
export function filterTree(nodes: readonly TreeNode[], query: string): TreeNode[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...nodes];
  const keep = (node: TreeNode): TreeNode | null => {
    if (!node.folder) {
      const path = node.path.toLowerCase();
      return words.every((w) => path.includes(w)) ? node : null;
    }
    const children = node.children.map(keep).filter((n): n is TreeNode => n !== null);
    return children.length ? { ...node, children } : null;
  };
  return nodes.map(keep).filter((n): n is TreeNode => n !== null);
}

/** The rows on screen, in order, with how deep each is: every folder's
 * children follow it when it is open, or always while filtering. */
export function visibleRows(nodes: readonly TreeNode[], open: ReadonlySet<string>, filtering = false): Array<{ node: TreeNode; depth: number }> {
  const rows: Array<{ node: TreeNode; depth: number }> = [];
  const walk = (level: readonly TreeNode[], depth: number) => {
    for (const node of level) {
      rows.push({ node, depth });
      if (node.folder && (filtering || open.has(node.path))) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}

/** How many files the tree holds, folders not counted. */
export function countFiles(nodes: readonly TreeNode[]): number {
  return nodes.reduce((n, node) => n + (node.folder ? countFiles(node.children) : 1), 0);
}
