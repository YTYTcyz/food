const analytics = require('./analytics');
const TOOLS = { woodfish: 'woodfish', diary: 'diary', 'diary-edit': 'diary', reverse: 'reverse', card: 'card' };
function attempt(fn) { try { return fn(); } catch (_) {} }
function context(page) {
  const data = page.data || {};
  return { page: page._analyticsPage || '', orderId: page.orderId || data.orderId || page._analyticsView && page._analyticsView.orderId || page._analyticsActiveOrderId || '',
    flowId: page.analyticsFlowId || data.order && data.order.analytics && data.order.analytics.flowId || '' };
}
function feature(page, featureName, action, properties = {}) {
  attempt(() => analytics.track('brl_feature_action', { feature: featureName, action, ...properties }, context(page)));
}
function observeEntry(page, selector, entryPos) {
  attempt(() => {
    const view = page._analyticsView;
    if (!view) return;
    view.entries[selector] = entryPos;
    if (!view.visible || view.observers[selector] || typeof wx === 'undefined' || !wx.createIntersectionObserver) return;
    const observer = wx.createIntersectionObserver(page, { thresholds: [0, 0.5] });
    view.observers[selector] = observer;
    observer.relativeToViewport().observe(selector, result => {
      if (!view.visible || result.intersectionRatio < 0.5 || view.exposed[selector]) return;
      view.exposed[selector] = true;
      analytics.track('brl_app_entry_view', { entry_pos: entryPos }, context(page));
    });
  });
}
function engage(page, amount = 1) {
  attempt(() => {
    const view = page._analyticsView;
    if (!view || !view.visible || !view.tool) return;
    view.count = Math.min(1000000, view.count + Math.max(1, Number(amount) || 1));
    if (view.engaged) return;
    view.engaged = true;
    view.engagedAt = Date.now();
    analytics.track('brl_tool_engage', { tool: view.tool, phase: 'start', count: 1, entry_source: view.entrySource }, context(page));
  });
}
function instrumentPage(definition, pageName) {
  const hooks = { onLoad: definition.onLoad, onShow: definition.onShow, onHide: definition.onHide, onUnload: definition.onUnload, onTabItemTap: definition.onTabItemTap };
  function setup(page, query = {}) {
    if (page._analyticsView) return page._analyticsView;
    page._analyticsPage = pageName;
    if (pageName === 'order' && query.merchantId) attempt(() => { const cart = require('./cart').getForMerchant(query.merchantId); page.analyticsFlowId = cart && cart.flowId || ''; });
    const view = { page: pageName, orderId: query.orderId || '', tool: TOOLS[pageName], entrySource: query.orderId ? 'challenge' : 'independent', visible: false, count: 0, engaged: false, entries: {}, observers: {}, exposed: {},
      resume() {
        if (view.visible) return;
        view.visible = true; view.start = Date.now(); view.count = 0; view.engaged = false;
        analytics.setView(view);
        analytics.track('brl_page_view', { entry_source: view.entrySource }, context(page));
        Object.keys(view.entries).forEach(selector => observeEntry(page, selector, view.entries[selector]));
        // Entry source describes navigation; an independent tool may still be used
        // during an active challenge. Resolve association without changing its UI.
        if (view.tool && !context(page).orderId && typeof wx !== 'undefined' && wx.cloud && typeof getApp === 'function') {
          const shownAt = view.start;
          attempt(() => Promise.resolve(require('./challenge').reconcile()).then(result => {
            if (view.visible && view.start === shownAt && result.success && result.data && result.data.status === 'waiting') page._analyticsActiveOrderId = result.data._id;
          }).catch(() => {}));
        }
      },
      pause(reason) {
        if (!view.visible) return;
        view.visible = false;
        const duration = Math.max(0, Date.now() - view.start);
        analytics.track('brl_page_leave', { duration_ms: duration, action: reason }, context(page));
        if (view.engaged) analytics.track('brl_tool_engage', { tool: view.tool, phase: 'summary', count: view.count, duration_ms: Math.max(0, Date.now() - view.engagedAt), entry_source: view.entrySource }, context(page));
        Object.values(view.observers).forEach(observer => attempt(() => observer.disconnect()));
        view.observers = {}; view.exposed = {};
        page._analyticsActiveOrderId = '';
      } };
    page._analyticsView = view;
    return view;
  }
  definition.onLoad = function(q = {}) { attempt(() => setup(this, q)); return hooks.onLoad && hooks.onLoad.apply(this, arguments); };
  definition.onShow = function() { attempt(() => setup(this).resume()); return hooks.onShow && hooks.onShow.apply(this, arguments); };
  definition.onHide = function() { attempt(() => { const view = setup(this); view.pause('hide'); analytics.clearView(view); }); return hooks.onHide && hooks.onHide.apply(this, arguments); };
  definition.onUnload = function() {
    attempt(() => { const view = setup(this); view.pause('unload'); analytics.clearView(view);
      if (pageName === 'order' && !this._navigating) analytics.track('brl_order_back', {}, context(this)); });
    return hooks.onUnload && hooks.onUnload.apply(this, arguments);
  };
  definition.onTabItemTap = function() { attempt(() => analytics.track('brl_tab_switch', { tab: pageName }, context(this))); return hooks.onTabItemTap && hooks.onTabItemTap.apply(this, arguments); };
  return definition;
}
module.exports = { instrumentPage, context, engage, feature, observeEntry };
