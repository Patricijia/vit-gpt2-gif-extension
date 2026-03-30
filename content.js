const PAGE_START = performance.now();
console.log("GIF Accessibility Reader running...");

const seen = new Set();
const retryCount = new Map();
const MAX_RETRIES = 10;
let labelsApplied = 0;
let totalGifs = 0;

// Collect metrics for final summary
const allMetrics = [];
let firstModelLoadMs = null;
let firstOcrLoadMs = null;

async function labelGif(gif) {
  const url = gif.src;
  if (seen.has(url)) return;
  seen.add(url);

  const t0 = performance.now();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "DESCRIBE_GIF",
      url,
    });

    if (response.error) throw new Error(response.error);

    const label = response.caption;
    const metrics = response.metrics;

    gif.alt = label;
    gif.setAttribute("aria-label", label);
    gif.setAttribute("tabindex", "0");

    // Display label visually next to image
    const tag = document.createElement("span");
    tag.innerText = label;
    tag.style.cssText = `
      background: yellow;
      color: black;
      font-size: 12px;
      padding: 2px 4px;
      position: absolute;
      z-index: 9999;
      left: ${gif.getBoundingClientRect().right + window.scrollX + 5}px;
      top: ${gif.getBoundingClientRect().top + window.scrollY}px;
      max-width: 300px;
      display: inline-block;
    `;
    document.body.appendChild(tag);

    retryCount.delete(url);
    labelsApplied++;

    // Store metrics
    if (metrics) {
      if (firstModelLoadMs === null) firstModelLoadMs = metrics.modelLoadMs;
      if (firstOcrLoadMs === null) firstOcrLoadMs = metrics.ocrLoadMs;
      allMetrics.push({
        gifIndex: labelsApplied,
        url: url.slice(0, 80),
        caption: label,
        ...metrics,
        wallClockMs: Math.round(performance.now() - t0),
        sincePageLoadMs: Math.round(performance.now() - PAGE_START),
      });
    }

    const elapsed = (performance.now() - t0).toFixed(0);
    const sincePageLoad = (performance.now() - PAGE_START).toFixed(0);
    console.log(
      `[a11y] GIF ${labelsApplied}/${totalGifs} labeled in ${elapsed}ms ` +
      `(${sincePageLoad}ms since page load) | "${label}"` +
      (metrics ? ` | frames: ${metrics.frameExtractionMs}ms, inference: ${metrics.totalInferenceMs}ms` +
        ` (avg ${metrics.avgFrameInferenceMs}ms/frame), OCR: ${metrics.ocrDetected ? `"${metrics.ocrText}"` : "none"}` : "")
    );

    if (labelsApplied === totalGifs) {
      printFinalSummary();
    }
  } catch (err) {
    const attempts = (retryCount.get(url) || 0) + 1;
    if (attempts < MAX_RETRIES) {
      retryCount.set(url, attempts);
      seen.delete(url);
      console.warn(
        `GIF label failed (attempt ${attempts}/${MAX_RETRIES}), retrying:`,
        url,
        err
      );
      labelGif(gif);
    } else {
      retryCount.delete(url);
      console.error(
        `GIF label failed: giving up after ${MAX_RETRIES} attempts:`,
        url,
        err
      );
    }
  }
}

