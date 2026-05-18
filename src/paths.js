const path = require("path");

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function toRelativePosixPath(root, target) {
  return toPosixPath(path.relative(root, target));
}

module.exports = {
  toPosixPath,
  toRelativePosixPath,
};
