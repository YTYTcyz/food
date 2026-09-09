function node(page, selector) { return new Promise((resolve, reject) => { page.createSelectorQuery().select(selector).fields({ node: true, size: true }).exec(rows => { const item = rows && rows[0]; if (!item || !item.node) reject(new Error('CANVAS_NOT_READY')); else resolve(item); }); }); }
async function localImage(fileID) { if (!fileID.startsWith('cloud://')) return fileID; const r = await wx.cloud.downloadFile({ fileID }); return r.tempFilePath; }
function image(canvas, src) { return new Promise((resolve, reject) => { const item = canvas.createImage(); item.onload = () => resolve(item); item.onerror = reject; item.src = src; }); }
module.exports = { node, localImage, image };

