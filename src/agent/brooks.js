// Brooks Trading Course 每日报告抓取 + 翻译。
// 数据源：WordPress 公开 REST API（自带 CORS: *，无需后端）。
// 分类 153 = "Emini & Forex Daily Reports"（每日 E-mini 复盘与展望）。

import { callClaude } from "./claude";
import { TRANSLATE_SYSTEM } from "./prompts";

const API = "https://www.brookstradingcourse.com/wp-json/wp/v2/posts";
const CATEGORY_ID = 153;
const MAX_CACHED_POSTS = 10;

/** 抓取最新若干篇日报（含正文 HTML）。cb 参数 + no-store 双重防缓存，确保能拿到刚发布的文章 */
export async function fetchLatestPosts(count = 5) {
  // 只用简单请求头（不触发 CORS preflight）+ URL 时间戳参数防缓存
  const url = `${API}?categories=${CATEGORY_ID}&per_page=${count}&_fields=id,date_gmt,modified_gmt,link,title,content&_=${Date.now()}`;
  const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`Brooks 博客请求失败（HTTP ${res.status}）`);
  const posts = await res.json();
  return posts.map((p) => {
    const html = sanitizeArticle(p.content?.rendered || "");
    return {
      id: p.id,
      date: String(p.date_gmt || "").slice(0, 10),
      modified: p.modified_gmt || "",
      link: p.link,
      title: decodeEntities(p.title?.rendered || ""),
      html,
      setupsImage: extractSetupsImage(html),
      zh: "",
      translatedAt: "",
    };
  });
}

/** 翻译一篇文章为中文 HTML */
export async function translatePost(post, claudeCfg) {
  const zh = await callClaude(claudeCfg, {
    system: TRANSLATE_SYSTEM,
    messages: [{ role: "user", content: `请翻译这篇 Al Brooks 每日市场报告：\n\n<h1>${post.title}</h1>\n${post.html}` }],
    maxTokens: 16000,
  });
  return zh.replace(/^```html?\s*/i, "").replace(/```\s*$/, "").trim();
}

/**
 * 同步：抓最新文章，合并进缓存（去重、按日期倒序、截断）。
 * 返回 { posts, added }；added 为新增文章数。
 */
export async function syncPosts(cachedPosts) {
  const latest = await fetchLatestPosts(5);
  const cache = new Map((cachedPosts || []).map((p) => [p.id, p]));
  let added = 0;
  for (const post of latest) {
    const cached = cache.get(post.id);
    if (!cached) {
      cache.set(post.id, post);
      added += 1;
    } else if (post.modified && cached.modified !== post.modified) {
      // 文章盘后被追加更新（今日总结图、EOD 视频）→ 替换正文并重新翻译
      cache.set(post.id, post);
      added += 1;
    }
  }
  const posts = [...cache.values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id)
    .slice(0, MAX_CACHED_POSTS);
  return { posts, added };
}

/** 清洗 WP 正文：去脚本/表单/iframe，修复懒加载图片 src */
export function sanitizeArticle(html) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return html;
  }
  doc.querySelectorAll("script, style, form, noscript").forEach((el) => el.remove());
  // 视频 iframe 换成外链
  doc.querySelectorAll("iframe").forEach((el) => {
    const src = el.getAttribute("src") || "";
    const a = doc.createElement("a");
    a.href = src;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = "▶ 观看原文视频";
    el.replaceWith(a);
  });
  // WP Rocket 懒加载：data-lazy-src → src
  doc.querySelectorAll("img").forEach((img) => {
    const lazy = img.getAttribute("data-lazy-src") || img.getAttribute("data-src");
    if (lazy) img.setAttribute("src", lazy);
    const lazySet = img.getAttribute("data-lazy-srcset") || img.getAttribute("data-srcset");
    if (lazySet) img.setAttribute("srcset", lazySet);
    img.removeAttribute("loading");
    ["data-lazy-src", "data-src", "data-lazy-srcset", "data-srcset", "data-lazy-sizes"].forEach((attr) => img.removeAttribute(attr));
  });
  return doc.body.innerHTML;
}

/**
 * 提取 "Yesterday's E-mini setups" 的图（Jed 标注买卖入场箭头的那张）。
 * 优先：匹配 setups 标题后的第一张图；兜底：alt/src 含 setup 的图。
 */
export function extractSetupsImage(html) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return "";
  }
  const isSetupsHeading = (el) => /e-?mini setups/i.test(el.textContent || "");
  const headings = [...doc.querySelectorAll("h1,h2,h3,h4,strong,b")].filter(isSetupsHeading);
  for (const heading of headings) {
    let node = heading.closest("p,h1,h2,h3,h4,div") || heading;
    for (let i = 0; i < 8 && node; i += 1) {
      node = node.nextElementSibling;
      const img = node?.tagName === "IMG" ? node : node?.querySelector?.("img");
      if (img?.getAttribute("src")) return largestSrc(img);
    }
  }
  const fallback = [...doc.querySelectorAll("img")].find((img) => /setup/i.test(`${img.getAttribute("alt") || ""} ${img.getAttribute("src") || ""}`));
  return fallback ? largestSrc(fallback) : "";
}

function largestSrc(img) {
  // srcset 里取最大宽度的，避免拿到 150x150 缩略图
  const srcset = img.getAttribute("srcset");
  if (srcset) {
    const candidates = srcset.split(",").map((s) => {
      const [url, w] = s.trim().split(/\s+/);
      return { url, w: parseInt(w, 10) || 0 };
    }).sort((a, b) => b.w - a.w);
    if (candidates[0]?.url) return candidates[0].url;
  }
  // WP 缩略图命名 -150x150 / -300x200 → 去掉尺寸后缀拿原图
  const src = img.getAttribute("src") || "";
  return src.replace(/-\d{2,4}x\d{2,4}(\.\w{3,4})$/, "$1");
}

function decodeEntities(text) {
  const el = document.createElement("textarea");
  el.innerHTML = text;
  return el.value;
}
