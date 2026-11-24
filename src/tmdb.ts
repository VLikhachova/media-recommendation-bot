import type { Recommendation } from "./types.js";

export interface TmdbMediaDetails {
  category: "movie" | "series";
  title: string;
  originalTitle: string | null;
  year: string | null;
  overview: string;
  posterUrl: string | null;
}

interface TmdbSearchResult {
  id: number;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
  poster_path?: string | null;
}

function normalizeTitle(title: string): string {
  return title.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

function titleVariants(title: string): string[] {
  return [...new Set(title.split(/[\/|\n]+/).map(value => value.trim()).filter(Boolean))];
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function matchScore(title: string, result: TmdbSearchResult): number {
  const wanted = titleVariants(title).map(normalizeTitle).filter(Boolean);
  const names = [result.title, result.original_title, result.name, result.original_name]
    .filter((name): name is string => Boolean(name)).map(normalizeTitle);
  return Math.max(0, ...wanted.flatMap(query => names.map(name => similarity(query, name))));
}

async function searchBest(
  kind: "movie" | "tv",
  item: Recommendation,
  token: string
): Promise<TmdbSearchResult | null> {
  const url = new URL(`https://api.themoviedb.org/3/search/${kind}`);
  url.searchParams.set("query", item.title);
  url.searchParams.set("language", "ru-RU");
  if (item.year) url.searchParams.set(kind === "movie" ? "year" : "first_air_date_year", String(item.year));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error("TMDB_REQUEST_FAILED");
  const data = await response.json() as { results?: TmdbSearchResult[] };
  const ranked = (data.results || []).map(result => {
    const score = matchScore(item.title, result);
    const date = kind === "movie" ? result.release_date : result.first_air_date;
    const year = date ? Number(date.slice(0, 4)) : 0;
    const yearBonus = item.year && year === item.year ? 0.08 : 0;
    return { result, score: Math.min(1, score + yearBonus), popularity: result.popularity || 0 };
  }).filter(entry => entry.score >= 0.76)
    .sort((a, b) => b.score - a.score || b.popularity - a.popularity);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < 0.035 && ranked[0].score < 0.96) return null;
  return ranked[0].result;
}

export async function getTmdbDetails(item: Recommendation): Promise<TmdbMediaDetails | null> {
  const token = process.env.TMDB_API_TOKEN || process.env.TMDB_APPI_TOKEN;
  if (!token) throw new Error("TMDB_TOKEN_MISSING");
  if (item.category !== "movie" && item.category !== "series" && item.category !== "watched") return null;

  const expectedKind = item.category === "series" ? "tv" : "movie";
  const otherKind = expectedKind === "movie" ? "tv" : "movie";
  const matched = item.category === "watched" ? null : await searchBest(expectedKind, item, token);
  const result = matched || await searchBest(otherKind, item, token) || (item.category === "watched" ? await searchBest(expectedKind, item, token) : null);
  if (!result) return null;

  const resultIsMovie = Boolean(result.title || result.original_title);
  const actualCategory: "movie" | "series" = item.category === "watched"
    ? (resultIsMovie ? "movie" : "series")
    : matched
      ? (item.category === "movie" ? "movie" : "series")
      : (otherKind === "movie" ? "movie" : "series");
  const title = result.title || result.name || item.title;
  const originalTitle = result.original_title || result.original_name || null;
  const date = actualCategory === "movie" ? result.release_date : result.first_air_date;
  return {
    category: actualCategory,
    title,
    originalTitle: originalTitle && normalizeTitle(originalTitle) !== normalizeTitle(title) ? originalTitle : null,
    year: date?.slice(0, 4) || null,
    overview: result.overview?.trim() || "Описание пока недоступно.",
    posterUrl: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null
  };
}

export async function enrichMediaRecommendations(items: Recommendation[]): Promise<Recommendation[]> {
  return Promise.all(items.map(async item => {
    if (item.category !== "movie" && item.category !== "series") return item;
    try {
      const details = await getTmdbDetails(item);
      if (!details) return item;
      const title = details.originalTitle ? `${details.title} (${details.originalTitle})` : details.title;
      return {
        ...item,
        category: details.category,
        title,
        year: item.year || (details.year && /^\d{4}$/.test(details.year) ? Number(details.year) : null)
      };
    } catch {
      return item;
    }
  }));
}
