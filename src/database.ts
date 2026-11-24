import Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Category, CategoryDefinition, Recommendation } from "./types.js";

const ownerTelegramId = process.env.TELEGRAM_USER_ID;
if (!ownerTelegramId || !/^[0-9]+$/.test(ownerTelegramId)) throw new Error("TELEGRAM_USER_ID must be configured before the database opens.");
const dbPath = resolve("data/recommendations.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const ownerDb = new Database(dbPath);
ownerDb.pragma("journal_mode = WAL");
let db: any = ownerDb;

ownerDb.exec(`
  CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    year INTEGER,
    note TEXT,
    author TEXT,
    book_series TEXT,
    source_url TEXT,
    source_text TEXT,
    source_links TEXT NOT NULL DEFAULT '[]',
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    watched INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_recommendations_category
    ON recommendations(category);
`);

ownerDb.exec(`
  CREATE TABLE IF NOT EXISTS recommendation_categories (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL COLLATE NOCASE UNIQUE,
    is_core INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS data_imports (
    id TEXT PRIMARY KEY,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const builtinCategories = [
  { id: "movie", label: "Фильмы", core: true, order: 10 },
  { id: "series", label: "Сериалы", core: true, order: 20 },
  { id: "book", label: "Книги", core: true, order: 30 },
  { id: "other", label: "Разное", core: true, order: 40 },
  { id: "watched", label: "Просмотренное", core: true, order: 45 },
  { id: "game", label: "Игры", core: false, order: 50 },
  { id: "music", label: "Музыка", core: false, order: 60 },
  { id: "place", label: "Места", core: false, order: 70 }
];
const addBuiltinCategory = ownerDb.prepare(`
  INSERT OR IGNORE INTO recommendation_categories (id, label, is_core, is_active, sort_order)
  VALUES (?, ?, ?, ?, ?)
`);
const categoryHasItems = ownerDb.prepare("SELECT EXISTS(SELECT 1 FROM recommendations WHERE category = ?) AS has_items");
for (const category of builtinCategories) {
  const hasItems = Boolean((categoryHasItems.get(category.id) as { has_items: number }).has_items);
  addBuiltinCategory.run(category.id, category.label, Number(category.core), Number(category.core || hasItems), category.order);
}

const columns = ownerDb.prepare("PRAGMA table_info(recommendations)").all() as Array<{ name: string }>;
if (!columns.some(column => column.name === "source_links")) {
  ownerDb.exec("ALTER TABLE recommendations ADD COLUMN source_links TEXT NOT NULL DEFAULT '[]'");
}
if (!columns.some(column => column.name === "author")) ownerDb.exec("ALTER TABLE recommendations ADD COLUMN author TEXT");
if (!columns.some(column => column.name === "book_series")) ownerDb.exec("ALTER TABLE recommendations ADD COLUMN book_series TEXT");


const requestUserContext = new AsyncLocalStorage<string>();
const tenantDatabases = new Map<string, Database.Database>([[ownerTelegramId, ownerDb]]);

function initializeTenantDatabase(target: Database.Database) {
  target.pragma("journal_mode = WAL");
  target.exec([
    "CREATE TABLE IF NOT EXISTS recommendations (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, category TEXT NOT NULL, year INTEGER, note TEXT, author TEXT, book_series TEXT, source_url TEXT, source_text TEXT, source_links TEXT NOT NULL DEFAULT '[]', added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, watched INTEGER NOT NULL DEFAULT 0)",
    "CREATE INDEX IF NOT EXISTS idx_recommendations_category ON recommendations(category)",
    "CREATE TABLE IF NOT EXISTS recommendation_categories (id TEXT PRIMARY KEY, label TEXT NOT NULL COLLATE NOCASE UNIQUE, is_core INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS data_imports (id TEXT PRIMARY KEY, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  ].join("\n"));
  const add = target.prepare("INSERT OR IGNORE INTO recommendation_categories (id, label, is_core, is_active, sort_order) VALUES (?, ?, ?, ?, ?)");
  for (const category of builtinCategories) {
    add.run(category.id, category.label, Number(category.core), Number(category.core), category.order);
  }
}

function databaseForCurrentUser(): Database.Database {
  const userId = requestUserContext.getStore();
  if (!userId) throw new Error("Database access requires an authenticated Telegram user.");
  const cached = tenantDatabases.get(userId);
  if (cached) return cached;
  if (!/^[0-9]+$/.test(userId)) throw new Error("Invalid Telegram user identifier.");
  const userDirectory = resolve("data/users");
  mkdirSync(userDirectory, { recursive: true });
  const userDatabase = new Database(resolve(userDirectory, userId + ".sqlite"));
  initializeTenantDatabase(userDatabase);
  tenantDatabases.set(userId, userDatabase);
  return userDatabase;
}

export function runForTelegramUser<T>(userId: number | string, callback: () => T): T {
  return requestUserContext.run(String(userId), callback);
}

export function initializeCurrentUserLibrary(): void { databaseForCurrentUser(); }

db = new Proxy(ownerDb, {
  get(_target, property) {
    if (property === "prepare") return (sql: string) => new Proxy({}, {
      get(_statement, method) {
        const statement = databaseForCurrentUser().prepare(sql);
        const value = (statement as any)[method];
        return typeof value === "function" ? value.bind(statement) : value;
      }
    });
    if (property === "transaction") return (callback: (...args: any[]) => any) => (...args: any[]) =>
      databaseForCurrentUser().transaction(callback)(...args);
    const currentDb = databaseForCurrentUser();
    const value = (currentDb as any)[property];
    return typeof value === "function" ? value.bind(currentDb) : value;
  }
});

ownerDb.exec("CREATE TABLE IF NOT EXISTS bot_users (telegram_id TEXT PRIMARY KEY, username TEXT, role TEXT NOT NULL DEFAULT 'member', is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
ownerDb.exec("CREATE TABLE IF NOT EXISTS bot_invitations (username TEXT PRIMARY KEY, invited_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
ownerDb.prepare("INSERT INTO bot_users (telegram_id, role, is_active) VALUES (?, 'owner', 1) ON CONFLICT(telegram_id) DO UPDATE SET role = 'owner', is_active = 1").run(ownerTelegramId);

function normalizeUsername(username: string): string | null {
  const normalized = username.trim().replace(/^@/, "").toLocaleLowerCase();
  return /^[a-z0-9_]{5,32}$/.test(normalized) ? normalized : null;
}

export function isAuthorizedTelegramUser(telegramId: number | string): boolean {
  return Boolean(ownerDb.prepare("SELECT 1 FROM bot_users WHERE telegram_id = ? AND is_active = 1").get(String(telegramId)));
}

export function updateTelegramUsername(telegramId: number | string, username?: string): void {
  if (!username) return;
  const normalized = normalizeUsername(username);
  if (normalized) ownerDb.prepare("UPDATE bot_users SET username = ? WHERE telegram_id = ? AND is_active = 1").run(normalized, String(telegramId));
}

export function createTelegramInvitation(username: string, invitedBy: number | string): "created" | "invalid" | "already_exists" | "full" {
  const normalized = normalizeUsername(username);
  if (!normalized) return "invalid";
  return ownerDb.transaction(() => {
    if (ownerDb.prepare("SELECT 1 FROM bot_users WHERE lower(username) = ? AND is_active = 1").get(normalized) ||
        ownerDb.prepare("SELECT 1 FROM bot_invitations WHERE username = ?").get(normalized)) return "already_exists";
    const counts = ownerDb.prepare("SELECT (SELECT COUNT(*) FROM bot_users WHERE is_active = 1) + (SELECT COUNT(*) FROM bot_invitations) AS total").get() as { total: number };
    if (counts.total >= 10) return "full";
    ownerDb.prepare("INSERT INTO bot_invitations (username, invited_by) VALUES (?, ?)").run(normalized, String(invitedBy));
    return "created";
  })();
}

export function acceptTelegramInvitation(telegramId: number | string, username?: string): boolean {
  const id = String(telegramId);
  if (isAuthorizedTelegramUser(id)) return true;
  const normalized = username ? normalizeUsername(username) : null;
  if (!normalized) return false;
  return ownerDb.transaction(() => {
    if (!ownerDb.prepare("SELECT 1 FROM bot_invitations WHERE username = ?").get(normalized)) return false;
    const existing = ownerDb.prepare("SELECT telegram_id FROM bot_users WHERE lower(username) = ? AND is_active = 1").get(normalized) as { telegram_id: string } | undefined;
    if (existing && existing.telegram_id !== id) return false;
    ownerDb.prepare("INSERT INTO bot_users (telegram_id, username, role, is_active) VALUES (?, ?, 'member', 1) ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username, role = 'member', is_active = 1").run(id, normalized);
    ownerDb.prepare("DELETE FROM bot_invitations WHERE username = ?").run(normalized);
    return true;
  })();
}

export function revokeTelegramAccess(username: string): "revoked" | "invite_removed" | "owner" | "not_found" | "invalid" {
  const normalized = normalizeUsername(username);
  if (!normalized) return "invalid";
  return ownerDb.transaction(() => {
    const user = ownerDb.prepare("SELECT telegram_id, role FROM bot_users WHERE lower(username) = ? AND is_active = 1").get(normalized) as { telegram_id: string; role: string } | undefined;
    if (user?.role === "owner") return "owner";
    if (user) {
      ownerDb.prepare("UPDATE bot_users SET is_active = 0 WHERE telegram_id = ?").run(user.telegram_id);
      return "revoked";
    }
    if (ownerDb.prepare("DELETE FROM bot_invitations WHERE username = ?").run(normalized).changes) return "invite_removed";
    return "not_found";
  })();
}

export function listTelegramAccess(): Array<{ username: string | null; telegram_id: string; role: string; status: string }> {
  const users = ownerDb.prepare("SELECT username, telegram_id, role FROM bot_users WHERE is_active = 1 ORDER BY role DESC, created_at ASC").all() as Array<{ username: string | null; telegram_id: string; role: string }>;
  const invites = ownerDb.prepare("SELECT username FROM bot_invitations ORDER BY created_at ASC").all() as Array<{ username: string }>;
  return [
    ...users.map(user => ({ ...user, status: user.role === "owner" ? "владелец" : "активен" })),
    ...invites.map(invite => ({ username: invite.username, telegram_id: "", role: "pending", status: "ожидает /start" }))
  ];
}

const insertStmt = db.prepare(`
  INSERT INTO recommendations (title, category, year, note, author, book_series, source_url, source_text, source_links)
  SELECT @title, @category, @year, @note, @author, @book_series, @source_url, @source_text, @source_links
  WHERE NOT EXISTS (
    SELECT 1 FROM recommendations
    WHERE lower(title) = lower(@title) AND category = @category
  )
`);
const existingStmt = db.prepare(`
  SELECT id, source_links FROM recommendations
  WHERE lower(title) = lower(?) AND category = ?
`);
const mergeLinksStmt = db.prepare("UPDATE recommendations SET source_links = ?, author = COALESCE(author, ?), year = COALESCE(year, ?), book_series = COALESCE(book_series, ?) WHERE id = ?");

export function getCategories(activeOnly = true): CategoryDefinition[] {
  const rows = activeOnly
    ? db.prepare("SELECT * FROM recommendation_categories WHERE is_active = 1 ORDER BY sort_order, label COLLATE NOCASE").all()
    : db.prepare("SELECT * FROM recommendation_categories ORDER BY sort_order, label COLLATE NOCASE").all();
  return (rows as any[]).map(row => ({
    id: row.id,
    label: row.label,
    isCore: Boolean(row.is_core),
    isActive: Boolean(row.is_active),
    sortOrder: row.sort_order
  }));
}

export function getCategory(id: Category): CategoryDefinition | undefined {
  const row = db.prepare("SELECT * FROM recommendation_categories WHERE id = ?").get(id) as any;
  return row ? {
    id: row.id,
    label: row.label,
    isCore: Boolean(row.is_core),
    isActive: Boolean(row.is_active),
    sortOrder: row.sort_order
  } : undefined;
}

export function getCategoryByLabel(label: string): CategoryDefinition | undefined {
  const normalized = label.trim().replace(/\s+/g, " ");
  const key = normalized.toLocaleLowerCase();
  return getCategories(false).find(category => category.label.toLocaleLowerCase() === key);
}

export function createCategory(label: string): CategoryDefinition | null {
  const normalized = label.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 40 || getCategoryByLabel(normalized)) return null;
  const id = `custom_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const sortOrder = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM recommendation_categories").get() as { next_order: number }).next_order;
  db.prepare("INSERT INTO recommendation_categories (id, label, is_core, is_active, sort_order) VALUES (?, ?, 0, 1, ?)").run(id, normalized, sortOrder);
  return getCategory(id) || null;
}

export function renameCategory(id: Category, label: string): boolean {
  const normalized = label.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 40) return false;
  const duplicate = getCategoryByLabel(normalized);
  if (duplicate && duplicate.id !== id) return false;
  return db.prepare("UPDATE recommendation_categories SET label = ? WHERE id = ?").run(normalized, id).changes > 0;
}

