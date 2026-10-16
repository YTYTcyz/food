const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const targets = {
  "shared/domain/analytics-context.js": ["cloudfunctions/challenge/lib/analytics-context.js", "cloudfunctions/personal/lib/analytics-context.js", "cloudfunctions/settleExpiredChallenges/lib/analytics-context.js"],
  "cloudfunctions/challenge/service.js": ["cloudfunctions/settleExpiredChallenges/service.js"],
  "shared/domain/puzzle.js": ["cloudfunctions/challenge/lib/puzzle.js", "cloudfunctions/personal/lib/puzzle.js", "miniprogram/domain/puzzle.js", "cloudfunctions/refreshMemorialPresets/lib/puzzle.js", "cloudfunctions/settleExpiredChallenges/lib/puzzle.js"],
  "shared/domain/product.js": ["cloudfunctions/challenge/lib/product.js", "cloudfunctions/personal/lib/product.js", "miniprogram/domain/product.js", "cloudfunctions/settleExpiredChallenges/lib/product.js"],
  "shared/domain/personal.js": ["cloudfunctions/challenge/lib/personal.js", "cloudfunctions/personal/lib/personal.js", "miniprogram/domain/personal.js", "cloudfunctions/settleExpiredChallenges/lib/personal.js"],
  "shared/domain/rice.js": ["cloudfunctions/merchant/lib/rice.js"],
  "shared/media/image-info.js": ["cloudfunctions/personal/lib/image-info.js", "cloudfunctions/refreshMemorialPresets/lib/image-info.js"],
};
for (const [source, destinations] of Object.entries(targets)) {
  for (const destination of destinations) {
    const target = path.join(root, destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, source), target);
  }
}
console.log("共享规则已同步到小程序和云函数部署目录");
