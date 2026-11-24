import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

export interface LinkPreview {
  text: string;
  url: string;
  images: Array<{ mimeType: string; dataUrl: string }>;
  links: string[];
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (entity, hex: string | undefined, decimal: string | undefined) => {
      const point = Number.parseInt(hex || decimal || "", hex ? 16 : 10);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    });
}

function getAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export async function getLinkPreview(url: string): Promise<LinkPreview> {
  if (isPinterestUrl(url)) return getPinterestPreview(url);
  if (isInstagramUrl(url)) return getInstagramPreview(url);
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RecommendationBot/1.0)",
      "Accept": "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Сайт вернул HTTP ${response.status}`);
  const html = (await response.text()).slice(0, 1_500_000);

  const metas: string[] = [];
  const imageUrls: string[] = [];
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const property = (getAttribute(tag, "property") || getAttribute(tag, "name"))?.toLowerCase();
    const content = getAttribute(tag, "content");
    if (content && property && ["og:title", "og:description", "twitter:title", "twitter:description", "description"].includes(property)) {
      metas.push(decodeHtml(content));
    }
    if (content && property && ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(property)) {
      try {
        const imageUrl = new URL(decodeHtml(content), response.url || url);
        if (imageUrl.protocol === "https:" && !isPrivateHost(imageUrl.hostname)) imageUrls.push(imageUrl.href);
      } catch { /* Ignore malformed image metadata. */ }
    }
  }
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "") || "").trim();
  const text = [title, ...metas].filter(Boolean).join("\n");
  const links = extractSourceLinks(text, response.url || url);
  const pageImageUrls = isThreadsUrl(response.url || url)
    ? await getRenderedPostImageUrls(response.url || url)
    : [];
  const imageCandidates = pageImageUrls.length ? pageImageUrls : [...new Set(imageUrls)].slice(0, 4);
  const images = await Promise.all(imageCandidates.map(loadImage));
  const usableImages = images.filter((image): image is NonNullable<typeof image> => image !== null);
  if (!text.trim() && !usableImages.length) throw new Error("На странице не удалось найти текст или изображения.");
  return { text: text.slice(0, 6000), url: response.url || url, images: usableImages, links };
}

async function getPinterestPreview(url: string): Promise<LinkPreview> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; RecommendationBot/1.0)",
    Accept: "text/html,application/xhtml+xml,application/json"
  };
  let finalUrl = url;
  let html = "";
  try {
    const page = await fetch(url, { redirect: "follow", headers, signal: AbortSignal.timeout(12000) });
    finalUrl = page.url || url;
    html = (await page.text()).slice(0, 1_500_000);
  } catch {
    // Pinterest's oEmbed fallback may still provide a title and image for a short URL.
  }

  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const metadata = new Map<string, string>();
  const imageUrls: string[] = [];
  for (const tag of tags) {
    const property = (getAttribute(tag, "property") || getAttribute(tag, "name"))?.toLowerCase();
    const content = getAttribute(tag, "content");
    if (!property || !content) continue;
    if (["og:title", "twitter:title", "og:description", "twitter:description", "description", "og:url"].includes(property)) {
      if (!metadata.has(property)) metadata.set(property, decodeHtml(content));
    }
    if (["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(property)) {
      try {
        const image = new URL(decodeHtml(content), finalUrl);
        if (image.protocol === "https:" && !isPrivateHost(image.hostname)) imageUrls.push(image.href);
      } catch { /* Ignore malformed metadata URLs. */ }
    }
  }
  const canonicalLink = html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/i)?.[0];
  const canonicalHref = canonicalLink ? getAttribute(canonicalLink, "href") : undefined;
  if (canonicalHref) {
    try {
      const candidate = new URL(decodeHtml(canonicalHref), finalUrl);
      if (isPinterestUrl(candidate.href)) finalUrl = candidate.href;
    } catch { /* Keep the resolved response URL. */ }
  }
  const pageCanonical = metadata.get("og:url");
  if (pageCanonical) {
    try {
      const candidate = new URL(pageCanonical);
      if (isPinterestUrl(candidate.href)) finalUrl = candidate.href;
    } catch { /* Keep the resolved response URL. */ }
  }

  let embedTitle = "";
  let embedImage = "";
  let embedHtml = "";
  for (const candidateUrl of [...new Set([finalUrl, url])]) {
    try {
      const endpoint = new URL("https://www.pinterest.com/oembed.json");
      endpoint.searchParams.set("url", candidateUrl);
      const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) continue;
      const result = await response.json() as { title?: string; thumbnail_url?: string; html?: string };
      embedTitle ||= result.title || "";
      embedImage ||= result.thumbnail_url || "";
      embedHtml ||= result.html || "";
      if (embedTitle || embedImage) break;
    } catch {
      // Continue with Open Graph metadata if Pinterest's embed endpoint is unavailable.
    }
  }
  if (embedImage) {
    try {
      const image = new URL(embedImage);
      if (image.protocol === "https:" && !isPrivateHost(image.hostname)) imageUrls.unshift(image.href);
    } catch { /* Ignore malformed embed thumbnail URLs. */ }
  }
  const pinId = embedHtml.match(/[?&]id=(\d+)/)?.[1];
  if (pinId) finalUrl = `https://www.pinterest.com/pin/${pinId}/`;

  const title = metadata.get("og:title") || metadata.get("twitter:title") || embedTitle ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
  const description = metadata.get("og:description") || metadata.get("twitter:description") || metadata.get("description") || "";
  const text = [title && decodeHtml(title), description && decodeHtml(description)].filter(Boolean).join("\n");
  const renderedImages = await getRenderedPinterestImageUrls(finalUrl || url);
  const imageCandidates = renderedImages.length ? renderedImages : [...new Set(imageUrls)].slice(0, 4);
  const images = await Promise.all(imageCandidates.map(loadImage));
  const usableImages = images.filter((image): image is NonNullable<typeof image> => image !== null);
  if (!text.trim() && !usableImages.length) throw new Error("Не удалось получить содержимое Pinterest-пина.");
  return {
    text: text.slice(0, 6000),
    url: finalUrl,
    images: usableImages,
    links: extractSourceLinks(text, finalUrl)
  };
}

function isPinterestUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host === "pin.it" || host === "pinterest.com" || host.endsWith(".pinterest.com");
  } catch {
    return false;
  }
}

function isInstagramUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

function isInstagramPostUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return isInstagramUrl(value) && /^\/(?:p|reel|tv|stories)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function getInstagramPreview(url: string): Promise<LinkPreview> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; RecommendationBot/1.0)",
    Accept: "text/html,application/xhtml+xml"
  };
  const requestedPostUrl = new URL(url);
  requestedPostUrl.search = "";
  const postUrl = requestedPostUrl.href;
  let finalUrl = postUrl;
  let html = "";
  try {
    const response = await fetch(url, { redirect: "follow", headers, signal: AbortSignal.timeout(12000) });
    if (response.url && isInstagramPostUrl(response.url)) finalUrl = response.url;
    html = (await response.text()).slice(0, 1_500_000);
  } catch {
    // The rendered page may still expose the carousel when direct HTML fetching is blocked.
  }
  const metadata = new Map<string, string>();
  const imageUrls: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const property = (getAttribute(tag, "property") || getAttribute(tag, "name"))?.toLowerCase();
    const content = getAttribute(tag, "content");
    if (!property || !content) continue;
    if (["og:title", "twitter:title", "og:description", "twitter:description", "description", "og:url"].includes(property)) {
      if (!metadata.has(property)) metadata.set(property, decodeHtml(content));
    }
    if (["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(property)) {
      try {
        const image = new URL(decodeHtml(content), finalUrl);
        if (image.protocol === "https:" && !isPrivateHost(image.hostname)) imageUrls.push(image.href);
      } catch { /* Ignore malformed image URLs. */ }
    }
  }
  const canonicalTag = html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/i)?.[0];
  const canonicalHref = canonicalTag ? getAttribute(canonicalTag, "href") : metadata.get("og:url");
  if (canonicalHref) {
    try {
      const canonical = new URL(decodeHtml(canonicalHref), finalUrl);
      if (isInstagramPostUrl(canonical.href)) finalUrl = canonical.href;
    } catch { /* Keep the resolved URL. */ }
  }
  const renderedImages = await getRenderedInstagramImageUrls(postUrl);
  const imageCandidates = renderedImages.length ? renderedImages : [...new Set(imageUrls)].slice(0, 4);
  const loaded = await Promise.all(imageCandidates.map(loadImage));
  const images = loaded.filter((image): image is NonNullable<typeof image> => image !== null);
  const rawTitle = metadata.get("og:title") || metadata.get("twitter:title") ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
  const title = /^(?:instagram|log in \u2022 instagram|sign up \u2022 instagram)$/i.test(rawTitle) ? "" : rawTitle;
  const description = metadata.get("og:description") || metadata.get("twitter:description") || metadata.get("description") || "";
  const text = [title && decodeHtml(title), description && decodeHtml(description)].filter(Boolean).join("\n");
  if (!text.trim() && !images.length) throw new Error("Не удалось получить содержимое Instagram-публикации.");
  return { text: text.slice(0, 6000), url: finalUrl, images, links: extractSourceLinks(text, finalUrl) };
}