export function setCategoryActive(id: Category, active: boolean): boolean {
  const result = active
    ? db.prepare("UPDATE recommendation_categories SET is_active = 1 WHERE id = ?")
    : db.prepare("UPDATE recommendation_categories SET is_active = 0 WHERE id = ? AND is_core = 0");
  return result.run(id).changes > 0;
}

export function saveRecommendations(
  items: Recommendation[],
  sourceUrl: string | null,
  sourceText: string
): { saved: number; duplicates: number } {
  const insertMany = db.transaction((rows: Recommendation[]) => {
    let saved = 0;
    for (const item of rows) {
      const links = [...new Set(item.links || [])].slice(0, 20);
      const result = insertStmt.run({
        title: item.title.trim(),
        category: item.category,
        year: item.year,
        note: item.note,
        author: item.author || null,
        book_series: item.series || null,
        source_url: sourceUrl,
        source_text: sourceText.slice(0, 5000),
        source_links: JSON.stringify(links)
      });
      saved += result.changes;
      if (!result.changes) {
        const existing = existingStmt.get(item.title.trim(), item.category) as
          { id: number; source_links: string | null } | undefined;
        if (existing) {
          let previousLinks: string[] = [];
          try {
            const parsed = JSON.parse(existing.source_links || "[]");
            if (Array.isArray(parsed)) previousLinks = parsed.filter((link): link is string => typeof link === "string");
          } catch { /* Ignore invalid legacy link data. */ }
          mergeLinksStmt.run(JSON.stringify([...new Set([...previousLinks, ...links])].slice(0, 20)), item.author || null, item.year, item.series || null, existing.id);
        }
      }
    }
    return { saved, duplicates: rows.length - saved };
  });
  return insertMany(items);
}

