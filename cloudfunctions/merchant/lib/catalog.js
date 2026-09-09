function queryCatalog(merchants, options = {}) {
  const keyword = String(options.keyword || "").trim().toLowerCase().slice(0, 50);
  const pageSize = Math.min(20, Math.max(1, Math.floor(Number(options.pageSize) || 10)));
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const sorted = merchants.filter((m) => m.isActive && (!options.category || m.category === options.category))
    .filter((m) => !keyword || m.searchText.includes(keyword))
    .sort((a, b) => {
      const primary = options.sort === "rating" ? b.rating - a.rating
        : options.sort === "sales" ? b.monthlySales - a.monthlySales : a.sortOrder - b.sortOrder;
      return primary || a._id.localeCompare(b._id);
    });
  const categories = [...new Map(merchants.filter((m) => m.isActive).map((m) => [m.category, { id: m.category, name: m.categoryName }])).values()];
  return { page, categories, total: sorted.length, hasMore: page * pageSize < sorted.length,
    items: sorted.slice((page - 1) * pageSize, page * pageSize).map((m) => ({
      id: m._id, name: m.name, comment: m.comment, coverFileID: m.coverFileID, category: m.category,
      rating: m.rating, monthlySales: m.monthlySales, tags: m.tags,
      products: keyword && !m.name.toLowerCase().includes(keyword)
        ? m.searchItems.filter((p) => p.name.toLowerCase().includes(keyword)) : m.featuredItems,
    })) };
}
module.exports = { queryCatalog };
