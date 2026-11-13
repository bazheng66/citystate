// 小工具：按“原文 → 新文”精确替换，替换次数不对就报错（开发期脚本）
const fs = require("fs");
module.exports = function patch(file, pairs) {
  let s = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  let bad = 0;
  for (const [a, b, n = 1] of pairs) {
    const cnt = s.split(a).length - 1;
    if (cnt !== n) { console.error(`MISMATCH (${cnt} != ${n}): ${a.slice(0, 90)}`); bad++; continue; }
    s = s.split(a).join(b);
  }
  if (bad) { console.error(file + ": " + bad + " failed, not written"); process.exit(1); }
  fs.writeFileSync(file, s);
  console.log(file + ": " + pairs.length + " patches ok");
};
