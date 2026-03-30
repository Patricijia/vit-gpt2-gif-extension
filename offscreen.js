import { pipeline, env, RawImage } from "@huggingface/transformers";
import Tesseract from "tesseract.js";

// Load ONNX runtime files from the extension instead of CDN
env.backends.onnx.wasm.wasmPaths = "./";

let captioner = null;
let loadPromise = null;
let ocrWorker = null;
let modelLoadTime = 0;
let ocrLoadTime = 0;

// === Load vit-gpt2 captioning model ===
async function loadModel() {
  if (captioner) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const t0 = performance.now();
    console.log("[offscreen] Loading vit-gpt2 on WebGPU...");
    captioner = await pipeline(
      "image-to-text",
      "Xenova/vit-gpt2-image-captioning",
      { device: "webgpu", dtype: "fp32" },
    );
    modelLoadTime = performance.now() - t0;
    console.log(`[offscreen] vit-gpt2 ready in ${modelLoadTime.toFixed(0)}ms`);
  })();

  return loadPromise;
}

// === Load Tesseract OCR worker ===
let ocrLoadPromise = null;

async function loadOCR() {
  if (ocrWorker) return;
  if (ocrLoadPromise) return ocrLoadPromise;

  ocrLoadPromise = (async () => {
    const t0 = performance.now();
    console.log("[offscreen] Loading Tesseract OCR...");
    console.log("[offscreen] Worker path:", chrome.runtime.getURL("tesseract/worker.min.js"));
    console.log("[offscreen] Lang path:", chrome.runtime.getURL("tesseract"));
    console.log("[offscreen] Core path:", chrome.runtime.getURL("tesseract/"));
    try {
      ocrWorker = await Tesseract.createWorker("eng", 1, {
        workerPath: chrome.runtime.getURL("tesseract/worker.min.js"),
        langPath: chrome.runtime.getURL("tesseract"),
        corePath: chrome.runtime.getURL("tesseract/"),
        workerBlobURL: false,
        gzip: false,
      });
      ocrLoadTime = performance.now() - t0;
      console.log(`[offscreen] Tesseract OCR ready in ${ocrLoadTime.toFixed(0)}ms`);
    } catch (e) {
      console.error("[offscreen] OCR init failed:", e.message, e.stack);
      ocrWorker = null;
    }
  })();

  return ocrLoadPromise;
}

// Load both in parallel on startup
loadModel();
loadOCR();

// === Extract 4 key frames (evenly spaced) ===
const NUM_FRAMES = 4;

async function extractKeyFrames(url) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();

  if (typeof ImageDecoder === "undefined") {
    const blob = new Blob([buffer], { type: "image/gif" });
    return { frames: [await RawImage.fromBlob(blob)], frameCount: 1 };
  }

  const decoder = new ImageDecoder({
    data: new Uint8Array(buffer),
    type: "image/gif",
  });

  await decoder.tracks.ready;
  const frameCount = decoder.tracks.selectedTrack.frameCount;
  const numFrames = Math.min(NUM_FRAMES, frameCount);

  const indices = [];
  for (let i = 0; i < numFrames; i++) {
    indices.push(Math.floor(i * (frameCount - 1) / Math.max(numFrames - 1, 1)));
  }

  const frames = [];
  for (const idx of indices) {
    const { image } = await decoder.decode({ frameIndex: idx });
    const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
    canvas.getContext("2d").drawImage(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    frames.push(await RawImage.fromBlob(blob));
  }

  decoder.close();
  return { frames, frameCount };
}

// === Extract a frame as data URL for OCR ===
async function extractOCRFrames(url) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();

  if (typeof ImageDecoder === "undefined") {
    const blob = new Blob([buffer], { type: "image/png" });
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return [URL.createObjectURL(outBlob)];
  }

  const decoder = new ImageDecoder({
    data: new Uint8Array(buffer),
    type: "image/gif",
  });
  await decoder.tracks.ready;
  const frameCount = decoder.tracks.selectedTrack.frameCount;

  // First and middle frame for OCR
  const ocrIndices = [0, Math.max(0, Math.floor(frameCount / 2) - 1)];
  const urls = [];

  for (const idx of ocrIndices) {
    const { image } = await decoder.decode({ frameIndex: idx });
    const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
    canvas.getContext("2d").drawImage(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    urls.push(URL.createObjectURL(blob));
  }

  decoder.close();
  return urls;
}

// === OCR: extract text from frames ===
function cleanOcrText(rawText) {
  if (!rawText) return "";
  let text = rawText.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const allWords = text.split(" ").filter(w => w.length > 0);
  if (allWords.length === 0) return "";
  const shortCount = allWords.filter(w => w.replace(/[^a-zA-Z0-9]/g, "").length <= 2).length;
  if (allWords.length > 2 && shortCount / allWords.length > 0.4) return "";
  const words = allWords.filter(w => {
    const clean = w.replace(/[^a-zA-Z0-9]/g, "");
    if (clean.length < 2) return false;
    if (clean.length >= 3 && !/[aeiouyAEIOUY]/.test(clean)) return false;
    return true;
  });
  text = words.join(" ").trim();
  return text.length < 3 ? "" : text;
}

