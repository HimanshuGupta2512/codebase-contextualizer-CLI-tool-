const path = require("path");
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");

const javascriptParser = new Parser();
javascriptParser.setLanguage(JavaScript);

const parsers = {
  ".cjs": parseJavaScript,
  ".js": parseJavaScript,
  ".jsx": parseJavaScript,
  ".mjs": parseJavaScript,
  ".py": parsePython,
};

function getParser(filePath) {
  return parsers[path.extname(filePath).toLowerCase()];
}

function getNodeName(node) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? nameNode.text : "(anonymous)";
}

function getLeadingComment(node) {
  const previous = node.previousNamedSibling || node.previousSibling;

  if (!previous || previous.type !== "comment") {
    return "";
  }

  return previous.text.trim();
}

function createSemanticText(relativePath, chunk) {
  const parts = [
    `File: ${relativePath}`,
    `Symbol: ${chunk.name}`,
  ];

  if (chunk.commentText) {
    parts.push(`Context: ${chunk.commentText}`);
  }

  parts.push(`Code: ${chunk.code}`);

  return parts.join(" | ");
}

function createChunk(relativePath, code, node) {
  const chunkCode = code.slice(node.startIndex, node.endIndex);
  const commentText = getLeadingComment(node);
  const chunk = {
    name: getNodeName(node),
    type: node.type,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    commentText,
    code: chunkCode,
  };

  return {
    ...chunk,
    semanticText: createSemanticText(relativePath, chunk),
  };
}

function parseJavaScript({ code, relativePath }) {
  const tree = javascriptParser.parse(code);
  const chunks = [];
  const stack = [tree.rootNode];

  while (stack.length > 0) {
    const node = stack.pop();

    if (
      node.type === "function_declaration" ||
      node.type === "class_declaration" ||
      node.type === "method_definition"
    ) {
      chunks.push(createChunk(relativePath, code, node));
    }

    for (let index = node.childCount - 1; index >= 0; index -= 1) {
      stack.push(node.child(index));
    }
  }

  return chunks;
}

function parsePython({ code, relativePath }) {
  const chunks = [];
  const lines = code.split('\n');
  const defPattern = /^(\s*)(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = defPattern.exec(line);

    if (match) {
      const indent = match[1].length;
      const keyword = match[2];
      const name = match[3];
      const startLine = i;

      // Collect body lines that are more indented than the def/class line
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        const isBlank = nextLine.trim() === '';
        const lineIndent = nextLine.match(/^(\s*)/)[1].length;
        if (!isBlank && lineIndent <= indent) break;
        j++;
      }

      const chunkCode = lines.slice(startLine, j).join('\n');

      chunks.push({
        name,
        type: keyword === 'def' ? 'function_definition' : 'class_definition',
        code: chunkCode,
        startLine: startLine + 1,
        endLine: j,
        relativePath,
      });

      // Move to next line, NOT to j — so inner defs are also matched
      i++;
    } else {
      i++;
    }
  }

  return chunks;
}

function parseSourceFile({ filePath, relativePath, code }) {
  const parse = getParser(filePath);

  if (!parse) {
    return {
      supported: false,
      reason: `Unsupported source extension: ${path.extname(filePath).toLowerCase() || "(none)"}`,
      chunks: [],
    };
  }

  return {
    supported: true,
    chunks: parse({
      code,
      relativePath,
    }),
  };
}

module.exports = {
  getParser,
  parseJavaScript,
  parsePython,
  parseSourceFile,
  parsers,
};
