const path = require("path");

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_LINE_LENGTH = 20_000;
const MINIFIED_SOURCE_PATTERN = /(?:^|[.-])min\.(?:cjs|js|jsx|mjs|ts|tsx)$/i;
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".app",
  ".avi",
  ".bmp",
  ".class",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".obj",
  ".otf",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".rar",
  ".so",
  ".sqlite",
  ".tar",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".zip",
]);

function isBinaryExtension(fileName) {
  return BINARY_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isMinifiedSourceName(fileName) {
  return MINIFIED_SOURCE_PATTERN.test(fileName);
}

function getFileSizeSkipReason(size) {
  if (size > MAX_FILE_SIZE) {
    return `file is larger than ${MAX_FILE_SIZE} bytes`;
  }

  return null;
}

function getSourcePathSkipReason(fileName) {
  if (isMinifiedSourceName(fileName)) {
    return "minified source file";
  }

  return null;
}

function getContentSkipReason(code) {
  if (code.includes("\0")) {
    return "binary content";
  }

  let currentLineLength = 0;
  let maxLineLength = 0;

  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];

    if (character === "\n" || character === "\r") {
      maxLineLength = Math.max(maxLineLength, currentLineLength);
      currentLineLength = 0;
      continue;
    }

    currentLineLength += 1;
  }

  maxLineLength = Math.max(maxLineLength, currentLineLength);

  if (maxLineLength > MAX_LINE_LENGTH) {
    return `line is longer than ${MAX_LINE_LENGTH} characters`;
  }

  return null;
}

module.exports = {
  BINARY_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_LINE_LENGTH,
  getContentSkipReason,
  getFileSizeSkipReason,
  getSourcePathSkipReason,
  isBinaryExtension,
  isMinifiedSourceName,
};
