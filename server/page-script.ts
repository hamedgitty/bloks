// What the agent is allowed to know about a page, and how it acts on it.
//
// Two ideas do most of the work here.
//
// The first is the ref. A snapshot marks every element worth touching
// with a short handle, and the agent acts on the handle rather than on
// pixels. It survives a layout that reflows, it costs a few hundred
// tokens instead of an image, and it cannot land on the wrong thing
// because a banner appeared while the model was thinking.
//
// The second is the covered check. Most web-agent flailing is a click
// that silently hit a consent banner, a modal, or a sticky header
// sitting over the target. So a click asks the page what is actually at
// that point first, and when the answer is something else it says which
// thing, rather than clicking it and reporting success.
//
// These are strings because they run in the page, not here. They are
// written as one expression each so Runtime.evaluate can return a value
// directly.

/** Elements an agent could plausibly act on or needs to read. */
const INTERACTIVE =
  "a[href],button,input,select,textarea,summary,[role=button],[role=link]," +
  "[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=combobox]," +
  "[role=switch],[role=option],[contenteditable=true],[onclick]";

/**
 * Walk the page and hand back its controls, each with a ref.
 *
 * Everything invisible is skipped: an agent given hidden controls will
 * try one and get a failure it cannot understand. Names are computed
 * the way a screen reader would, because that is the label a person
 * would use when asking for the thing.
 */
export const SCAN = `(() => {
  const ATTR = "data-bloks-ref";
  for (const old of document.querySelectorAll("[" + ATTR + "]")) old.removeAttribute(ATTR);

  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    if (el.closest("[aria-hidden=true]")) return false;
    return true;
  };

  const name = (el) => {
    const label = el.getAttribute("aria-label");
    if (label) return label.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const parts = by.split(/\\s+/).map((id) => document.getElementById(id)?.innerText ?? "");
      const joined = parts.join(" ").trim();
      if (joined) return joined;
    }
    if (el.id) {
      const tied = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (tied?.innerText?.trim()) return tied.innerText.trim();
    }
    const wrapping = el.closest("label");
    if (wrapping?.innerText?.trim()) return wrapping.innerText.trim();
    for (const attr of ["alt", "title", "placeholder", "value"]) {
      const found = el.getAttribute?.(attr);
      if (found?.trim()) return found.trim();
    }
    return (el.innerText || el.textContent || "").trim();
  };

  const role = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio" || type === "submit" || type === "button") {
        return type === "submit" ? "button" : type;
      }
      return "textbox";
    }
    return tag;
  };

  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(${JSON.stringify(INTERACTIVE)})) {
    if (!visible(el)) continue;
    const ref = "e" + ++n;
    el.setAttribute(ATTR, ref);
    const entry = { ref, role: role(el), name: name(el).slice(0, 120).replace(/\\s+/g, " ") };
    if (el.disabled) entry.disabled = true;
    if (el.checked !== undefined && (el.type === "checkbox" || el.type === "radio")) {
      entry.checked = !!el.checked;
    }
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.value) {
      entry.value = String(el.value).slice(0, 80);
    }
    out.push(entry);
    if (n >= 250) break;
  }
  return { url: location.href, title: document.title, nodes: out };
})()`;

/**
 * What is actually at a ref, and whether a click would reach it.
 *
 * Scrolls the element into view first, because an off-screen element
 * has no point to test and every page puts something below the fold.
 */
export const clickScript = (ref: string) => `(() => {
  const ref = ${JSON.stringify(ref)};
  const el = document.querySelector('[data-bloks-ref="' + ref + '"]');
  if (!el) return { error: "no element @" + ref + ". Take a fresh snapshot: the page has changed." };
  el.scrollIntoView({ block: "center", inline: "center" });
  const box = el.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return { error: "@" + ref + " is not visible on the page" };
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const at = document.elementFromPoint(x, y);
  if (at && at !== el && !el.contains(at) && !at.contains(el)) {
    const describe = (node) => {
      const label = (node.getAttribute?.("aria-label") || node.innerText || "").trim().slice(0, 60);
      return node.tagName.toLowerCase() + (label ? ' "' + label.replace(/\\s+/g, " ") + '"' : "");
    };
    return {
      covered: describe(at),
      hint: "dismiss it or act on it, then snapshot again.",
    };
  }
  return { ok: true, x, y };
})()`;

/** Focus a field and clear it, ready for typing. */
export const focusScript = (ref: string, clear: boolean) => `(() => {
  const ref = ${JSON.stringify(ref)};
  const el = document.querySelector('[data-bloks-ref="' + ref + '"]');
  if (!el) return { error: "no element @" + ref + ". Take a fresh snapshot." };
  el.scrollIntoView({ block: "center" });
  el.focus();
  ${
    clear
      ? `if ("value" in el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
         else if (el.isContentEditable) { el.textContent = ""; }`
      : ""
  }
  return { ok: true };
})()`;

/** The page as text, for reading rather than acting. */
export const READ = `(() => {
  const clone = document.body.cloneNode(true);
  for (const junk of clone.querySelectorAll("script,style,noscript,svg,nav,footer")) junk.remove();
  const main = document.querySelector("main,article,[role=main]");
  const source = main ? main.cloneNode(true) : clone;
  for (const junk of source.querySelectorAll?.("script,style,noscript") ?? []) junk.remove();
  const text = (source.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return { url: location.href, title: document.title, text: text.slice(0, 24000) };
})()`;

// ── shaping what comes back ────────────────────────────────────────────

export interface ScanNode {
  ref: string;
  role: string;
  name: string;
  disabled?: boolean;
  checked?: boolean;
  value?: string;
}

/**
 * The snapshot an agent reads.
 *
 * One line per control, shortest form that stays unambiguous. Unnamed
 * controls are kept rather than dropped: an unlabelled icon button is
 * often the one the task needs, and "button" with a ref is still
 * something the agent can try.
 */
export function formatSnapshot(scan: { url: string; title: string; nodes: ScanNode[] }): string {
  const lines = scan.nodes.map((node) => {
    const bits = [`@${node.ref}`, node.role];
    if (node.name) bits.push(JSON.stringify(node.name));
    if (node.value) bits.push(`value=${JSON.stringify(node.value)}`);
    if (node.checked !== undefined) bits.push(node.checked ? "checked" : "unchecked");
    if (node.disabled) bits.push("disabled");
    return "  " + bits.join(" ");
  });
  return [
    `${scan.title || "(untitled)"} — ${scan.url}`,
    lines.length ? `${lines.length} controls:` : "no controls found on this page",
    ...lines,
  ].join("\n");
}
