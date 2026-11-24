import type { Recommendation } from "./types.js";

export interface TmdbMediaDetails {
  category: "movie" | "series";
  title: string;
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

async function searchExact(
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
  const wanted = normalizeTitle(item.title);
  const exact = (data.results || []).filter(result => {
    const names = [result.title, result.original_title, result.name, result.original_name].filter(Boolean) as string[];
    return names.some(name => normalizeTitle(name) === wanted);
  });
  if (!exact.length) return null;

  return exact.sort((a, b) => {
    const dateA = kind === "movie" ? a.release_date : a.first_air_date;
    const dateB = kind === "movie" ? b.release_date : b.first_air_date;
    const yearA = dateA ? Number(dateA.slice(0, 4)) : 0;
    const yearB = dateB ? Number(dateB.slice(0, 4)) : 0;
    const yearPenaltyA = item.year && yearA && yearA !== item.year ? 1 : 0;
    const yearPenaltyB = item.year && yearB && yearB !== item.year ? 1 : 0;
    return yearPenaltyA - yearPenaltyB || (b.popularity || 0) - (a.popularity || 0);
  })[0];
}

export async function getTmdbDetails(item: Recommendation): Promise<TmdbMediaDetails | null> {
  const token = process.env.TMDB_API_TOKEN;
  if (!token) throw new Error("TMDB_TOKEN_MISSING");
  if (item.category !== "movie" && item.category !== "series" && item.category !== "watched") return null;

  const expectedKind = item.category === "series" ? "tv" : "movie";
  const otherKind = expectedKind === "movie" ? "tv" : "movie";
  const matched = item.category === "watched" ? null : await searchExact(expectedKind, item, token);
  const result = matched || await searchExact(otherKind, item, token) || (item.category === "watched" ? await searchExact(expectedKind, item, token) : null);
  if (!result) return null;

  const resultIsMovie = Boolean(result.title || result.original_title);
  const actualCategory: "movie" | "series" = item.category === "watched"
    ? (resultIsMovie ? "movie" : "series")
    : matched
      ? (item.category === "movie" ? "movie" : "series")
      : (otherKind === "movie" ? "movie" : "series");
  const title = result.title || result.name || item.title;
  const date = actualCategory === "movie" ? result.release_date : result.first_air_date;
  return {
    category: actualCategory,
    title,
    year: date?.slice(0, 4) || null,
    overview: result.overview?.trim() || "Описание пока недоступно.",
    posterUrl: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null
  };
}