async function getRenderedPinterestImageUrls(url: string): Promise<string[]> {
  const executablePath = findChromeExecutable();
  if (!executablePath) return [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1200 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator('img[src*="pinimg.com"]').first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() =>
      [...document.images].some(image => image.src.includes("pinimg.com") && image.complete && image.naturalWidth >= 200 && image.naturalHeight >= 200),
    undefined, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const readMainImage = async () => page.locator("img").evaluateAll(elements =>
      elements.map(element => {
        const image = element as HTMLImageElement;
        const rect = image.getBoundingClientRect();
        return {
          src: image.currentSrc || image.src,
          area: rect.width * rect.height,
          width: rect.width,
          height: rect.height,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight
        };
      }).filter(image =>
        image.src.includes("pinimg.com") && image.area >= 10000 &&
        image.width >= 100 && image.height >= 100 &&
        image.naturalWidth >= 200 && image.naturalHeight >= 200
      ).sort((left, right) => right.area - left.area)
    ).then(images => images[0]?.src || null);

    const collected = new Set<string>();
    const firstImage = await readMainImage();
    if (!firstImage) return [];
    collected.add(firstImage);
    for (let slide = 1; slide < 10; slide++) {
      const nextButton = page.locator([
        'button[aria-label*="next" i]',
        'button[aria-label*="следующ" i]',
        'button[title*="next" i]'
      ].join(", ")).first();
      if (!await nextButton.isVisible().catch(() => false)) break;
      const previousImage = await readMainImage();
      await nextButton.click().catch(() => {});
      await page.waitForFunction(previous => {
        const images = [...document.images].map(image => {
          const rect = image.getBoundingClientRect();
          return { src: image.currentSrc || image.src, area: rect.width * rect.height };
        }).filter(image => image.src.includes("pinimg.com") && image.area > 10000)
          .sort((left, right) => right.area - left.area);
        return Boolean(images[0]?.src && images[0].src !== previous);
      }, previousImage, { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(500);
      const currentImage = await readMainImage();
      if (!currentImage || currentImage === previousImage || collected.has(currentImage)) break;
      collected.add(currentImage);
    }
    return [...collected].slice(0, 10);
  } catch {
    return [];
  } finally {
    await browser?.close().catch(() => {});
  }
}

function extractSourceLinks(text: string, pageUrl: string): string[] {
  const page = new URL(pageUrl);
  return extractUrls(text).filter(link => {
    const parsed = new URL(link);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const isSocialPage = ["threads.com", "threads.net", "instagram.com", "facebook.com", "meta.com"].some(
      domain => host === domain || host.endsWith(`.${domain}`)
    );
    return !isSocialPage && !(parsed.hostname === page.hostname && parsed.pathname === page.pathname);
  });
}

function findChromeExecutable(): string | null {
  if (process.env.CHROME_EXECUTABLE_PATH && existsSync(process.env.CHROME_EXECUTABLE_PATH)) {
    return process.env.CHROME_EXECUTABLE_PATH;
  }
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
      ]
    : process.platform === "win32"
      ? [
          join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
          join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe")
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find(existsSync) || null;
}

function isThreadsUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "threads.com" || hostname.endsWith(".threads.com") ||
      hostname === "threads.net" || hostname.endsWith(".threads.net");
  } catch {
    return false;
  }
}