export function getByCategory(category?: Category, limit = 50) {
  return db.prepare(`
    WITH numbered AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY category ORDER BY added_at ASC, id ASC
      ) AS list_number
      FROM recommendations
      ${category ? "WHERE category = ?" : ""}
    )
    SELECT * FROM numbered ORDER BY category ASC, list_number ASC LIMIT ?
  `).all(...(category ? [category, limit] : [limit])) as any[];
}

export function getByListNumber(category: Category, listNumber: number) {
  return db.prepare(`
    WITH numbered AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY added_at ASC, id ASC) AS list_number
      FROM recommendations WHERE category = ?
    )
    SELECT * FROM numbered WHERE list_number = ?
  `).get(category, listNumber) as any | undefined;
}

export function searchRecommendations(query: string) {
  return db.prepare(`
    WITH numbered AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY category ORDER BY added_at ASC, id ASC
      ) AS list_number
      FROM recommendations
    )
    SELECT * FROM numbered
    WHERE title LIKE ? OR note LIKE ?
    ORDER BY category ASC, list_number ASC LIMIT 30
  `).all(`%${query}%`, `%${query}%`) as any[];
}

export function searchMedia(query: string) {
  const term = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
  return db.prepare(`
    WITH numbered AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY category ORDER BY added_at ASC, id ASC) AS list_number
      FROM recommendations
      WHERE category IN ('movie', 'series')
    )
    SELECT * FROM numbered WHERE title LIKE ? ESCAPE '\\' COLLATE NOCASE
    ORDER BY category, list_number LIMIT 20
  `).all(term) as any[];
}

