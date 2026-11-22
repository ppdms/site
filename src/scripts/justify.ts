/*
 * Paragraph-wide line breaking for justified text.
 *
 * Browsers break lines one at a time: each line takes as many words as fit,
 * and justification stretches whatever room is left. A line followed by a
 * long word ends up with gaps three or four times the normal space. TeX
 * instead chooses every break in a paragraph together (Knuth and Plass,
 * "Breaking Paragraphs into Lines", 1981): it would rather make one line a
 * little loose, or a little tight, than the next one very loose.
 *
 * This does the same over the rendered page. It measures each word and space
 * of a justified paragraph in place, chooses the breaks that keep the spacing
 * closest to normal over the whole paragraph, and then leaves a break
 * opportunity only at those breaks: every other space becomes a no-break
 * space. The browser still lays out and justifies the text, but it can break
 * only where the paragraph was planned to.
 *
 * Words are never divided: lines break at spaces, and after a dash, never
 * inside a word or after the hyphen of a compound such as "self-hosted".
 *
 * CSS justification can only widen spaces. To let a line also tighten a
 * little, as TeX's do, the paragraph's spaces are set slightly narrow (to
 * SHRINK of normal) and justification widens them back; the last line,
 * which is not justified, keeps normal spaces.
 *
 * It runs only where the stylesheet asks for justified text (not on phones),
 * after the web fonts have loaded, and again when a paragraph changes width.
 * Until it has run, the page is held back (html.jt-pending), so it is never
 * seen in a fallback font or with the browser's own line breaks.
 * A paragraph that does not come out as planned is put back as it was.
 * Without script, the text is simply justified by the browser.
 */

const NBSP = " ";
const WORD_JOINER = "⁠";
const SPACE = /[ \t\n\r\f]/;
const DASHES = /[–—]/;
// Inside a word the browser could break after these; a word joiner stops it.
const JOINED_AFTER = /[-‐/]/;
// Paragraphs holding anything but inline text are left to the browser.
const NOT_INLINE =
  "br, img, svg, picture, video, iframe, input, textarea, math, p, div, ul, ol, pre, blockquote, table, figure";
const TOLERANCE = 1; // px kept free on every line, against rounding

// Spaces may tighten to 85% of normal (InDesign allows 80%).
const SHRINK = 0.85;
const DASH_PENALTY = 25;
const LONELY_LAST_WORD_DEMERITS = 2500;

/** A place a line may end. */
interface Candidate {
  kind: "space" | "dash";
  /** For a space, each character of its whitespace run; after a dash, the
      position the break comes before. */
  chars: { node: Text; index: number }[];
  /** Natural width of the space; zero after a dash. */
  width: number;
  left: number;
  right: number;
}

interface Plan {
  element: HTMLElement;
  nodes: Text[];
  candidates: Candidate[];
  /** Width of the text between consecutive candidates: one more than them. */
  pieces: number[];
  /** A typical space in this paragraph, and how much each may tighten. */
  space: number;
  shrink: number;
  measure: number;
}

const originals = new Map<HTMLElement, Node>();
const plannedLines = new WeakMap<HTMLElement, number>();

