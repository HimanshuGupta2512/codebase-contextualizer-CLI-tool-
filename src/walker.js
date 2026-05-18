const fs = require("fs/promises");
const path = require("path");
const ignore = require("ignore");
const { throwIfAborted } = require("./abort");
const { CACHE_DIR } = require("./cache");
const {
  MAX_FILE_SIZE,
  getFileSizeSkipReason,
  getSourcePathSkipReason,
  isBinaryExtension,
} = require("./file-filter");
const { toRelativePosixPath, toPosixPath } = require("./paths");

const HARD_IGNORED_DIRS = new Set([".git", "node_modules", CACHE_DIR]);
const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".cxx",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);

async function readGitignore(directory, errors) {
  const gitignorePath = path.join(directory, ".gitignore");

  try {
    const contents = await fs.readFile(gitignorePath, "utf8");
    const matcher = ignore().add(contents.split(/\r?\n/));

    return {
      base: directory,
      matcher,
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      errors.push({
        path: gitignorePath,
        message: error.message,
      });
    }

    return null;
  }
}

function isInside(base, target) {
  const relative = path.relative(base, target);
  return (
    relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isIgnoredByContexts(contexts, target, isDirectory) {
  for (const context of contexts) {
    if (!isInside(context.base, target)) {
      continue;
    }

    const relativePath = toPosixPath(path.relative(context.base, target));
    const candidate = isDirectory ? `${relativePath}/` : relativePath;

    if (context.matcher.ignores(candidate)) {
      return true;
    }
  }

  return false;
}

function isSourceFile(fileName) {
  return SOURCE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function walkSourceFiles(root, options = {}) {
  const files = [];
  const errors = [];
  const visitedDirectories = new Set();

  function addSkippedFile(absolutePath, reason) {
    errors.push({
      path: absolutePath,
      message: `Skipped: ${reason}`,
    });
  }

  async function getDirectoryKey(directory) {
    const realPath = await fs.realpath(directory);
    const stat = await fs.stat(realPath);
    return `${stat.dev}:${stat.ino}:${process.platform === "win32" ? realPath.toLowerCase() : realPath}`;
  }

  async function walkDirectory(directory, contexts) {
    throwIfAborted(options.signal);

    let directoryKey;

    try {
      directoryKey = await getDirectoryKey(directory);
    } catch (error) {
      errors.push({
        path: directory,
        message: error.message,
      });
      return;
    }

    if (visitedDirectories.has(directoryKey)) {
      return;
    }

    visitedDirectories.add(directoryKey);

    const localContext = await readGitignore(directory, errors);
    const activeContexts = localContext ? [...contexts, localContext] : contexts;
    let entries;

    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({
        path: directory,
        message: error.message,
      });
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      throwIfAborted(options.signal);

      const absolutePath = path.join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (HARD_IGNORED_DIRS.has(entry.name) || isIgnoredByContexts(activeContexts, absolutePath, true)) {
          continue;
        }

        await walkDirectory(absolutePath, activeContexts);
        continue;
      }

      if (!entry.isFile() || isIgnoredByContexts(activeContexts, absolutePath, false)) {
        continue;
      }

      if (isBinaryExtension(entry.name) || !isSourceFile(entry.name)) {
        continue;
      }

      const pathSkipReason = getSourcePathSkipReason(entry.name);

      if (pathSkipReason) {
        addSkippedFile(absolutePath, pathSkipReason);
        continue;
      }

      try {
        const stat = await fs.stat(absolutePath);
        const sizeSkipReason = getFileSizeSkipReason(stat.size);

        if (sizeSkipReason) {
          addSkippedFile(absolutePath, sizeSkipReason);
          continue;
        }

        files.push({
          absolutePath,
          relativePath: toRelativePosixPath(root, absolutePath),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch (error) {
        errors.push({
          path: absolutePath,
          message: error.message,
        });
      }
    }
  }

  await walkDirectory(root, []);

  return {
    files,
    errors,
  };
}

module.exports = {
  SOURCE_EXTENSIONS,
  MAX_FILE_SIZE,
  walkSourceFiles,
};
