// A file through Bloks Cloud, in parts.
//
// One answer through the relay carries about a megabyte of a file that
// does not compress, and a photo or a PDF is often more. So a client that
// says it can (`parts: true` on a raw ask) is answered a part at a time
// by the other computer (server/relay-link.ts, servePart), each part an
// ordinary ask and answer, and this puts them back together: it asks for
// the first, then each of the rest by number and by the tag the first
// one carried, and joins them in order.
//
// Nothing here knows how an ask travels or how an answer is opened, so
// the same loop serves the desktop app's stand-in server (remote.mjs),
// where the parts become one Buffer, and a browser, where they can become
// one Blob. No imports, on purpose.

/** The most the other computer sends of one file in parts (its
 * RAW_PARTS_MAX_BYTES). A first part that says more is not believed. */
export const RAW_PARTS_MAX_BYTES = 50 * 1024 * 1024;

const encoder = new TextEncoder();

/** An answer this loop makes itself, in the shape of one from the other
 * computer, so whoever asked shows it the same way. */
function refusal(status, error) {
  return { status, type: "application/json", bytes: encoder.encode(JSON.stringify({ error })) };
}

/** Whether an answer is a part, with everything a part has to say. */
function isPart(answer) {
  return (
    answer?.status === 200 &&
    Number.isSafeInteger(answer.size) &&
    answer.size >= 0 &&
    Number.isSafeInteger(answer.parts) &&
    answer.parts >= 1 &&
    Number.isSafeInteger(answer.part) &&
    typeof answer.tag === "string" &&
    answer.bytes != null
  );
}

/** Whether an answer carries any of what a part says about itself, so
 * it is read as a part, and has to be a whole one. */
function saysPart(answer) {
  return answer.size !== undefined || answer.parts !== undefined || answer.part !== undefined || answer.tag !== undefined;
}

const UNFIT = "the file came back in parts that do not fit together. Open it again.";

/** Parts as one run of bytes, for a caller that wants them that way. */
function joinBytes(pieces) {
  let length = 0;
  for (const piece of pieces) length += piece.byteLength;
  const whole = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) {
    whole.set(piece, at);
    at += piece.byteLength;
  }
  return whole;
}

/**
 * The whole answer to a raw ask, from as many parts as it came in.
 *
 * `askPart(part, tag)` asks for one part (0 and no tag for the first) and
 * resolves to `{ status, type, bytes }`, with `size`, `parts`, `part` and
 * `tag` when the answer is a part. An answer that is not a part (a 404, a
 * refusal, or anything from a computer too old to send parts) is handed
 * back as it came, and so is a part that is the whole. Otherwise the rest
 * are asked for in order, and the first answer that is not the next part
 * of the same file ends it: a refusal from the other computer as it came
 * (412 when the file changed meanwhile), or one made here when the parts
 * do not add up. `join(pieces, type)` makes the bytes of the whole; by
 * default one Uint8Array. `gone()` stops asking once nobody is waiting.
 */
export async function gatherParts(askPart, { join = joinBytes, gone = () => false, maxBytes = RAW_PARTS_MAX_BYTES } = {}) {
  const first = await askPart(0);
  // A refusal, or an answer with nothing of a part about it (a computer
  // too old to send parts, a read that was never cut up), is handed back
  // as it came. One that says it is a part is held to it, a part of one
  // included: that shortcut once returned whatever size and bytes it
  // claimed, unread (GitHub 371).
  if (first?.status !== 200 || !saysPart(first)) return first;
  if (!isPart(first) || first.part !== 0) return refusal(502, UNFIT);
  const { size, parts, tag } = first;
  // what the first part says has to hold together before anything more
  // is asked for: no more than the most there can be, and as many parts
  // as the first one's length makes of the whole
  if (size > maxBytes) return refusal(413, "too large to open through Bloks Cloud");
  if (parts === 1) return first.bytes.byteLength === size ? first : refusal(502, UNFIT);
  const length = first.bytes.byteLength;
  if (!length || Math.ceil(size / length) !== parts) return refusal(502, UNFIT);
  const pieces = [first.bytes];
  let have = length;
  for (let part = 1; part < parts; part++) {
    if (gone()) return refusal(499, "nobody was waiting for the rest of the file");
    const next = await askPart(part, tag);
    // a refusal is the other computer's to word; anything else that is
    // not the next part is not something to join to this one
    if (!isPart(next) && next?.status !== 200) return next;
    if (!isPart(next) || next.part !== part || next.tag !== tag || next.size !== size || next.parts !== parts) {
      return refusal(502, UNFIT);
    }
    pieces.push(next.bytes);
    have += next.bytes.byteLength;
  }
  if (have !== size) return refusal(502, UNFIT);
  return { status: first.status, type: first.type, bytes: join(pieces, first.type), size };
}
