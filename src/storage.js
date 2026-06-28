import { convertFileSrc } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readFile, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { DEFAULT_STATE } from "./data";

const DATA_FILE = "data.json";
const IMAGES_DIR = "images";

const canUseTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function ensureStore() {
  if (!canUseTauri()) return { dir: "browser-localStorage", file: DATA_FILE };

  const dir = await appLocalDataDir();
  const imageDir = await join(dir, IMAGES_DIR);
  if (!(await exists(imageDir))) {
    await mkdir(imageDir, { recursive: true });
  }

  const file = await join(dir, DATA_FILE);
  if (!(await exists(file))) {
    await writeTextFile(file, JSON.stringify(DEFAULT_STATE, null, 2));
  }
  return { dir, file, imageDir };
}

export async function loadState() {
  if (!canUseTauri()) {
    const raw = localStorage.getItem("trade-desk-data");
    return raw ? JSON.parse(raw) : DEFAULT_STATE;
  }

  const { file } = await ensureStore();
  const raw = await readTextFile(file);
  return { ...DEFAULT_STATE, ...JSON.parse(raw) };
}

export async function saveState(state) {
  if (!canUseTauri()) {
    localStorage.setItem("trade-desk-data", JSON.stringify(state));
    return;
  }

  const { file } = await ensureStore();
  await writeTextFile(file, JSON.stringify(state, null, 2));
}

export async function saveImage(file) {
  const ext = file.type?.split("/")[1] || "png";
  const name = `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

  if (!canUseTauri()) {
    return { name, src: URL.createObjectURL(file), path: name };
  }

  const { dir, imageDir } = await ensureStore();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const path = await join(imageDir, name);
  await writeFile(path, bytes);
  return { name, path: await join(IMAGES_DIR, name), src: convertFileSrc(await join(dir, IMAGES_DIR, name)) };
}

/** 把已保存的截图读成 base64（给 Claude 视觉用） */
export async function readImageBase64(image) {
  if (!image) return null;
  if (image.base64) return { base64: image.base64, mediaType: image.mediaType || "image/png" };
  if (!canUseTauri()) return null;

  const { dir } = await ensureStore();
  const bytes = await readFile(await join(dir, image.path || `${IMAGES_DIR}/${image.name}`));
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const ext = (image.name || "").split(".").pop()?.toLowerCase();
  const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
  return { base64: btoa(binary), mediaType };
}

/** 用 data URL 显示截图（不依赖 asset 协议，最稳） */
export async function imageDataUrl(image) {
  try {
    const data = await readImageBase64(image);
    if (data) return `data:${data.mediaType};base64,${data.base64}`;
  } catch {
    // 回退到 src
  }
  return image?.src || "";
}

export async function resolveImageSrc(image) {
  if (!image) return "";
  if (image.src) return image.src;
  if (!canUseTauri()) return "";

  const { dir } = await ensureStore();
  return convertFileSrc(await join(dir, image.path || image.name));
}

export async function revealDataFile() {
  if (!canUseTauri()) return;
  const { file } = await ensureStore();
  await revealItemInDir(file);
}
