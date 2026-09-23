// Target markets. Each market is a set of discovery areas (a Google Maps
// search is centred on each) plus the trade categories worth pitching there.
// Kept in code as defaults; Settings may override `markets` wholesale.

export const DEFAULT_TRADE_CATEGORIES = [
  'HVAC contractor', 'Electrician', 'Flooring contractor', 'Roofing contractor', 'Plumber',
  'Landscaper', 'Kitchen remodeler', 'Painter', 'Concrete contractor', 'Fence contractor',
  'Garage door supplier', 'Tree service',
]

export const DEFAULT_MARKETS = [
  {
    id: 'slc',
    label: 'Salt Lake City',
    enabled: true,
    country: 'US',
    zoom: 13,
    categories: DEFAULT_TRADE_CATEGORIES,
    areas: [
      { name: 'Salt Lake City, UT', latitude: 40.7608, longitude: -111.891 },
      { name: 'West Valley City, UT', latitude: 40.6916, longitude: -112.0011 },
      { name: 'Murray, UT', latitude: 40.6669, longitude: -111.888 },
      { name: 'Sandy, UT', latitude: 40.5649, longitude: -111.8389 },
      { name: 'West Jordan, UT', latitude: 40.6097, longitude: -111.9391 },
      { name: 'South Jordan, UT', latitude: 40.5622, longitude: -111.9297 },
      { name: 'Draper, UT', latitude: 40.5247, longitude: -111.8638 },
      { name: 'Bountiful, UT', latitude: 40.8894, longitude: -111.8808 },
      { name: 'Ogden, UT', latitude: 41.223, longitude: -111.9738 },
      { name: 'Provo, UT', latitude: 40.2338, longitude: -111.6585 },
    ],
  },
  {
    // Outer boroughs and near Long Island: owner-run trades with real review
    // volume. Manhattan is left out on purpose: agency-saturated.
    id: 'nyc',
    label: 'New York City',
    enabled: false,
    country: 'US',
    zoom: 14,
    categories: DEFAULT_TRADE_CATEGORIES,
    areas: [
      { name: 'Queens, NY', latitude: 40.7282, longitude: -73.7949 },
      { name: 'Brooklyn, NY', latitude: 40.6782, longitude: -73.9442 },
      { name: 'Bronx, NY', latitude: 40.8448, longitude: -73.8648 },
      { name: 'Staten Island, NY', latitude: 40.5795, longitude: -74.1502 },
      { name: 'Hempstead, NY', latitude: 40.7062, longitude: -73.6187 },
    ],
  },
]

export function resolveMarkets(settings = {}) {
  const custom = Array.isArray(settings.markets) && settings.markets.length ? settings.markets : null
  return (custom || DEFAULT_MARKETS).map((market) => ({
    ...market,
    categories: Array.isArray(market.categories) && market.categories.length ? market.categories : DEFAULT_TRADE_CATEGORIES,
    areas: Array.isArray(market.areas) ? market.areas : [],
  }))
}

export function findMarket(settings, id) {
  return resolveMarkets(settings).find((market) => market.id === id) || null
}