export function moveToWatched(id: number) {
  return db.prepare("UPDATE recommendations SET category = 'watched', watched = 1 WHERE id = ? AND category IN ('movie', 'series')").run(id).changes > 0;
}

export function markWatched(id: number) {
  return db.prepare("UPDATE recommendations SET watched = 1 WHERE id = ?").run(id).changes > 0;
}

export function updateCategory(id: number, category: Category) {
  return db.prepare("UPDATE recommendations SET category = ? WHERE id = ?").run(category, id).changes > 0;
}

export function getRandom(category?: Category) {
  return db.prepare(`
    WITH numbered AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY category ORDER BY added_at ASC, id ASC
      ) AS list_number
      FROM recommendations WHERE watched = 0 AND category <> 'watched'
        ${category ? "AND category = ?" : ""}
    )
    SELECT * FROM numbered ORDER BY RANDOM() LIMIT 1
  `).get(...(category ? [category] : [])) as any | undefined;
}

export function deleteRecommendation(id: number) {
  return db.prepare("DELETE FROM recommendations WHERE id = ?").run(id).changes > 0;
}

export function updateRecommendationTitle(id: number, title: string) {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  const item = db.prepare("SELECT category FROM recommendations WHERE id = ?").get(id) as { category: string } | undefined;
  if (!item) return false;
  const duplicates = db.prepare("SELECT id, title FROM recommendations WHERE category = ? AND id != ?").all(item.category, id) as Array<{ id: number; title: string }>;
  const key = normalized.toLocaleLowerCase("ru").replace(/ё/g, "е");
  if (duplicates.some(row => row.title.toLocaleLowerCase("ru").replace(/ё/g, "е") === key)) return false;
  return db.prepare("UPDATE recommendations SET title = ? WHERE id = ?").run(normalized, id).changes > 0;
}