// Isolate text by color: extract white-on-dark and dark-on-light text
// Returns { white: blobUrl, black: blobUrl }
async function isolateTextByColor(blobUrl) {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, h = bmp.height;

  const srcCanvas = new OffscreenCanvas(w, h);
  const srcCtx = srcCanvas.getContext("2d");
  srcCtx.drawImage(bmp, 0, 0);
  const src = srcCtx.getImageData(0, 0, w, h);

  const whiteCanvas = new OffscreenCanvas(w, h);
  const whiteCtx = whiteCanvas.getContext("2d");
  const whiteData = whiteCtx.createImageData(w, h);

  const blackCanvas = new OffscreenCanvas(w, h);
  const blackCtx = blackCanvas.getContext("2d");
  const blackData = blackCtx.createImageData(w, h);

  for (let i = 0; i < src.data.length; i += 4) {
    const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
    // White/light text isolation: light pixels become black text on white bg
    const isLight = r > 200 && g > 200 && b > 200;
    whiteData.data[i]     = isLight ? 0 : 255;
    whiteData.data[i + 1] = isLight ? 0 : 255;
    whiteData.data[i + 2] = isLight ? 0 : 255;
    whiteData.data[i + 3] = 255;
    // Dark text isolation: dark pixels become black text on white bg
    const isDark = r < 55 && g < 55 && b < 55;
    blackData.data[i]     = isDark ? 0 : 255;
    blackData.data[i + 1] = isDark ? 0 : 255;
    blackData.data[i + 2] = isDark ? 0 : 255;
    blackData.data[i + 3] = 255;
  }

  whiteCtx.putImageData(whiteData, 0, 0);
  blackCtx.putImageData(blackData, 0, 0);

  const [whiteBlob, blackBlob] = await Promise.all([
    whiteCanvas.convertToBlob({ type: "image/png" }),
    blackCanvas.convertToBlob({ type: "image/png" }),
  ]);

  return {
    white: URL.createObjectURL(whiteBlob),
    black: URL.createObjectURL(blackBlob),
  };
}

async function extractTextFromFrame(blobUrl) {
  if (!ocrWorker) return "";
  try {
    const isolated = await isolateTextByColor(blobUrl);
    const [whiteResult, blackResult] = await Promise.all([
      ocrWorker.recognize(isolated.white),
      ocrWorker.recognize(isolated.black),
    ]);
    URL.revokeObjectURL(isolated.white);
    URL.revokeObjectURL(isolated.black);

    const whiteText = cleanOcrText(whiteResult.data.text?.trim() || "");
    const blackText = cleanOcrText(blackResult.data.text?.trim() || "");
    return whiteText.length >= blackText.length ? whiteText : blackText;
  } catch {
    return "";
  }
}

async function extractTextBestOf(blobUrls) {
  const results = await Promise.all(blobUrls.map(u => extractTextFromFrame(u)));
  blobUrls.forEach(u => URL.revokeObjectURL(u));
  return results.reduce((best, t) => t.length > best.length ? t : best, "");
}

// === Caption a single frame ===
async function captionFrame(frame) {
  const result = await captioner(frame, { max_new_tokens: 15 });
  return result[0].generated_text.trim();
}

