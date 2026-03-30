const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  mode: "production",
  entry: "./offscreen.js",
  output: {
    filename: "offscreen.bundle.js",
    path: path.resolve(__dirname, "dist"),
  },
  target: "web",
  resolve: {
    extensions: [".js", ".mjs"],
  },
  module: {
    rules: [
      {
        test: /\.m?js$/,
        resolve: { fullySpecified: false },
        type: "javascript/auto",
      },
      {
        test: /offscreen\.js$/,
        type: "javascript/esm",
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "manifest.json", to: "manifest.json" },
        { from: "background.js", to: "background.js" },
        { from: "content.js", to: "content.js" },
        { from: "offscreen.html", to: "offscreen.html" },
        {
          from: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs",
          to: "ort-wasm-simd-threaded.jsep.mjs",
        },
        {
          from: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm",
          to: "ort-wasm-simd-threaded.jsep.wasm",
        },
        // Tesseract OCR files
        {
          from: "node_modules/tesseract.js/dist/worker.min.js",
          to: "tesseract/worker.min.js",
        },
        {
          from: "node_modules/tesseract.js-core/tesseract-core*",
          to: "tesseract/[name][ext]",
        },
        {
          from: "eng.traineddata",
          to: "tesseract/eng.traineddata",
        },
      ],
    }),
  ],
  experiments: {
    asyncWebAssembly: true,
  },
  performance: {
    maxAssetSize: 50 * 1024 * 1024,
    maxEntrypointSize: 50 * 1024 * 1024,
  },
};
