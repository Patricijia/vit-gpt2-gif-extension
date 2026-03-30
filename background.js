// Service worker — manages offscreen document and routes messages.
// All ML inference runs in offscreen.js (full page context with WebGPU).

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "ML model inference with WebGPU",
  });
}

// Pre-create offscreen document so model starts loading immediately
ensureOffscreen();

// Run counter — increments each time a benchmark is saved in this session
let runCounter = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle file download requests from content script
  if (message.type === "SAVE_METRICS") {
    if (message.format === "json") runCounter++;
    const mimeType = message.format === "json" ? "application/json" : "text/csv";
    const dataUrl = `data:${mimeType};base64,${btoa(unescape(encodeURIComponent(message.data)))}`;
    const filename = `vit-gpt2-benchmark-run${runCounter}.${message.format}`;

    chrome.downloads.download({
      url: dataUrl,
      filename: `gif-benchmarks/${filename}`,
      conflictAction: "overwrite",
      saveAs: false,
    }, () => {
      sendResponse({ ok: true, runId: runCounter });
    });

    return true;
  }

  // Route DESCRIBE_GIF from content script → offscreen document
  if (message.type !== "DESCRIBE_GIF") return;
  if (message.target === "offscreen") return;

  console.log("[background] Forwarding DESCRIBE_GIF to offscreen");

  ensureOffscreen()
    .then(() =>
      chrome.runtime.sendMessage({ ...message, target: "offscreen" })
    )
    .then((response) => {
      console.log("[background] Got response from offscreen:", response);
      sendResponse(response);
    })
    .catch((err) => {
      console.error("[background] Error:", err);
      sendResponse({ error: err.message });
    });

  return true;
});
