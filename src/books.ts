import type { Recommendation } from "./types.js";

type GoogleVolume = {
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publishedDate?: string;
    description?: string;
    imageLinks?: Record<string, string | undefined>;
    seriesInfo?: { volumeSeries?: Array<{ seriesId?: string; seriesTitle?: string; orderNumber?: number }> };
  };
};

export interface GoogleBookDetails {
  title: string;
  authors: string[];
  year: string | null;
  description: string | null;
  coverUrl: string | null;
  series: string | null;
}

export function hasGoogleBooksApiKey(): boolean {
  return Boolean(process.env.GOOGLE_BOOKS_API_KEY || process.env.GOOGLE_BOOKS_API || process.env.Google_Books_API);
}

function normalizeTitle(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeDescription(value: string | undefined): string | null {
  if (!value) return null;
  const text = value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  return text || null;
}

export async function getGoogleBookDetails(item: Recommendation): Promise<GoogleBookDetails | null> {
  if (item.category !== "book") return null;
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY || process.env.GOOGLE_BOOKS_API || process.env.Google_Books_API;
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `intitle:${item.title}`);
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("printType", "books");
  if (apiKey) url.searchParams.set("key", apiKey);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const data = await response.json() as { items?: GoogleVolume[] };
    const wanted = normalizeTitle(item.title);
    const info = (data.items || []).find(volume => volume.volumeInfo?.title && normalizeTitle(volume.volumeInfo.title) === wanted)?.volumeInfo;
    if (!info) return null;

    const seriesEntry = info.seriesInfo?.volumeSeries?.[0];
    const cover = info.imageLinks?.large || info.imageLinks?.medium || info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail;
    return {
      title: info.title || item.title,
      authors: info.authors || [],
      year: info.publishedDate?.slice(0, 4) || null,
      description: normalizeDescription(info.description),
      coverUrl: cover ? cover.replace(/^http:\/\//i, "https://") : null,
      series: seriesEntry
        ? (seriesEntry.seriesTitle || (seriesEntry.orderNumber ? `Серия (книга ${seriesEntry.orderNumber})` : "Серия"))
        : null
    };
  } catch {
    return null;
  }
}

async function lookupBook(item: Recommendation): Promise<Recommendation> {
  const details = await getGoogleBookDetails(item);
  if (!details) return item;
  return {
    ...item,
    author: item.author || details.authors.join(", ") || null,
    year: item.year || (details.year && /^\d{4}$/.test(details.year) ? Number(details.year) : null),
    series: details.series || item.series
  };
}

export async function enrichBookRecommendations(items: Recommendation[]): Promise<Recommendation[]> {
  return Promise.all(items.map(item => item.category === "book" ? lookupBook(item) : item));
}
