// 拼图覆盖层只划分原图，不改变图片比例；服务端与客户端共用。
const STEPS = 7;
function layoutFor(width, height) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('INVALID_IMAGE_SIZE');
  const long = Math.min(24, Math.max(6, Math.round(6 * Math.max(width, height) / Math.min(width, height))));
  const columns = width >= height ? long : 6, rows = width >= height ? 6 : long;
  return { columns, rows, tileCount: columns * rows };
}
function targetCount(total, step) {
  if (!Number.isInteger(total) || total < 36 || total > 144 || !Number.isInteger(step) || step < 0 || step > STEPS)
    throw new Error('INVALID_CARD_STEP');
  return Math.floor(total * step / STEPS);
}
function revealTiles(previous, step, random, total) {
  const target = targetCount(total, step + 1);
  if (previous.length !== targetCount(total, step) || new Set(previous).size !== previous.length ||
      previous.some(i => !Number.isInteger(i) || i < 0 || i >= total)) throw new Error('INVALID_CARD_TILES');
  const remaining = Array.from({ length: total }, (_, i) => i).filter(i => !previous.includes(i));
  const added = [];
  while (previous.length + added.length < target) added.push(remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
  return { added, all: previous.concat(added) };
}
// 换网格按卡ID和网格尺寸稳定重排，刷新/重复换图不重新抽奖；成功次数不变。
function applyImage(card, width, height) {
  const layout = layoutFor(width, height);
  if (card.gridColumns !== layout.columns || card.gridRows !== layout.rows) {
    let seed = 2166136261;
    for (const c of `${card._id}:${layout.columns}:${layout.rows}`) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    let tiles = [];
    for (let step = 0; step < card.currentStep; step++) tiles = revealTiles(tiles, step, random, layout.tileCount).all;
    card.revealedTileIndexes = tiles;
    card.layoutRevision = (card.layoutRevision || 0) + 1;
  }
  Object.assign(card, { imageWidth: width, imageHeight: height, gridColumns: layout.columns, gridRows: layout.rows, tileCount: layout.tileCount });
  return card;
}
function displaySize(width, height, maxWidth = 622, maxHeight = 900) {
  layoutFor(width, height);
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}
function orientedSize(info) {
  const rotated = /^(left|right)/.test(info.orientation || '');
  return { width: rotated ? info.height : info.width, height: rotated ? info.width : info.height };
}
module.exports = { STEPS, layoutFor, targetCount, revealTiles, applyImage, displaySize, orientedSize };