export function getById(id: number) {
  return db.prepare("SELECT * FROM recommendations WHERE id = ?").get(id) as any | undefined;
}

export function importLocalBackup(value: unknown): number {
  if (!value || typeof value !== "object") throw new Error("Некорректный файл переноса.");
  const backup = value as { version?: unknown; categories?: unknown; recommendations?: unknown };
  if (backup.version !== 1 || !Array.isArray(backup.categories) || !Array.isArray(backup.recommendations)) {
    throw new Error("Формат файла переноса не поддерживается.");
  }
  if (backup.categories.length > 100 || backup.recommendations.length > 10000) throw new Error("В файле слишком много данных.");
  const priorImport = db.prepare("SELECT 1 FROM data_imports LIMIT 1").get();
  if (priorImport) throw new Error("Перенос данных уже выполнялся.");
  if ((db.prepare("SELECT COUNT(*) AS count FROM recommendations").get() as { count: number }).count !== 0) {
    throw new Error("Перенос разрешён только в пустую базу.");
  }

  const transaction = db.transaction(() => {
    for (const raw of backup.categories as any[]) {
      if (!raw || typeof raw.id !== "string" || typeof raw.label !== "string" || raw.label.length > 40) {
        throw new Error("В файле есть некорректная категория.");
      }
      db.prepare(`INSERT INTO recommendation_categories (id, label, is_core, is_active, sort_order)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET label = excluded.label, is_core = excluded.is_core,
          is_active = excluded.is_active, sort_order = excluded.sort_order`)
        .run(raw.id, raw.label, Number(Boolean(raw.isCore)), Number(Boolean(raw.isActive)), Number(raw.sortOrder) || 0);
    }
    const categoryIds = new Set((backup.categories as any[]).map(category => category.id));
    const insert = db.prepare(`INSERT INTO recommendations
      (title, category, year, note, author, book_series, source_links, added_at, watched)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const raw of backup.recommendations as any[]) {
      if (!raw || typeof raw.title !== "string" || !raw.title.trim() || typeof raw.category !== "string" || !categoryIds.has(raw.category)) {
        throw new Error("В файле есть некорректная рекомендация.");
      }
      const links = Array.isArray(raw.source_links) ? raw.source_links.filter((link: unknown) => typeof link === "string").slice(0, 20) : [];
      insert.run(raw.title.trim(), raw.category, Number.isInteger(raw.year) ? raw.year : null,
        typeof raw.note === "string" ? raw.note : null, typeof raw.author === "string" ? raw.author : null,
        typeof raw.book_series === "string" ? raw.book_series : null, JSON.stringify(links),
        typeof raw.added_at === "string" ? raw.added_at : new Date().toISOString(), Number(Boolean(raw.watched)));
    }
    db.prepare("INSERT INTO data_imports (id) VALUES (?)").run("local-backup-v1");
  });
  transaction();
  return backup.recommendations.length;
}