// === Summarize multiple frame captions via weighted selection ===
//
// Algorithm:
// 1. Tokenize each caption into a word set
// 2. Score each caption by:
//    - representativeness: avg word overlap with all other captions (0-1)
//    - informativeness:    word count normalized (longer = more detail)
//    Combined score = 0.7 * representativeness + 0.3 * informativeness
// 3. Select the highest-scoring caption as the primary description
// 4. Find the most distinctive new detail from remaining captions
//    (words not present in the primary) and append it
//
function summarizeCaptions(captions) {
  if (captions.length === 0) return "";
  if (captions.length === 1) return captions[0];

  // Normalize and tokenize
  const STOP_WORDS = new Set([
    "a", "an", "the", "is", "in", "of", "on", "at", "to", "and", "with",
    "for", "from", "that", "this", "are", "was", "has", "his", "her", "its",
  ]);

  function tokenize(text) {
    return text.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(w => w.length > 1);
  }

  function contentWords(tokens) {
    return tokens.filter(w => !STOP_WORDS.has(w));
  }

  function wordOverlap(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return 0;
    let shared = 0;
    for (const w of setA) if (setB.has(w)) shared++;
    return shared / Math.max(setA.size, setB.size);
  }

  const tokenized = captions.map(c => ({
    original: c,
    tokens: tokenize(c),
    contentSet: new Set(contentWords(tokenize(c))),
  }));

  // Score each caption
  const scored = tokenized.map((item, i) => {
    // Representativeness: average word overlap with all OTHER captions
    let totalOverlap = 0;
    let comparisons = 0;
    for (let j = 0; j < tokenized.length; j++) {
      if (j === i) continue;
      totalOverlap += wordOverlap(item.contentSet, tokenized[j].contentSet);
      comparisons++;
    }
    const representativeness = comparisons > 0 ? totalOverlap / comparisons : 0;

    // Informativeness: normalized word count (more content words = more detail)
    const maxContent = Math.max(...tokenized.map(t => t.contentSet.size), 1);
    const informativeness = item.contentSet.size / maxContent;

    const score = 0.7 * representativeness + 0.3 * informativeness;

    return { ...item, representativeness, informativeness, score };
  });

  // Select primary caption (highest combined score)
  scored.sort((a, b) => b.score - a.score);
  const primary = scored[0];

  // Find distinctive detail from the most different caption
  // Look at the lowest-scoring caption (most different) for unique words
  const others = scored.slice(1);
  let bestDetail = null;
  let bestDetailScore = -1;

  for (const other of others) {
    // Words in this caption but NOT in the primary
    const newWords = [];
    for (const w of other.contentSet) {
      if (!primary.contentSet.has(w)) newWords.push(w);
    }
    if (newWords.length === 0) continue;

    // Find a contiguous phrase in the original caption containing these new words
    // by extracting the clause that has the most new content
    const otherLower = other.original.toLowerCase();
    // Split on common conjunctions to get clauses
    const clauses = otherLower.split(/\b(?:is |with |and |in )\b/).filter(c => c.trim().length > 2);

    for (const clause of clauses) {
      const clauseWords = new Set(contentWords(tokenize(clause)));
      let newCount = 0;
      for (const w of clauseWords) {
        if (!primary.contentSet.has(w)) newCount++;
      }
      // Score this clause: how many new words it brings
      if (newCount > bestDetailScore && clauseWords.size > 0) {
        bestDetailScore = newCount;
        bestDetail = clause.trim().replace(/^(a |an |the |is |are )/i, "").trim();
      }
    }
  }

  // Build final caption
  let result = primary.original;

  if (bestDetail && bestDetail.length > 2 && !result.toLowerCase().includes(bestDetail)) {
    result += " and " + bestDetail;
  }

  // Cap at 120 chars for accessibility readability
  if (result.length > 120) result = result.slice(0, 117) + "...";

  return result;
}

// === Describe GIF with full metrics ===
async function describeGif(url) {
  const t0 = performance.now();

  // Ensure models are loaded
  await Promise.all([loadModel(), loadOCR()]);
  const tModelsReady = performance.now();

  // Extract frames for captioning and OCR in parallel
  const [{ frames, frameCount }, ocrBlobUrls] = await Promise.all([
    extractKeyFrames(url),
    extractOCRFrames(url),
  ]);
  const tFrames = performance.now();

  // Run captioning and OCR in parallel
  const captionPromise = (async () => {
    const perFrameTimes = [];
    const captions = [];
    for (const frame of frames) {
      const ft0 = performance.now();
      captions.push(await captionFrame(frame));
      perFrameTimes.push(performance.now() - ft0);
    }
    return { captions, perFrameTimes };
  })();

  const ocrPromise = extractTextBestOf(ocrBlobUrls);

  const [{ captions, perFrameTimes }, ocrText] = await Promise.all([captionPromise, ocrPromise]);
  const tInference = performance.now();

  // Summarize
  let caption = summarizeCaptions(captions);
  if (ocrText && ocrText.length > 3) {
    caption += ". Text: " + ocrText;
  }
  const tSummary = performance.now();

  // Build metrics
  const metrics = {
    modelLoadMs: Math.round(modelLoadTime),
    ocrLoadMs: Math.round(ocrLoadTime),
    frameExtractionMs: Math.round(tFrames - tModelsReady),
    totalInferenceMs: Math.round(tInference - tFrames),
    perFrameInferenceMs: perFrameTimes.map(t => Math.round(t)),
    avgFrameInferenceMs: Math.round(perFrameTimes.reduce((a, b) => a + b, 0) / perFrameTimes.length),
    summaryMs: Math.round(tSummary - tInference),
    totalMs: Math.round(tSummary - t0),
    framesExtracted: frames.length,
    totalGifFrames: frameCount,
    ocrDetected: ocrText.length > 0,
    ocrText: ocrText || null,
  };

  console.log(
    `[offscreen] ${metrics.totalMs}ms total | ` +
    `frames: ${metrics.frameExtractionMs}ms, ` +
    `inference: ${metrics.totalInferenceMs}ms (avg ${metrics.avgFrameInferenceMs}ms/frame), ` +
    `summary: ${metrics.summaryMs}ms | ` +
    `${frames.length}/${frameCount} frames | ` +
    `OCR: ${ocrText ? `"${ocrText}"` : "none"} | ` +
    `captions: ${JSON.stringify(captions)} → "${caption}"`
  );

  return { caption, metrics };
}

// === Message handler ===
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "DESCRIBE_GIF" || message.target !== "offscreen") return;

  describeGif(message.url)
    .then(({ caption, metrics }) => sendResponse({ caption, metrics }))
    .catch((err) => {
      console.error("[offscreen] Error:", err);
      sendResponse({ error: err.message });
    });

  return true;
});
