import "dotenv/config";
import { createHash } from "node:crypto";
import { Telegraf, Markup } from "telegraf";
import { extractRecommendations, extractRecommendationsFromImages } from "./extractor.js";
import { extractUrl, extractUrls, getLinkPreview } from "./link-preview.js";
import {
  createCategory, deleteRecommendation, getByCategory, getByListNumber, getCategories,
  getById, getCategory, getCategoryByLabel, getRandom, markWatched, moveToWatched, renameCategory,
  importLocalBackup, saveRecommendations, searchMedia, searchRecommendations, setCategoryActive, updateCategory, updateRecommendationTitle
} from "./database.js";
import type { Category, Recommendation } from "./types.js";
import { getTmdbDetails } from "./tmdb.js";
import { enrichBookRecommendations } from "./books.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Не задан TELEGRAM_BOT_TOKEN в .env");
if (!process.env.OPENAI_API_KEY) throw new Error("Не задан OPENAI_API_KEY в .env");
if (!process.env.TELEGRAM_USER_ID) throw new Error("Не задан TELEGRAM_USER_ID в .env");

const allowedUserId = Number(process.env.TELEGRAM_USER_ID);
if (!Number.isSafeInteger(allowedUserId)) throw new Error("TELEGRAM_USER_ID должен быть числом");

let pendingCategoryInput: { action: "add" } | { action: "rename"; categoryId: Category } | null = null;
const pendingNaturalRenames = new Map<string, { id: number; title: string }>();
let naturalRenameSequence = 0;
const bot = new Telegraf(token);
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== allowedUserId) return;
  if (pendingCategoryInput && ctx.message && "text" in ctx.message) {
    await completeCategoryInput(ctx, ctx.message.text);
    return;
  }
  return next();
});
const categoryAliases: Record<string, Category> = {
  movie: "movie", film: "movie", фильм: "movie", фильма: "movie", фильмы: "movie", фильмов: "movie",
  series: "series", сериал: "series", сериала: "series", сериалов: "series", сериалы: "series",
  book: "book", книга: "book", книги: "book", книг: "book",
  game: "game", игра: "game", игры: "game",
  music: "music", музыка: "music",
  place: "place", место: "place", места: "place",
  other: "other", другое: "other", разное: "other", разного: "other",
  просмотренное: "watched", просмотренного: "watched", просмотренных: "watched", watched: "watched"
};

function categoryLabel(id: Category): string {
  return getCategory(id)?.label || id;
}

function recommendationCategories() {
  return getCategories().filter(category => category.id !== "watched");
}

function formatRecommendationTitle(item: any): string {
  const year = item.year ? ` (${item.year})` : "";
  if (item.category !== "book") return `${item.title}${year}`;
  const author = item.author ? `, ${item.author}` : "";
  const seriesName = item.book_series || item.series;
  const series = seriesName ? ` · серия: ${seriesName}` : "";
  return `«${item.title}»${year}${author}${series}`;
}

function resolveCategory(value: string): Category | null {
  const normalized = value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const alias = categoryAliases[normalized];
  if (alias && getCategory(alias)) return alias;
  return getCategoryByLabel(value)?.id || null;
}

function formatItems(items: any[], includeCategory = false): string {
  if (!items.length) return "Пока здесь ничего нет.";
  return items.map((x) => {
    const status = x.watched ? " — просмотрено" : "";
    const category = includeCategory ? ` - ${categoryLabel(x.category as Category)}` : "";
    const links = recordLinks(x).map(link => `\n  ${link}`).join("");
    return `#${x.list_number} · ${formatRecommendationTitle(x)}${category}${status}${links}`;
  }).join("\n");
}

function recordLinks(item: any): string[] {
  let savedLinks: string[] = [];
  try {
    const parsed = JSON.parse(item.source_links || "[]");
    if (Array.isArray(parsed)) savedLinks = parsed.filter((link): link is string => typeof link === "string");
  } catch { /* Older or malformed data has no additional links. */ }
  return [...new Set(savedLinks.filter(isSourceLink))];
}

function collectSourceLinks(text: string, sourceUrl: string | null, extraLinks: string[] = []): string[] {
  return [...new Set([...extractUrls(text), ...extraLinks].filter(link =>
    isSourceLink(link) && !isSamePage(link, sourceUrl)
  ))].slice(0, 20);
}

function attachUnambiguousSourceLink(items: Recommendation[], sourceLinks: string[]): Recommendation[] {
  if (items.length !== 1 || sourceLinks.length !== 1 || items[0].links?.length) return items;
  return [{ ...items[0], links: [sourceLinks[0]] }];
}