function textNodes(element: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

function restore(element: HTMLElement) {
  const pristine = originals.get(element);
  if (!pristine) return;
  element.replaceChildren(...pristine.cloneNode(true).childNodes);
  originals.delete(element);
  for (const property of ["text-wrap", "word-spacing"]) element.style.removeProperty(property);
  element.removeAttribute("data-justified");
}

function candidate(kind: Candidate["kind"], node: Text, index: number): Candidate {
  return { kind, chars: [{ node, index }], width: 0, left: 0, right: 0 };
}

/** Every place a line may end, in reading order. */
function findCandidates(nodes: Text[]): Candidate[] {
  const candidates: Candidate[] = [];
  let run: Candidate | null = null;
  let previous = "";
  for (const node of nodes) {
    for (let index = 0; index < node.data.length; index++) {
      const char = node.data[index];
      if (SPACE.test(char)) {
        // Whitespace before the first word collapses away.
        if (previous === "") continue;
        if (!run) {
          run = candidate("space", node, index);
        } else {
          run.chars.push({ node, index });
        }
        continue;
      }
      if (run) {
        candidates.push(run);
        run = null;
      } else if (DASHES.test(previous) && index > 0) {
        candidates.push(candidate("dash", node, index));
      }
      previous = char;
    }
  }
  // Whitespace after the last word collapses away too, so a trailing run
  // is never pushed.
  return candidates;
}

function span(range: Range): [number, number] | null {
  let left = Infinity;
  let right = -Infinity;
  for (const rect of range.getClientRects()) {
    if (rect.width === 0) continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  return left === Infinity ? null : [left, right];
}

/** Measures a paragraph while it is laid out on a single line. */
function measure(element: HTMLElement): Plan | null {
  const nodes = textNodes(element);
  const candidates = findCandidates(nodes);
  if (candidates.filter((c) => c.kind === "space").length < 4) return null;

  const style = getComputedStyle(element);
  const measureWidth =
    element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - TOLERANCE;
  const range = document.createRange();
  const start = element.getBoundingClientRect().left + element.clientLeft + parseFloat(style.paddingLeft);
  range.selectNodeContents(element);
  const end = range.getBoundingClientRect().right;

  for (const c of candidates) {
    if (c.kind === "space") {
      const first = c.chars[0];
      const last = c.chars[c.chars.length - 1];
      range.setStart(first.node, first.index);
      range.setEnd(last.node, last.index + 1);
      const edges = span(range);
      if (!edges) return null;
      [c.left, c.right] = edges;
      c.width = edges[1] - edges[0];
    } else {
      // The boundary is the right edge of the dash before it.
      const { node, index } = c.chars[0];
      range.setStart(node, index - 1);
      range.setEnd(node, index);
      const edges = span(range);
      if (!edges) return null;
      c.left = c.right = edges[1];
    }
  }

  const pieces: number[] = [];
  for (let i = 0; i <= candidates.length; i++) {
    const from = i === 0 ? start : candidates[i - 1].right;
    const to = i === candidates.length ? end : candidates[i].left;
    pieces.push(to - from);
  }

  const spaces = candidates
    .filter((c) => c.kind === "space")
    .map((c) => c.width)
    .sort((a, b) => a - b);
  const space = spaces[Math.floor(spaces.length / 2)];

  return { element, nodes, candidates, pieces, space, shrink: space * (1 - SHRINK), measure: measureWidth };
}

/**
 * Chooses breaks for the whole paragraph. Justification adds the same room
 * to every space on a line; a line's badness grows with the cube of how far
 * its spaces end up from normal, measured against how far they may stretch
 * (a whole space) or tighten (SHRINK). The paragraph minimises the sum of
 * each line's squared demerits. The last line is set ragged with normal
 * spaces; a last line of one short word is discouraged. Returns the indices
 * of the chosen candidates.
 */
function chooseBreaks(plan: Plan): number[] | null {
  const { candidates, pieces, space, shrink, measure } = plan;
  const last = pieces.length - 1;
  // best[j]: least demerits for setting pieces 0..j with a line ending after
  // piece j; from[j]: the first piece of that line.
  const best = new Array<number>(pieces.length).fill(Infinity);
  const from = new Array<number>(pieces.length).fill(-1);

  for (let j = 0; j <= last; j++) {
    const ending = j === last ? null : candidates[j];
    let tight = pieces[j]; // spaces tightened
    let natural = tight; // spaces normal
    let gaps = 0;

    for (let i = j; i >= 0; i--) {
      if (i < j) {
        natural += pieces[i] + candidates[i].width;
        tight += pieces[i] + Math.max(0, candidates[i].width - shrink);
        if (candidates[i].kind === "space") gaps++;
      }
      if (tight > measure) break;
      const prior = i === 0 ? 0 : best[i - 1];
      if (prior === Infinity) continue;

      let demerits: number;
      if (!ending) {
        if (natural > measure) continue;
        const lonely = i === j && i > 0 && natural < measure * 0.15;
        demerits = lonely ? LONELY_LAST_WORD_DEMERITS : 0;
      } else {
        let badness = 10000;
        if (gaps > 0) {
          // How far each space ends up from normal, in spaces.
          const deviation = ((measure - tight) / gaps - shrink) / space;
          const ratio = deviation >= 0 ? deviation : -deviation / (1 - SHRINK);
          badness = Math.min(100 * ratio ** 3, 10000);
        }
        demerits = (10 + badness) ** 2;
        if (ending.kind === "dash") demerits += DASH_PENALTY ** 2;
      }

      if (prior + demerits < best[j]) {
        best[j] = prior + demerits;
        from[j] = i;
      }
    }
  }
  if (best[last] === Infinity) return null;

  const breaks: number[] = [];
  for (let j = last; from[j] > 0; j = from[j] - 1) breaks.unshift(from[j] - 1);
  return breaks;
}

function apply(plan: Plan, breaks: number[]) {
  originals.set(plan.element, plan.element.cloneNode(true));

  const chars = new Map<Text, string[]>();
  // Positions are UTF-16 indices, which split("") preserves.
  for (const node of plan.nodes) chars.set(node, node.data.split(""));
  const set = (node: Text, index: number, value: string) => {
    chars.get(node)![index] = value;
  };
  const append = (node: Text, index: number, value: string) => {
    chars.get(node)![index] += value;
  };

  const chosen = new Set(breaks);
  const lastBreak = breaks.length ? breaks[breaks.length - 1] : -1;
  const lastLineSpaces: { node: Text; index: number }[] = [];

  plan.candidates.forEach((c, index) => {
    const take = chosen.has(index);
    if (c.kind === "space") {
      c.chars.forEach((ch, k) => set(ch.node, ch.index, k > 0 ? "" : take ? " " : NBSP));
      if (index > lastBreak && breaks.length) lastLineSpaces.push(c.chars[0]);
    } else if (!take) {
      // A dash the plan does not break after stays joined to what follows.
      const { node, index: at } = c.chars[0];
      append(node, at - 1, WORD_JOINER);
    }
  });

  // Hyphens and slashes inside words stay joined: "self-hosted", "TCP/IP".
  for (const node of plan.nodes) {
    for (let i = 0; i < node.data.length - 1; i++) {
      if (JOINED_AFTER.test(node.data[i]) && !SPACE.test(node.data[i + 1])) append(node, i, WORD_JOINER);
    }
  }

  // Where each original position ends up once the text is rewritten.
  const shifted = (node: Text, index: number) => chars.get(node)!.slice(0, index).join("").length;
  const wraps = new Map<Text, number[]>();
  for (const { node, index } of lastLineSpaces) {
    const list = wraps.get(node) ?? [];
    list.push(shifted(node, index));
    wraps.set(node, list);
  }
  for (const node of plan.nodes) node.data = chars.get(node)!.join("");

  if (breaks.length) {
    plan.element.style.setProperty("word-spacing", `${-plan.shrink.toFixed(2)}px`);
    // The last line is not justified, so its spaces go back to normal.
    for (const [node, positions] of wraps) {
      for (const position of positions.sort((a, b) => b - a)) {
        const space = node.splitText(position);
        space.splitText(1);
        const wrapper = document.createElement("span");
        wrapper.style.wordSpacing = "normal";
        space.replaceWith(wrapper);
        wrapper.append(space);
      }
    }
  }

  plannedLines.set(plan.element, breaks.length + 1);
  plan.element.style.setProperty("text-wrap", "wrap");
  plan.element.setAttribute("data-justified", "");
}

function lineCount(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return Math.round(height / parseFloat(style.lineHeight));
}

function justifiable(element: HTMLElement): boolean {
  return getComputedStyle(element).textAlign === "justify" && !element.querySelector(NOT_INLINE);
}

/** Sets a group of paragraphs: measures them all, then changes them all. */
function run(elements: HTMLElement[]) {
  for (const element of elements) restore(element);
  const targets = elements.filter(justifiable);
  if (!targets.length) return;

  for (const element of targets) {
    element.style.setProperty("white-space", "nowrap");
    element.style.setProperty("text-align", "left");
  }
  const plans = targets.map((element) => measure(element));
  for (const element of targets) {
    element.style.removeProperty("white-space");
    element.style.removeProperty("text-align");
  }

  const changed: HTMLElement[] = [];
  for (const plan of plans) {
    if (!plan) continue;
    const breaks = chooseBreaks(plan);
    if (!breaks) continue;
    apply(plan, breaks);
    changed.push(plan.element);
  }
  // Anything that did not land on the planned lines goes back as it was.
  for (const element of changed) {
    if (lineCount(element) !== plannedLines.get(element)) restore(element);
  }
}

/** Copies text as written: ordinary spaces, no joiners. */
function clean(text: string): string {
  return text.replace(/ /g, " ").replace(/⁠/g, "");
}

function onCopy(event: ClipboardEvent) {
  const selection = getSelection();
  if (!selection?.rangeCount || !event.clipboardData) return;
  const range = selection.getRangeAt(0);
  const within = [...originals.keys()].some((element) => range.intersectsNode(element));
  if (!within) return;
  const fragment = range.cloneContents();
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    node.data = clean(node.data);
  }
  const holder = document.createElement("div");
  holder.append(fragment);
  event.clipboardData.setData("text/html", holder.innerHTML);
  event.clipboardData.setData("text/plain", clean(selection.toString()));
  event.preventDefault();
}

/** Shows the page, which the stylesheet holds back until its fonts are in
    and its justified paragraphs set, so it appears once, complete. */
function reveal() {
  document.documentElement.classList.remove("jt-pending");
  performance.mark("page-revealed");
}

export async function justify(root: ParentNode = document) {
  try {
    await setUp(root);
  } finally {
    reveal();
  }
}

async function setUp(root: ParentNode) {
  const elements = [...root.querySelectorAll<HTMLElement>("main p, main li")];
  if (!elements.some((element) => getComputedStyle(element).textAlign === "justify")) {
    // A phone held sideways, or a window made wider, may justify later.
    const query = matchMedia("(min-width: 48em)");
    if (!query.matches) query.addEventListener("change", () => setUp(root), { once: true });
    return;
  }

  await document.fonts.ready;
  run(elements);

  const widths = new WeakMap<Element, number>();
  let pending = new Set<HTMLElement>();
  let frame = 0;
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const width = entry.contentRect.width;
      const known = widths.get(entry.target);
      widths.set(entry.target, width);
      if (known !== undefined && known !== width) pending.add(entry.target as HTMLElement);
    }
    if (pending.size && !frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        const batch = [...pending];
        pending = new Set();
        run(batch);
      });
    }
  });
  for (const element of elements) observer.observe(element);

  document.addEventListener("copy", onCopy);
  // A printed page has its own width; the browser breaks the text there.
  addEventListener("beforeprint", () => {
    for (const element of [...originals.keys()]) restore(element);
  });
  addEventListener("afterprint", () => run(elements));
}
