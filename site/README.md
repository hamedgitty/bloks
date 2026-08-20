# bloks.dev

The landing page. One self-contained HTML file, two images, no build step and no
dependencies. Open `index.html` in a browser and that is the site.

## Running it

```bash
open site/index.html          # or any static server
npx serve site
```

Icon paths are relative on purpose, so the page works opened straight off disk as well
as deployed at a domain root.

## Deploying

Cloudflare Pages, on the domain that is already registered there.

- Build command: none
- Build output directory: `site`

That is the whole configuration. Nothing here is generated, so there is no build to
break and nothing to keep in sync.

## Two things to know before touching it

**The scroll animation is compositor driven.** The opening and the belief section run on
CSS scroll-driven animations (`view-timeline-name` + `animation-timeline`), not on
scroll listeners. Anything that reads layout per frame will make the page stutter, which
is exactly the bug the current version was rewritten to fix. There is one small script
that measures on load and on resize only, and it says so in a comment.

**The claims are checked against the source.** Agent names, message kinds, model labels
and the engine list were all verified against `server/` and `src/` rather than written
from memory. Several earlier drafts were confidently wrong. If you change a claim here,
check it against the code first.

## Before this goes live

The page links to the repository, the licence, the security policy and the latest
release. All four are 404 until the repository is public and a release is tagged.

The signup block is a link to GitHub releases rather than an email form, because the
form it replaced collected addresses and threw them away. Wire a real list (Buttondown,
Kit) before restoring an inline form.