function printFinalSummary() {
  const totalTime = Math.round(performance.now() - PAGE_START);

  const frameExtractionTimes = allMetrics.map(m => m.frameExtractionMs);
  const inferenceTimes = allMetrics.map(m => m.totalInferenceMs);
  const avgFrameTimes = allMetrics.map(m => m.avgFrameInferenceMs);
  const totalTimes = allMetrics.map(m => m.totalMs);
  const wallClockTimes = allMetrics.map(m => m.wallClockMs);
  const ocrCount = allMetrics.filter(m => m.ocrDetected).length;

  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const min = arr => arr.length ? Math.round(Math.min(...arr)) : 0;
  const max = arr => arr.length ? Math.round(Math.max(...arr)) : 0;
  const sum = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0)) : 0;

  console.log("\n");
  console.log("=".repeat(70));
  console.log("  GIF ACCESSIBILITY BENCHMARK RESULTS");
  console.log("=".repeat(70));
  console.log(`  Model:              vit-gpt2-image-captioning (WebGPU fp32)`);
  console.log(`  OCR:                Tesseract.js`);
  console.log(`  Frames per GIF:     ${allMetrics[0]?.framesExtracted || "N/A"}`);
  console.log(`  Total GIFs:         ${totalGifs}`);
  console.log("-".repeat(70));
  console.log("  LOADING");
  console.log(`    Model load:       ${firstModelLoadMs}ms`);
  console.log(`    OCR load:         ${firstOcrLoadMs}ms`);
  console.log("-".repeat(70));
  console.log("  PER-GIF METRICS (ms)          Avg      Min      Max    Total");
  console.log(`    Frame extraction:     ${String(avg(frameExtractionTimes)).padStart(8)} ${String(min(frameExtractionTimes)).padStart(8)} ${String(max(frameExtractionTimes)).padStart(8)} ${String(sum(frameExtractionTimes)).padStart(8)}`);
  console.log(`    Inference (total):    ${String(avg(inferenceTimes)).padStart(8)} ${String(min(inferenceTimes)).padStart(8)} ${String(max(inferenceTimes)).padStart(8)} ${String(sum(inferenceTimes)).padStart(8)}`);
  console.log(`    Inference (per-frame):${String(avg(avgFrameTimes)).padStart(8)} ${String(min(avgFrameTimes)).padStart(8)} ${String(max(avgFrameTimes)).padStart(8)}        -`);
  console.log(`    Pipeline (total):     ${String(avg(totalTimes)).padStart(8)} ${String(min(totalTimes)).padStart(8)} ${String(max(totalTimes)).padStart(8)} ${String(sum(totalTimes)).padStart(8)}`);
  console.log(`    Wall clock:           ${String(avg(wallClockTimes)).padStart(8)} ${String(min(wallClockTimes)).padStart(8)} ${String(max(wallClockTimes)).padStart(8)} ${String(sum(wallClockTimes)).padStart(8)}`);
  console.log("-".repeat(70));
  console.log("  OCR");
  console.log(`    GIFs with text:   ${ocrCount}/${totalGifs}`);
  console.log("-".repeat(70));
  console.log("  TOTALS");
  console.log(`    Page load → all accessible: ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);
  console.log(`    First GIF accessible at:    ${allMetrics[0]?.sincePageLoadMs || "N/A"}ms`);
  console.log(`    Last GIF accessible at:     ${allMetrics[allMetrics.length - 1]?.sincePageLoadMs || "N/A"}ms`);
  console.log(`    Avg time per GIF:           ${avg(wallClockTimes)}ms`);
  console.log("=".repeat(70));

  // Also log per-GIF table
  console.log("\n  PER-GIF BREAKDOWN:");
  console.log("  #   Frames  Extract  Inference  AvgFrame  OCR     Total   Since Load");
  for (const m of allMetrics) {
    console.log(
      `  ${String(m.gifIndex).padStart(2)}  ` +
      `${String(m.framesExtracted + "/" + m.totalGifFrames).padStart(7)}  ` +
      `${String(m.frameExtractionMs).padStart(7)}  ` +
      `${String(m.totalInferenceMs).padStart(9)}  ` +
      `${String(m.avgFrameInferenceMs).padStart(8)}  ` +
      `${String(m.ocrDetected ? "yes" : "no").padStart(3)}  ` +
      `${String(m.totalMs).padStart(7)}  ` +
      `${String(m.sincePageLoadMs).padStart(10)}`
    );
  }
  console.log("=".repeat(70));

  // Save metrics to files
  saveMetrics(totalTime, ocrCount);
}

function saveMetrics(totalTime, ocrCount) {
  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  // Build JSON report (run_id added by background.js)
  const report = {
    timestamp: new Date().toISOString(),
    pageUrl: window.location.href,
    config: {
      model: "Xenova/vit-gpt2-image-captioning",
      device: "webgpu",
      dtype: "fp32",
      framesPerGif: allMetrics[0]?.framesExtracted || 4,
      ocr: "tesseract.js",
    },
    summary: {
      totalGifs,
      modelLoadMs: firstModelLoadMs,
      ocrLoadMs: firstOcrLoadMs,
      pageLoadToAllAccessibleMs: totalTime,
      firstGifAccessibleMs: allMetrics[0]?.sincePageLoadMs || null,
      lastGifAccessibleMs: allMetrics[allMetrics.length - 1]?.sincePageLoadMs || null,
      avgWallClockPerGifMs: avg(allMetrics.map(m => m.wallClockMs)),
      avgFrameExtractionMs: avg(allMetrics.map(m => m.frameExtractionMs)),
      avgInferenceMs: avg(allMetrics.map(m => m.totalInferenceMs)),
      avgPerFrameInferenceMs: avg(allMetrics.map(m => m.avgFrameInferenceMs)),
      gifsWithOcr: ocrCount,
    },
    perGif: allMetrics,
  };

  // Save JSON (run_id is assigned by background.js based on stored run count)
  chrome.runtime.sendMessage({
    type: "SAVE_METRICS",
    format: "json",
    data: JSON.stringify(report, null, 2),
  });
  console.log("[a11y] JSON metrics sent to background for saving");

  // Build CSV
  const csvHeader = [
    "gif_index", "url", "total_gif_frames", "frames_extracted",
    "frame_extraction_ms", "total_inference_ms", "avg_frame_inference_ms",
    "per_frame_inference_ms", "summary_ms", "ocr_detected", "ocr_text",
    "total_pipeline_ms", "wall_clock_ms", "since_page_load_ms",
    "model_load_ms", "ocr_load_ms", "caption"
  ].join(",");

  const csvRows = allMetrics.map(m => [
    m.gifIndex,
    `"${(m.url || "").replace(/"/g, '""')}"`,
    m.totalGifFrames,
    m.framesExtracted,
    m.frameExtractionMs,
    m.totalInferenceMs,
    m.avgFrameInferenceMs,
    `"${(m.perFrameInferenceMs || []).join(";")}"`,
    m.summaryMs,
    m.ocrDetected ? 1 : 0,
    `"${(m.ocrText || "").replace(/"/g, '""')}"`,
    m.totalMs,
    m.wallClockMs,
    m.sincePageLoadMs,
    m.gifIndex === 1 ? firstModelLoadMs : 0,
    m.gifIndex === 1 ? firstOcrLoadMs : 0,
    `"${(m.caption || "").replace(/"/g, '""')}"`,
  ].join(","));

  const csv = [csvHeader, ...csvRows].join("\n");

  chrome.runtime.sendMessage({
    type: "SAVE_METRICS",
    format: "csv",
    data: csv,
  });

  console.log("[a11y] Benchmark metrics saved to ~/Downloads/gif-benchmarks/");
}

function isGif(img) {
  const src = img.src.toLowerCase();
  return (
    src.endsWith(".gif") || src.includes("giphy") || src.includes("tenor")
  );
}

function scanAndLabelGIFs() {
  const gifs = Array.from(document.querySelectorAll("img"))
    .filter((img) => isGif(img) && !seen.has(img.src));

  if (gifs.length > 0) {
    totalGifs += gifs.length;
    console.log(`[a11y] Found ${gifs.length} new GIFs (${totalGifs} total)`);
  }

  gifs.forEach(labelGif);
}

scanAndLabelGIFs();

const observer = new MutationObserver(scanAndLabelGIFs);
observer.observe(document.body, { childList: true, subtree: true });
