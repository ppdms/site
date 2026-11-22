import type { Photo } from "./types";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function galleryLabel(photo: Photo): { title: string; meta: string } {
  let title = photo.id.slice(0, 6).toUpperCase();
  const dateText = photo.exif?.Date;
  if (dateText) {
    const date = new Date(dateText);
    if (!Number.isNaN(date.getTime())) {
      const calendar = /^(\d{4})-(\d{2})-\d{2}/.exec(dateText);
      const month = calendar ? Number(calendar[2]) - 1 : date.getUTCMonth();
      title = `${months[month]} ${calendar?.[1] ?? date.getUTCFullYear()}`;
    }
  }

  const tags = photo.exif?.Tags;
  const settings: string[] = [];
  if (tags?.FocalLengthIn35mmFormat) settings.push(`${tags.FocalLengthIn35mmFormat}mm`);
  if (tags?.FNumber !== undefined) {
    const [numerator, denominator] = String(tags.FNumber).split("/").map(Number);
    const aperture = denominator ? numerator / denominator : numerator;
    if (Number.isFinite(aperture)) settings.push(`f/${aperture.toFixed(1)}`);
  }
  if (tags?.ISO) settings.push(`ISO ${tags.ISO}`);
  return { title, meta: settings.join(" / ") };
}