function isSourceLink(link: string): boolean {
  try {
    const host = new URL(link).hostname.toLowerCase().replace(/^www\./, "");
    const excluded = ["threads.com", "threads.net", "instagram.com", "facebook.com", "meta.com", "cdninstagram.com", "fbcdn.net"];
    return !excluded.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function isSamePage(link: string, sourceUrl: string | null): boolean {
  if (!sourceUrl) return false;
  try {
    const candidate = new URL(link);
    const source = new URL(sourceUrl);
    return candidate.hostname === source.hostname && candidate.pathname === source.pathname;
  } catch {
    return false;
  }
}

function isInstagramLink(link: string): boolean {
  try {
    const host = new URL(link).hostname.toLowerCase().replace(/^www\./, "");
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

function parseCategoryPosition(args: string[]): { category: Category; number: number } | null {
  if (args.length < 2) return null;
  const category = resolveCategory(args.slice(0, -1).join(" "));
  const number = Number(args[args.length - 1]);
  if (!category || !Number.isInteger(number) || number < 1) return null;
  return { category, number };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

async function sendRecommendationCard(ctx: any, item: any) {
  let details: Awaited<ReturnType<typeof getTmdbDetails>> = null;
  try {
    if (["movie", "series", "watched"].includes(item.category) && process.env.TMDB_API_TOKEN) {
      details = await getTmdbDetails(item as Recommendation);
    }
  } catch {
    // Keep the saved recommendation available if TMDB cannot be reached.
  }
  const title = details?.title || item.title;
  const year = details?.year || item.year;
  const overview = details?.overview || item.note || (
    ["movie", "series", "watched"].includes(item.category) && !process.env.TMDB_API_TOKEN
      ? "Добавь TMDB_API_TOKEN, чтобы получать описания и постеры."
      : "Описание пока недоступно."
  );
  const caption = `<b>${escapeHtml(title)}${year ? ` (${escapeHtml(String(year))})` : ""}</b>\n${escapeHtml(categoryLabel(item.category))}\n\n${escapeHtml(overview.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 800))}`;
  const linkButtons = recordLinks(item).map((link, index) => {
    let label = `Источник ${index + 1}`;
    try { label = new URL(link).hostname.slice(0, 60); } catch { /* Keep generic label. */ }
    return [Markup.button.url(label, link)];
  });
  const keyboard = linkButtons.length ? Markup.inlineKeyboard(linkButtons) : undefined;
  if (details?.posterUrl) {
    try {
      await ctx.replyWithPhoto(details.posterUrl, { caption, parse_mode: "HTML", ...(keyboard || {}) });
      return;
    } catch {
      // Fall back to a text card if Telegram cannot fetch the TMDB poster.
    }
  }
  await ctx.reply(caption, { parse_mode: "HTML", ...(keyboard || {}) });
}

function listsKeyboard() {
  const buttons = getCategories().map(category => Markup.button.callback(category.label, `open_list:${category.id}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback("⚙️ Категории", "manage_categories")]);
  return Markup.inlineKeyboard(rows);
}

function categoriesManagerKeyboard() {
  const rows = getCategories(false).flatMap(category => {
    const buttons = [Markup.button.callback(`✏️ ${category.label}`, `category_rename:${category.id}`)];
    if (!category.isCore) {
      buttons.push(Markup.button.callback(category.isActive ? "Скрыть" : "Показать", `${category.isActive ? "category_hide" : "category_show"}:${category.id}`));
    }
    return [buttons];
  });
  rows.push([Markup.button.callback("➕ Добавить список", "category_add")]);
  rows.push([Markup.button.callback("← К спискам", "show_lists")]);
  return Markup.inlineKeyboard(rows);
}

async function showCategoriesManager(ctx: any) {
  await ctx.reply("Настрой категории. Скрытые списки и их записи можно вернуть в меню.", categoriesManagerKeyboard());
}

async function completeCategoryInput(ctx: any, value: string) {
  const pending = pendingCategoryInput;
  pendingCategoryInput = null;
  const label = value.trim().replace(/\s+/g, " ");
  if (label === "/cancel") return ctx.reply("Отменила действие.");
  if (!label || label.length > 40) {
    await ctx.reply("Название должно содержать от 1 до 40 символов.");
    return showCategoriesManager(ctx);
  }
  const aliasCategory = categoryAliases[label.toLocaleLowerCase()];
  if (aliasCategory && (!pending || pending.action === "add" || aliasCategory !== pending.categoryId)) {
    await ctx.reply("Это название уже используется для основной категории. Выбери другое.");
    return showCategoriesManager(ctx);
  }
  if (pending?.action === "add") {
    const category = createCategory(label);
    if (!category) {
      await ctx.reply("Такой список уже есть или название не подходит. Попробуй другое.");
      return showCategoriesManager(ctx);
    }
    await ctx.reply(`Добавила список «${category.label}».`);
    return showListsMenu(ctx);
  }
  if (pending?.action === "rename") {
    if (!renameCategory(pending.categoryId, label)) {
      await ctx.reply("Такое название уже занято или не подходит. Попробуй другое.");
      return showCategoriesManager(ctx);
    }
    await ctx.reply(`Переименовала список в «${categoryLabel(pending.categoryId)}».`);
    return showCategoriesManager(ctx);
  }
}

async function sendCategoryList(ctx: any, category: Category) {
  const rows = getByCategory(category, 50);
  const label = categoryLabel(category);
  if (!rows.length) return ctx.reply(`${label} (0)\n\nПока здесь ничего нет.`);
  const hasCards = ["movie", "series", "watched"].includes(category);
  if (!hasCards) {
    return ctx.reply(`${label} (${rows.length})\n\n${formatItems(rows)}`);
  }
  for (let start = 0; start < rows.length; start += 20) {
    const page = rows.slice(start, start + 20);
    const heading = start === 0 ? `${label} (${rows.length})` : `${label} · продолжение`;
    const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let index = 0; index < page.length; index += 2) {
      buttons.push(page.slice(index, index + 2).map(item => Markup.button.callback(
        `${item.list_number}. ${item.title}`.slice(0, 60),
        `item_card:${item.id}`
      )));
    }
    await ctx.reply(heading, Markup.inlineKeyboard(buttons));
  }
}

async function showListsMenu(ctx: any) {
  return ctx.reply("Выбери список:", listsKeyboard());
}

function watchedTitleFromMessage(text: string): string | null {
  const normalized = text.trim().replace(/[.!?]+$/, "");
  const verbMatch = normalized.match(/^(?:(?:я|мы)\s+)?(?:посмотрел(?:а|и)?|глянул(?:а|и)?|досмотрел(?:а|и)?)\s+(.+)$/i);
  if (verbMatch) return verbMatch[1].trim();
  const addMatch = normalized.match(/^(?:добавь|занеси)\s+(.+?)\s+в\s+просмотренное$/i);
  if (addMatch) return addMatch[1].trim();
  const putMatch = normalized.match(/^(?:добавь|занеси)\s+в\s+просмотренное\s+(.+)$/i);
  return putMatch?.[1]?.trim() || null;
}

function categoryFromListRequest(text: string): Category | null {
  let phrase = text.trim().replace(/[.!?]+$/, "");
  phrase = phrase.replace(/^(?:покажи|открой|выведи|пришли|отобрази)(?:\s+мне)?\s+/i, "");
  phrase = phrase.replace(/^(?:мои|мой|моя|мое)\s+/i, "");
  phrase = phrase.replace(/^(?:список|списка|списке|списки)\s+/i, "");
  phrase = phrase.replace(/\s+пожалуйста$/i, "").trim();
  return resolveCategory(phrase);
}

type NaturalListAction =
  | { kind: "move"; title: string; source: Category; target: Category }
  | { kind: "moveNumber"; number: number; source: Category; target: Category }
  | { kind: "rename"; title: string; newTitle: string }
  | { kind: "delete"; title: string }
  | { kind: "deleteNumbers"; category: Category; numbers: number[] }
  | { kind: "deleteTitles"; entries: Array<{ title: string; category: Category }> };

function parseNumberList(value: string): number[] | null {
  const parts = value.trim().split(/\s*(?:,|;|\bи\b|&)\s*/iu).filter(Boolean);
  if (!parts.length) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const match = part.match(/^№?\s*(\d+)\s*(?:[-–—]\s*№?\s*(\d+))?$/);
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < start || end - start > 100) return null;
    for (let number = start; number <= end; number++) numbers.push(number);
  }
  return [...new Set(numbers)];
}

function parseNaturalListActions(text: string): NaturalListAction[] {
  const categorizedDelete = text.match(/^\s*(.+?)\s*,\s*(?:удали|удалить)(?:\s+(?:пункты|номера))?\s+(.+?)\s*[.!?]*$/i);
  if (categorizedDelete) {
    const category = resolveCategory(categorizedDelete[1]);
    const numbersText = categorizedDelete[2].trim();
    const numbers = parseNumberList(numbersText);
    if (category && numbers) {
      return [{ kind: "deleteNumbers", category, numbers }];
    }
  }
  const deleteNumbersCommand = text.match(/^(.*?)\s*(?:[-—:]+\s*)?(?:удали|удалить)\s*[.!?]*$/i);
  if (deleteNumbersCommand && /№\s*\d/.test(deleteNumbersCommand[1])) {
    const numbers = parseNumberList(deleteNumbersCommand[1]);
    const categoryText = deleteNumbersCommand[1]
      .replace(/№?\s*\d+\s*[-–—]\s*№?\s*\d+|№?\s*\d+/g, " ")
      .replace(/[\s,;и&]+/giu, " ").trim();
    const category = resolveCategory(categoryText);
    if (category && numbers) {
      return [{ kind: "deleteNumbers", category, numbers }];
    }
  }
  if (/(?:удали|удалить)\s+(?:оба|обе)/i.test(text)) {
    const entries = text.split(/\n+/).map(line => {
      const cleaned = line.trim()
        .replace(/^(?:[•*\-]\s*|\d+[.)]\s*)/, "")
        .replace(/\s*[-—–:]\s*(?:удали|удалить)\s+(?:оба|обе)\s*[.!?]*$/i, "")
        .trim();
      const match = cleaned.match(/^(.+?)\s+[—–-]\s+(.+?)\s+\((\d{4})\)$/);
      if (!match) return null;
      const category = resolveCategory(match[2]);
      return category ? { title: match[1].trim(), category } : null;
    }).filter((entry): entry is { title: string; category: Category } => Boolean(entry));
    return entries.length >= 2 ? [{ kind: "deleteTitles", entries }] : [];
  }

  const actions: NaturalListAction[] = [];
  let currentCategory: Category | null = null;
  for (const part of text.split(/[,;\n]+/).map(value => value.trim()).filter(Boolean)) {
    const listCategory = categoryFromListRequest(part);
    if (listCategory) {
      currentCategory = listCategory;
      continue;
    }
    const numberedMove = part.match(/^(?:№\s*)?(\d+)\s*(?:[-—:]\s*)?(?:перенеси|перемести|перенести)\s+в\s+(.+?)\s*[.!?]*$/i);
    if (numberedMove) {
      const target = resolveCategory(numberedMove[2]);
      const number = Number(numberedMove[1]);
      if (currentCategory && target && number > 0) {
        actions.push({ kind: "moveNumber", number, source: currentCategory, target });
      }
      continue;
    }
    const numberedDelete = part.match(/^(?:удали|удалить)(?:\s+(?:пункты|номера))?\s+(.+?)\s*[.!?]*$/i);
    if (numberedDelete) {
      let numbersText = numberedDelete[1].trim();
      const inlineCategory = numbersText.match(/^(.*?)\s+из\s+(.+)$/i);
      const category = inlineCategory ? resolveCategory(inlineCategory[2]) : currentCategory;
      if (inlineCategory) numbersText = inlineCategory[1].trim();
      const numbers = parseNumberList(numbersText);
      if (category && numbers) {
        actions.push({ kind: "deleteNumbers", category, numbers });
      }
      continue;
    }
    const move = part.match(/^(.+?)\s*(?:[-—:]\s*)?(?:перенеси|перемести|перенести)\s+из\s+(.+?)\s+в\s+(.+?)\s*[.!?]*$/i);
    if (move) {
      const source = resolveCategory(move[2]);
      const target = resolveCategory(move[3]);
      if (source && target) actions.push({ kind: "move", title: move[1].trim(), source, target });
      continue;
    }
    const rename = part.match(/^(.+?)\s*(?:[-—:]\s*)?переименовать\s+в\s+(.+?)\s*[.!?]*$/i);
    if (rename) {
      actions.push({ kind: "rename", title: rename[1].trim(), newTitle: rename[2].trim() });
      continue;
    }
    const deletion = part.match(/^(.+?)\s*(?:[-—:]\s*)?(?:удали|удалить)(?:\s+из\s+списка)?\s*[.!?]*$/i);
    if (deletion) actions.push({ kind: "delete", title: deletion[1].trim() });
  }
  return actions;
}

function findTitleMatches(title: string, category?: Category): any[] {
  const normalize = (value: string) => value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const stem = (word: string) => {
    const endings = ["иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ая", "яя", "ое", "ее", "ые", "ие", "ый", "ий", "ой", "ов", "ев", "ей", "ам", "ям", "ах", "ях", "ем", "ом", "а", "я", "ы", "и", "е", "у", "ю", "ь"];
    const ending = endings.find(value => word.length - value.length >= 4 && word.endsWith(value));
    return ending ? word.slice(0, -ending.length) : word;
  };
  const query = normalize(title.replace(/^['«"“”]+|['»"“”]+$/g, ""));
  const queryWords = query.split(/\s+/).filter(Boolean);
  if (!queryWords.length) return [];
  const rows = getByCategory(undefined, 10000).filter(item => !category || item.category === category);
  const exact = rows.filter(item => normalize(item.title) === query);
  if (exact.length) return exact;
  const queryStems = queryWords.map(stem);
  return rows.filter(item => {
    const titleStems = normalize(item.title).split(/\s+/).map(stem);
    return queryStems.every(queryWord => titleStems.some(titleWord => queryWord === titleWord));
  });
}

async function performNaturalListAction(ctx: any, action: NaturalListAction) {
  if (action.kind === "moveNumber") {
    const item = getByListNumber(action.source, action.number);
    if (!item) {
      await ctx.reply(`Не нашла №${action.number} в списке «${categoryLabel(action.source)}».`);
      return;
    }
    updateCategory(item.id, action.target);
    await ctx.reply(`«${item.title}» перенесена из списка «${categoryLabel(action.source)}» в «${categoryLabel(action.target)}». Нумерация обновлена.`);
    return;
  }
  if (action.kind === "deleteTitles") {
    const resolved = action.entries.map(entry => ({ ...entry, matches: findTitleMatches(entry.title, entry.category) }));
    const missing = resolved.filter(entry => !entry.matches.length);
    const ambiguous = resolved.filter(entry => entry.matches.length > 1);
    if (missing.length || ambiguous.length) {
      const details = [
        ...missing.map(entry => `не найдено «${entry.title}»`),
        ...ambiguous.map(entry => `несколько совпадений для «${entry.title}»`)
      ];
      await ctx.reply(`Не удаляла записи: ${details.join("; ")}. Уточни названия или удали их по отдельности.`);
      return;
    }
    const items = resolved.map(entry => entry.matches[0]);
    for (const item of items) deleteRecommendation(item.id);
    await ctx.reply(`Удалено: ${items.map(item => `«${item.title}»`).join(", ")}.`);
    return;
  }
  if (action.kind === "deleteNumbers") {
    const selected = action.numbers.map(number => ({ number, item: getByListNumber(action.category, number) }));
    const existing = selected.filter((entry): entry is { number: number; item: any } => Boolean(entry.item));
    for (const { item } of existing) deleteRecommendation(item.id);
    const removed = existing.map(({ number, item }) => `№${number} «${item.title}»`);
    const missing = selected.filter(entry => !entry.item).map(entry => `№${entry.number}`);
    const result = removed.length ? `Удалено из списка «${categoryLabel(action.category)}»: ${removed.join(", ")}.` : "Не нашла записи с такими номерами.";
    await ctx.reply(`${result}${missing.length ? ` Не найдены: ${missing.join(", ")}.` : " Нумерация обновлена."}`);
    return;
  }
  const matches = findTitleMatches(action.title, action.kind === "move" ? action.source : undefined);
  if (!matches.length) {
    await ctx.reply(action.kind === "move"
      ? `Не нашла «${action.title}» в списке «${categoryLabel(action.source)}».`
      : `Не нашла «${action.title}» в списках.`);
    return;
  }
  if (matches.length > 1) {
    const buttons = matches.map((item: any) => {
      const title = `${item.title}${item.year ? ` (${item.year})` : ""}`.slice(0, 35);
      let callback: string;
      if (action.kind === "move") callback = `natmove:${item.id}:${action.target}`;
      else if (action.kind === "delete") callback = `natdelete:${item.id}`;
      else {
        const key = `${Date.now().toString(36)}${(++naturalRenameSequence).toString(36)}`;
        pendingNaturalRenames.set(key, { id: item.id, title: action.newTitle });
        callback = `natrename:${key}`;
      }
      return [Markup.button.callback(`${title} · ${categoryLabel(item.category)}`, callback)];
    });
    await ctx.reply(`Нашла несколько совпадений для «${action.title}». Выбери запись:`, Markup.inlineKeyboard(buttons));
    return;
  }
  const item = matches[0];
  if (action.kind === "delete") {
    deleteRecommendation(item.id);
    await ctx.reply(`«${item.title}» удалена из списка «${categoryLabel(item.category)}».`);
  } else if (action.kind === "move") {
    updateCategory(item.id, action.target);
    await ctx.reply(`«${item.title}» перенесена из списка «${categoryLabel(action.source)}» в «${categoryLabel(action.target)}».`);
  } else if (updateRecommendationTitle(item.id, action.newTitle)) {
    await ctx.reply(`Переименовала «${item.title}» в «${action.newTitle.trim()}».`);
  } else {
    await ctx.reply(`Не удалось переименовать «${item.title}»: такое название уже есть в списке «${categoryLabel(item.category)}».`);
  }
}

async function handleNaturalListActions(ctx: any, text: string): Promise<boolean> {
  const actions = parseNaturalListActions(text);
  if (actions.length) {
    for (const action of actions) await performNaturalListAction(ctx, action);
    return true;
  }
  if (/(?:перенеси|перемести|перенести|переименовать|удали|удалить)/i.test(text)) {
    await ctx.reply("Не распознала команду. Примеры: «Историю электричества — переименовать в История электричества»; «Фильмы, удалить №4 и №5».");
    return true;
  }
  return false;
}

async function markTitleWatched(ctx: any, title: string) {
  const matches = searchMedia(title);
  if (!matches.length) {
    await ctx.reply(`Не нашла «${title}» в списках фильмов и сериалов. Проверь название или добавь рекомендацию.`);
    return;
  }
  if (matches.length === 1) {
    const item = matches[0];
    moveToWatched(item.id);
    await ctx.reply(`«${item.title}» перенесён в список «Просмотренное» из списка «${categoryLabel(item.category)}».`);
    return;
  }
  const buttons = matches.map((item: any) => [Markup.button.callback(
    `${`${item.title}${item.year ? ` (${item.year})` : ""}`.slice(0, 38)} · ${categoryLabel(item.category)}`,
    `watched:${item.id}`
  )]);
  await ctx.reply(`Нашла несколько совпадений для «${title}». Какое отметить просмотренным?`, Markup.inlineKeyboard(buttons));
}

async function processText(ctx: any, text: string, sourceUrl: string | null, extraLinks: string[] = [], announce = true) {
  if (announce) await ctx.reply("Разбираю рекомендации…");
  const sourceLinks = collectSourceLinks(text, sourceUrl, extraLinks);
  const extracted = await enrichBookRecommendations(await extractRecommendations(text, sourceLinks, recommendationCategories()));
  const items = attachUnambiguousSourceLink(extracted, sourceLinks);
  if (!items.length) {
    await ctx.reply(
      "Не нашёл явных названий. Пришли текст подписи к посту или просто напиши названия вручную.\n\n" +
      "Пример: «The Bear, сериал; Poor Things, фильм»"
    );
    return;
  }
  const result = saveRecommendations(items, sourceUrl, text);
  const lines = items.map((x: Recommendation) => `• ${formatRecommendationTitle(x)} - ${categoryLabel(x.category)}`);
  await ctx.reply(
    `${result.saved ? `Сохранено: ${result.saved}` : "Новых записей нет"}${result.duplicates ? `\nДубликатов пропущено: ${result.duplicates}` : ""}\n\n${lines.join("\n")}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Открыть списки", "show_lists")]
    ])
  );
}

bot.start((ctx) => ctx.reply(
  "Это твоя библиотека рекомендаций.\n\n" +
  "Отправляй ссылку на пост, текст публикации или название фильма/сериала/книги/игры.\n\n" +
  "Команды:\n/list — открыть списки\n/categories — настроить категории\n/movies — фильмы\n/series — сериалы\n/books — книги\n/search слово — поиск\n/random — случайная непросмотренная рекомендация\n/done сериал 2 — перенести №2 в просмотренное\n/type фильм 2 сериал — перенести №2 из фильмов в сериалы\n/delete фильм 2 — удалить №2 из списка фильмов\n/credits — источник описаний\n/help — помощь\n\nНапиши «посмотрела Керри» — найду фильм или сериал и перенесу его в список «Просмотренное»."
));

bot.help((ctx) => ctx.reply(
  "Как пользоваться:\n" +
  "• Отправь ссылку на пост — бот попробует прочитать публичное описание.\n" +
  "• Если соцсеть закрыла доступ, скопируй подпись поста и отправь её следующим сообщением.\n" +
  "• Можно просто отправить названия: бот попробует определить категории.\n" +
  "• Можно отправить скриншот текста поста.\n\n" +
  "Напиши обычным сообщением «посмотрела Керри» или «добавь Керри в просмотренное». Бот найдёт фильм или сериал; если совпадений несколько, предложит выбрать. Выбранная запись переместится из исходного списка в «Просмотренное».\n\nНажми на название в любом списке, чтобы открыть карточку. Для фильмов и сериалов карточка включает постер и описание, если произведение найдено в TMDB.\n\nКоманды: /list, /categories, /movies, /series, /books, /search, /random, /done список номер, /type список номер новый_тип, /delete список номер, /credits. Категории можно добавлять, переименовывать и скрывать командой /categories."
));

bot.command("credits", async (ctx) => {
  await ctx.reply(
    "Описания фильмов и сериалов предоставлены TMDB.\n" +
    "This product uses the TMDB API but is not endorsed or certified by TMDB.",
    Markup.inlineKeyboard([[Markup.button.url("TMDB", "https://www.themoviedb.org/")]])
  );
});

bot.command("list", async (ctx) => {
  await showListsMenu(ctx);
});

bot.command("categories", async (ctx) => {
  await showCategoriesManager(ctx);
});

const commands: Array<[string, Category]> = [
  ["movies", "movie"], ["series", "series"], ["books", "book"],
  ["games", "game"], ["music", "music"], ["places", "place"]
];
for (const [command, category] of commands) {
  bot.command(command, async (ctx) => {
    await sendCategoryList(ctx, category);
  });
}

bot.command("search", async (ctx) => {
  const query = ctx.message.text.replace(/^\/search(?:@\w+)?\s*/i, "").trim();
  if (!query) return ctx.reply("Напиши поисковый запрос: /search название");
  const rows = searchRecommendations(query);
  await ctx.reply(`Результаты поиска (${rows.length})\n\n${formatItems(rows, true)}`);
});

bot.command("random", async (ctx) => {
  const item = getRandom();
  if (!item) return ctx.reply("Нет непросмотренных рекомендаций.");
  await ctx.reply(
    `Случайная рекомендация:\n#${item.list_number} · ${item.title}\nКатегория: ${categoryLabel(item.category as Category)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("Посмотрено", `done:${item.id}`)]
    ])
  );
});

bot.command("done", async (ctx) => {
  const args = ctx.message.text.replace(/^\/done(?:@\w+)?\s*/i, "").trim().split(/\s+/);
  const position = parseCategoryPosition(args);
  if (!position) return ctx.reply("Формат: /done список номер. Например: /done сериал 2");
  const item = getByListNumber(position.category, position.number);
  if (!item) return ctx.reply("Запись с таким номером не найдена.");
  if (["movie", "series"].includes(position.category)) {
    moveToWatched(item.id);
    await ctx.reply(`«${item.title}» перенесён в список «Просмотренное».`);
  } else {
    markWatched(item.id);
    await ctx.reply(`№${position.number} в списке «${categoryLabel(position.category)}» отмечена как просмотренная.`);
  }
});

bot.command("delete", async (ctx) => {
  const args = ctx.message.text.replace(/^\/delete(?:@\w+)?\s*/i, "").trim().split(/\s+/);
  const position = parseCategoryPosition(args);
  if (!position) return ctx.reply("Формат: /delete список номер. Например: /delete фильм 2");
  const item = getByListNumber(position.category, position.number);
  if (!item) return ctx.reply("Запись с таким номером не найдена.");
  deleteRecommendation(item.id);
  await ctx.reply(`№${position.number} удалена из списка «${categoryLabel(position.category)}». Нумерация обновлена.`);
});

bot.command("type", async (ctx) => {
  const args = ctx.message.text.replace(/^\/type(?:@\w+)?\s*/i, "").trim().split(/\s+/);
  const numberIndex = args.findIndex((part, index) => index > 0 && /^\d+$/.test(part));
  if (numberIndex < 1 || numberIndex >= args.length - 1) {
    return ctx.reply("Формат: /type список номер новый_список. Например: /type фильм 2 сериал");
  }
  const source = parseCategoryPosition(args.slice(0, numberIndex + 1));
  const targetName = args.slice(numberIndex + 1).filter(part => part !== "->").join(" ");
  const target = resolveCategory(targetName);
  if (!source || !target) return ctx.reply("Укажи существующий список. Список категорий: /categories");
  const item = getByListNumber(source.category, source.number);
  if (!item) return ctx.reply("Запись с таким номером не найдена.");
  updateCategory(item.id, target);
  await ctx.reply(`«${item.title}» перенесена из списка «${categoryLabel(source.category)}» в «${categoryLabel(target)}». Нумерация обновлена.`);
});

bot.action("show_lists", async (ctx) => {
  await ctx.answerCbQuery();
  await showListsMenu(ctx);
});

bot.action("manage_categories", async (ctx) => {
  await ctx.answerCbQuery();
  await showCategoriesManager(ctx);
});

bot.action("category_add", async (ctx) => {
  await ctx.answerCbQuery();
  pendingCategoryInput = { action: "add" };
  await ctx.reply("Напиши название нового списка (до 40 символов). Для отмены отправь /cancel.");
});

bot.action(/^category_rename:(.+)$/, async (ctx) => {
  const categoryId = ctx.match[1];
  const category = getCategory(categoryId);
  await ctx.answerCbQuery();
  if (!category) return ctx.reply("Категория не найдена.");
  pendingCategoryInput = { action: "rename", categoryId };
  await ctx.reply(`Напиши новое название для списка «${category.label}» (до 40 символов). Для отмены отправь /cancel.`);
});

bot.action(/^category_(hide|show):(.+)$/, async (ctx) => {
  const [, action, categoryId] = ctx.match;
  const category = getCategory(categoryId);
  await ctx.answerCbQuery();
  if (!category) return ctx.reply("Категория не найдена.");
  const active = action === "show";
  if (!setCategoryActive(categoryId, active)) return ctx.reply("Основные категории скрыть нельзя.");
  await ctx.reply(active ? `Список «${category.label}» снова показывается.` : `Список «${category.label}» скрыт. Записи сохранены.`);
  await showCategoriesManager(ctx);
});

bot.action(/^open_list:(.+)$/, async (ctx) => {
  const category = getCategory(ctx.match[1]);
  await ctx.answerCbQuery();
  if (!category || !category.isActive) return ctx.reply("Этот список скрыт. Вернуть его можно в /categories.");
  await sendCategoryList(ctx, category.id);
});

bot.action(/^item_card:(\d+)$/, async (ctx) => {
  const item = getById(Number(ctx.match[1]));
  await ctx.answerCbQuery(item ? "Открываю карточку…" : "Запись не найдена.");
  if (!item) return;
  await sendRecommendationCard(ctx, item);
});

bot.action(/^done:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const item = getById(id);
  if (item && ["movie", "series"].includes(item.category)) moveToWatched(id);
  else markWatched(id);
  await ctx.answerCbQuery("Добавлено в просмотренное");
  await ctx.editMessageReplyMarkup(undefined);
});

bot.action(/^watched:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const item = getById(id);
  if (!item || !["movie", "series"].includes(item.category)) {
    await ctx.answerCbQuery("Запись уже перемещена или удалена.");
    return ctx.editMessageReplyMarkup(undefined);
  }
  moveToWatched(id);
  await ctx.answerCbQuery("Перенесено в просмотренное");
  await ctx.editMessageText(`«${item.title}» перенесён в список «Просмотренное».`);
});

bot.action(/^natmove:(\d+):(.+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const target = ctx.match[2];
  const item = getById(id);
  await ctx.answerCbQuery();
  if (!item || !getCategory(target)) return ctx.editMessageText("Запись уже перемещена или удалена.");
  updateCategory(id, target);
  await ctx.editMessageText(`«${item.title}» перенесена в список «${categoryLabel(target)}».`);
});

bot.action(/^natdelete:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const item = getById(id);
  await ctx.answerCbQuery();
  if (!item) return ctx.editMessageText("Запись уже удалена.");
  deleteRecommendation(id);
  await ctx.editMessageText(`«${item.title}» удалена из списка «${categoryLabel(item.category)}».`);
});

bot.action(/^natrename:(.+)$/, async (ctx) => {
  const pending = pendingNaturalRenames.get(ctx.match[1]);
  pendingNaturalRenames.delete(ctx.match[1]);
  await ctx.answerCbQuery();
  if (!pending) return ctx.editMessageText("Запрос на переименование устарел. Отправь его ещё раз.");
  const item = getById(pending.id);
  if (!item) return ctx.editMessageText("Запись уже удалена.");
  if (!updateRecommendationTitle(item.id, pending.title)) {
    return ctx.editMessageText(`Не удалось переименовать: название уже есть в списке «${categoryLabel(item.category)}».`);
  }
  await ctx.editMessageText(`Переименовала «${item.title}» в «${pending.title.trim()}».`);
});

async function saveAndReply(ctx: any, items: Recommendation[], sourceUrl: string, sourceText: string) {
  items = await enrichBookRecommendations(items);
  items = attachUnambiguousSourceLink(items, collectSourceLinks(sourceText, sourceUrl));
  const result = saveRecommendations(items, sourceUrl, sourceText);
  const lines = items.map(x => `• ${formatRecommendationTitle(x)} - ${categoryLabel(x.category)}`);
  await ctx.reply(
    `${result.saved ? `Сохранено: ${result.saved}` : "Новых записей нет"}${result.duplicates ? `\nДубликатов пропущено: ${result.duplicates}` : ""}\n\n${lines.join("\n")}`,
    Markup.inlineKeyboard([[Markup.button.callback("Открыть списки", "show_lists")]])
  );
}

bot.on("photo", async (ctx) => {
  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    if (!file.file_path) throw new Error("Не удалось получить файл изображения.");
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const imageResponse = await fetch(url);
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    const mime = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";
    const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    await ctx.reply("Читаю скриншот…");
  const items = await enrichBookRecommendations(await extractRecommendationsFromImages([{ mimeType: mime, dataUrl }], "", [], recommendationCategories()));
    if (!items.length) return ctx.reply("На скриншоте не удалось найти названия рекомендаций.");
    const result = saveRecommendations(items, null, "[Скриншот]");
    await ctx.reply(`Сохранено: ${result.saved}${result.duplicates ? `\nДубликатов: ${result.duplicates}` : ""}\n\n${items.map(x => `• ${formatRecommendationTitle(x)} - ${categoryLabel(x.category)}`).join("\n")}`);
  } catch (error) {
    console.error(error);
    await ctx.reply("Не удалось обработать изображение. Попробуй отправить его ещё раз или скопируй текст.");
  }
});

bot.on("document", async (ctx) => {
  const document = ctx.message.document;
  if (document.file_name !== "recommendation-backup.json") return;
  if (document.file_size && document.file_size > 1_000_000) {
    await ctx.reply("Файл переноса слишком большой.");
    return;
  }
  try {
    const file = await ctx.telegram.getFile(document.file_id);
    if (!file.file_path) throw new Error("Файл недоступен.");
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!response.ok) throw new Error("Не удалось скачать файл.");
    const backup = await response.json();
    const count = importLocalBackup(backup);
    await ctx.reply(`Перенос завершён: добавлено записей — ${count}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Неизвестная ошибка.";
    await ctx.reply(`Не удалось перенести базу: ${message}`);
  }
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  if (await handleNaturalListActions(ctx, text)) return;
  const requestedCategory = categoryFromListRequest(text);
  if (requestedCategory) {
    const category = getCategory(requestedCategory);
    if (!category?.isActive) {
      await ctx.reply(`Список «${category?.label || requestedCategory}» скрыт. Его можно вернуть в /categories.`);
    } else {
      await sendCategoryList(ctx, requestedCategory);
    }
    return;
  }
  const watchedTitle = watchedTitleFromMessage(text);
  if (watchedTitle) {
    await markTitleWatched(ctx, watchedTitle);
    return;
  }
  try {
    const url = extractUrl(text);
    if (url) {
      await ctx.reply("Разбираю рекомендации…");
      try {
        const preview = await getLinkPreview(url);
        if (preview.images.length) {
          const userContext = text.replace(url, "").trim();
          const imageItems = await extractRecommendationsFromImages(
            preview.images,
            isInstagramLink(url) ? userContext : [userContext, preview.text].filter(Boolean).join("\n"),
            preview.links,
            recommendationCategories()
          );
          if (imageItems.length) {
            await saveAndReply(ctx, imageItems, url, text);
            return;
          }
        }
        const pageText = isInstagramLink(url) ? text.replace(url, "").trim() : `${text}\n\nТекст страницы:\n${preview.text}`;
        if (pageText.trim()) {
          await processText(ctx, pageText, url, preview.links, false);
          return;
        }
        await ctx.reply(
          "Не удалось найти текст или изображения публикации. Threads может скрывать их от автоматической загрузки.\n\n" +
          "Скопируй подпись поста или отправь скриншот сюда отдельным сообщением."
        );
      } catch (error) {
        console.error("Link extraction failed:", error);
        await ctx.reply(
          "Не получилось прочитать публикацию автоматически. Pinterest, Instagram и Threads иногда ограничивают доступ к постам и их изображениям.\n\n" +
          "Скопируй сюда текст поста или отправь скриншот — я извлеку названия."
        );
      }
      return;
    }
    await processText(ctx, text, null);
  } catch (error) {
    console.error(error);
    await ctx.reply("Произошла ошибка при обработке. Проверь настройки API и попробуй ещё раз.");
  }
});

bot.catch((err) => console.error("Telegram bot error:", err));
const webhookDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.WEBHOOK_DOMAIN;
if (webhookDomain) {
  const port = Number(process.env.PORT || 3000);
  const secretToken = createHash("sha256").update(token).digest("hex");
  bot.launch({
    webhook: {
      domain: webhookDomain,
      port,
      path: `/telegram/${bot.secretPathComponent()}`,
      secretToken
    }
  }).then(() => console.log("Recommendation bot is running with Telegram webhooks."))
    .catch(error => {
      console.error("Failed to start Telegram webhook:", error);
      process.exitCode = 1;
    });
} else {
  bot.launch().then(() => console.log("Recommendation bot is running with polling."))
    .catch(error => {
      console.error("Failed to start Telegram polling:", error);
      process.exitCode = 1;
    });
}
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
