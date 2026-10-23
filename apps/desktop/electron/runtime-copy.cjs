"use strict";

const { cpSync, lstatSync, readdirSync, readlinkSync, realpathSync } = require("node:fs");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");

// Explicitly preserve relative links: nested native cpSync dereference has differed
// across Node/Electron builds (nodejs/node#59168). Verify the resulting tree too.
function copyRuntimeTree(source, destination, options = {}) {
  cpSync(source, destination, { ...options, recursive: true, dereference: false, verbatimSymlinks: true });
}

function verifyPortableRuntimeTree(directory) {
  const root = realpathSync(resolve(directory));
  let files = 0;
  let symlinks = 0;
  const pending = [root];
  while (pending.length) {
    const path = pending.pop();
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const label = relative(root, path);
      const target = readlinkSync(path);
      if (isAbsolute(target)) throw new Error(`运行载荷含绝对符号链接：${label}`);
      let actual;
      try { actual = realpathSync(path); }
      catch (error) { throw new Error(`运行载荷含失效或循环符号链接：${label}`, { cause: error }); }
      const within = relative(root, actual);
      if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
        throw new Error(`运行载荷符号链接越过归档边界：${label}`);
      }
      symlinks += 1;
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path)) pending.push(join(path, name));
    } else if (stat.isFile()) files += 1;
    else throw new Error(`运行载荷含不支持的文件类型：${relative(root, path)}`);
  }
  return { files, symlinks, absoluteOrExternalSymlinks: 0 };
}

module.exports = { copyRuntimeTree, verifyPortableRuntimeTree };