async function getRenderedInstagramImageUrls(url: string): Promise<string[]> {
  const executablePath = findChromeExecutable();
  if (!executablePath) return [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    });
    const postUrl = new URL(url);
    postUrl.search = "";
    await page.goto(postUrl.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator('img[src*="cdninstagram.com"]').first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() =>
      [...document.images].some(image => image.src.includes("cdninstagram.com") && image.complete && image.naturalWidth >= 200 && image.naturalHeight >= 200),
    undefined, { timeout: 15000 }).catch(() => {});

    const imageSelector = 'img[src*="cdninstagram.com"]';
    const readMainImage = async () => page.locator(imageSelector).evaluateAll(elements => {
      const images = elements.map(element => {
        const image = element as HTMLImageElement;
        const rect = image.getBoundingClientRect();
        return { src: image.currentSrc || image.src, area: rect.width * rect.height, width: rect.width, height: rect.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
      }).filter(image => image.width >= 160 && image.height >= 160 && image.naturalWidth >= 200 && image.naturalHeight >= 200);
      return images.sort((left, right) => right.area - left.area)[0]?.src || null;
    }).catch(() => null);

    const collected = new Set<string>();
    const firstImage = await readMainImage();
    if (firstImage) collected.add(firstImage);
    for (let slide = 1; slide < 10; slide++) {
      const nextButton = page.locator('button[aria-label*="next" i], button[aria-label*="следующ" i], button[title*="next" i]').first();
      if (!await nextButton.isVisible().catch(() => false)) break;
      const previousImage = await readMainImage();
      await nextButton.click().catch(() => {});
      await page.waitForFunction(previous => {
        const images = [...document.querySelectorAll<HTMLImageElement>('img[src*="cdninstagram.com"]')].map(image => {
          const rect = image.getBoundingClientRect();
          return { image, area: rect.width * rect.height };
        }).filter(item => item.area > 10000)
          .sort((left, right) => right.area - left.area);
        const current = images[0]?.image.currentSrc || images[0]?.image.src;
        return Boolean(current && current !== previous);
      }, previousImage, { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(450);
      const currentImage = await readMainImage();
      if (!currentImage || currentImage === previousImage || collected.has(currentImage)) break;
      collected.add(currentImage);
    }
    return [...collected].slice(0, 10);
  } catch {
    return [];
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function getRenderedPostImageUrls(url: string): Promise<string[]> {
  const executablePath = findChromeExecutable();
  if (!executablePath) return [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const declineCookies = page.getByRole("button", { name: "Decline optional cookies" });
    if (await declineCookies.isVisible().catch(() => false)) await declineCookies.click().catch(() => {});
    await page.locator('img[src*="cdninstagram.com"]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() =>
      [...document.images].filter(image => {
        const rect = image.getBoundingClientRect();
        return image.src.includes("cdninstagram.com") && image.complete &&
          image.naturalWidth >= 160 && image.naturalHeight >= 160 &&
          rect.width >= 120 && rect.height >= 120;
      }).length >= 2,
    undefined, { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(600);
    const loadedImages = await page.locator("img").evaluateAll(elements =>
      elements.map(element => {
        const image = element as HTMLImageElement;
        const rect = image.getBoundingClientRect();
        return {
          src: image.currentSrc || image.src,
          top: rect.top + window.scrollY,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight
        };
      }).filter(image =>
        image.src.includes("cdninstagram.com") &&
        image.width >= 120 && image.height >= 120 &&
        image.naturalWidth >= 160 && image.naturalHeight >= 160
      ).sort((a, b) => a.top - b.top || a.left - b.left)
    );
    if (!loadedImages.length) return [];
    const firstRowTop = loadedImages[0].top;
    return [...new Set(loadedImages
      .filter(image => Math.abs(image.top - firstRowTop) < 80)
      .map(image => image.src))].slice(0, 10);
  } catch {
    return [];
  } finally {
    await browser?.close().catch(() => {});
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || host.startsWith("fc") || host.startsWith("fd");
}

async function loadImage(url: string): Promise<{ mimeType: string; dataUrl: string } | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RecommendationBot/1.0)" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return null;
    const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!mimeType || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) return null;
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > 5_000_000) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 5_000_000) return null;
    return { mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
  } catch {
    return null;
  }
}

export function extractUrl(text: string): string | null {
  const urls = extractUrls(text);
  return urls.find(url => isThreadsUrl(url) || isInstagramUrl(url) || isPinterestUrl(url)) || urls[0] || null;
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/(?:https?:\/\/|www\.)[^\s<>\"'()]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s<>\"'()]+/gi) || [];
  return [...new Set(matches
    .map(candidate => {
      const trimmed = candidate.replace(/[.,!?;:]+$/, "");
      return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    })
    .filter(url => {
      try {
        const parsed = new URL(url);
        return (parsed.protocol === "https:" || parsed.protocol === "http:") && !isPrivateHost(parsed.hostname);
      } catch { return false; }
    }))].slice(0, 20);
}
