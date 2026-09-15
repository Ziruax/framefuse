/**
 * Text helpers for filename-encoded storyboards (v4.9).
 *
 * Storyboard filenames are long and front-load the timing metadata
 * (`007__Beat_7_27s_SCENE_CUT_TO_ROMA_...jpg`) while the unique
 * differentiator often sits at the END (location, character, camera).
 * End-truncation hides exactly the wrong half — these helpers keep
 * both ends readable.
 */

/** v4.5 (moved to lib in v4.9): middle-ellipsis — keeps the head AND the
 *  tail of a long name. Head-biased 55/45 so timing prefixes survive. */
export function middleEllipsis(name: string, max = 42): string {
  if (name.length <= max) return name;
  const keep = max - 1; // room for the ellipsis char
  const head = Math.ceil(keep * 0.55);
  const tail = Math.floor(keep * 0.45);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

/**
 * v4.9: split a name into a flex-truncation pair for UI rows.
 *
 * Render as:
 *   <span class="flex overflow-hidden">
 *     <span class="min-w-0 flex-1 truncate">{head}</span>
 *     <span class="shrink-0">{tail}</span>
 *   </span>
 *
 * The browser then truncates ONLY the head responsively (ellipsis in the
 * middle of the row) while the tail — extension + unique suffix — is
 * always fully visible. Names short enough to never split in a row are
 * returned with tail = "" so callers can render a plain truncate span.
 */
export function splitMiddle(
  name: string,
  minSplit = 30,
  tailLen = 11,
): { head: string; tail: string } {
  if (name.length <= minSplit) return { head: name, tail: "" };
  // Never split inside a short extension like ".jpg" (up to 5 chars).
  const safeTail = Math.min(tailLen, Math.floor((name.length - 4) / 2) + 4);
  return {
    head: name.slice(0, name.length - safeTail),
    tail: name.slice(name.length - safeTail),
  };
}
