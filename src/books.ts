import type { Recommendation } from "./types.js";

type GoogleVolume = {
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publishedDate?: string;
    seriesInfo?: { volumeSeries?: Array<{ seriesId?: string; seriesTitle?: string; orderNumber?: number }> };
  };
};

function normalizeTitle(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

async function lookupBook(item: Recommendation): Promise<Recommendation> {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `intitle:${item.title}`);
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("printType", "books");
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return item;
    const data = await response.json() as { items?: GoogleVolume[] };
    const wanted = normalizeTitle(item.title);
    const match = (data.items || []).find(volume => volume.volumeInfo?.title && normalizeTitle(volume.volumeInfo.title) === wanted);
    const info = match?.volumeInfo;
    if (!info) return item;
    const publishedYear = Number(info.publishedDate?.slice(0, 4));
    const seriesEntry = info.seriesInfo?.volumeSeries?.[0];
    const series = seriesEntry
      ? (seriesEntry.seriesTitle || (seriesEntry.orderNumber ? `Серия (книга ${seriesEntry.orderNumber})` : "Серия"))
      : item.series;
    return {
      ...item,
      author: item.author || info.authors?.join(", ") || null,
      year: item.year || (Number.isInteger(publishedYear) && publishedYear > 0 ? publishedYear : null),
      series: series || null
    };
  } catch {
    return item;
  }
}

export async function enrichBookRecommendations(items: Recommendation[]): Promise<Recommendation[]> {
  return Promise.all(items.map(item => item.category === "book" ? lookupBook(item) : item));
}
