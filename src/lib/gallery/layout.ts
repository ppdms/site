/** Choose justified rows with photo areas close to a common target. */
export function computePhotoRows(
  aspects: readonly number[],
  width: number,
  gap: number,
  options: { targetArea: number; maxPhotos: number }
): { start: number; end: number; height: number }[] {
  if (!aspects.length || width <= 0) return [];

  const choices = new Array<{ end: number; height: number; cost: number }>(aspects.length);
  for (let start = aspects.length - 1; start >= 0; start--) {
    let totalAspect = 0;
    let bestCost = Infinity;
    for (let end = start + 1; end <= Math.min(aspects.length, start + options.maxPhotos); end++) {
      totalAspect += aspects[end - 1];
      const space = width - gap * (end - start - 1);
      if (space <= 0) break;
      const height = space / totalAspect;
      let cost = end === aspects.length ? 0 : choices[end].cost;
      for (let i = start; i < end; i++) {
        const distance = Math.log((height * height * aspects[i]) / options.targetArea);
        cost += distance * distance;
      }
      if (cost < bestCost) {
        bestCost = cost;
        choices[start] = { end, height, cost };
      }
    }
  }

  const rows: { start: number; end: number; height: number }[] = [];
  for (let start = 0; start < aspects.length;) {
    const { end, height } = choices[start];
    rows.push({ start, end, height });
    start = end;
  }
  return rows;
}

export const CAPTION_HEIGHT = 48;

/** Position uncropped images and captions, without any simulated paper frame. */
export function computeLayout(
  photos: readonly { width: number; height: number }[],
  width: number,
  viewportWidth: number
): { items: { top: number; left: number; width: number; height: number }[]; height: number } {
  if (!photos.length || width <= 0) return { items: [], height: 0 };

  const gap = viewportWidth <= 480 ? 18 : Math.max(28, Math.min(54, Math.round(viewportWidth * 0.026)));
  const aspects = photos.map((photo) => photo.width / photo.height);
  const target = Math.min(420, width / 2);
  const rows = computePhotoRows(aspects, width, gap, {
    targetArea: target * target,
    maxPhotos: Math.max(1, Math.min(3, Math.round((width + gap) / (240 + gap)))),
  });
  const items: { top: number; left: number; width: number; height: number }[] = [];
  let top = 0;

  for (const row of rows) {
    let left = 0;
    let ideal = 0;
    let previous = 0;
    const height = Math.max(1, Math.round(row.height));
    for (let i = row.start; i < row.end; i++) {
      ideal += row.height * aspects[i];
      const edge = Math.round(ideal);
      const itemWidth = edge - previous;
      items.push({ top, left, width: itemWidth, height: height + CAPTION_HEIGHT });
      left += itemWidth + gap;
      previous = edge;
    }
    top += height + CAPTION_HEIGHT + gap;
  }
  return { items, height: top - gap };
}
