// Target markets. Each market is a set of discovery areas (a Google Maps
// search is centred on each) plus the trade categories worth pitching there.
// Kept in code as defaults; Settings may override `markets` wholesale.

export const DEFAULT_TRADE_CATEGORIES = [
  'HVAC contractor', 'Electrician', 'Flooring contractor', 'Roofing contractor', 'Plumber',
  'Landscaper', 'Kitchen remodeler', 'Painter', 'Concrete contractor', 'Fence contractor',
  'Garage door supplier', 'Tree service',
]

const metro = (id, label, timeZone, areas) => ({
  id,
  label,
  timeZone,
  enabled: true,
  country: 'US',
  zoom: 13,
  categories: DEFAULT_TRADE_CATEGORIES,
  areas: areas.map(([name, latitude, longitude]) => ({ name, latitude, longitude })),
})

// The nightly rotation works down this list, one market at a time. Big metros
// list their suburbs and leave out the core, like Manhattan below.
export const DEFAULT_MARKETS = [
  {
    // Searched twice over by October 2026: new businesses fell from 87% of
    // results to about 10%, so the rotation leaves it out.
    id: 'slc',
    label: 'Salt Lake City',
    timeZone: 'America/Denver',
    enabled: false,
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
    timeZone: 'America/New_York',
    enabled: true,
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
  metro('den', 'Denver', 'America/Denver', [
    ['Denver, CO', 39.7392, -104.9903], ['Aurora, CO', 39.7294, -104.8319], ['Lakewood, CO', 39.7047, -105.0814],
    ['Thornton, CO', 39.868, -104.9719], ['Fort Collins, CO', 40.5853, -105.0844], ['Colorado Springs, CO', 38.8339, -104.8214],
  ]),
  metro('phx', 'Phoenix', 'America/Phoenix', [
    ['Phoenix, AZ', 33.4484, -112.074], ['Mesa, AZ', 33.4152, -111.8315], ['Chandler, AZ', 33.3062, -111.8413],
    ['Glendale, AZ', 33.5387, -112.186], ['Scottsdale, AZ', 33.4942, -111.9261], ['Peoria, AZ', 33.5806, -112.2374],
  ]),
  metro('boi', 'Boise', 'America/Boise', [
    ['Boise, ID', 43.615, -116.2023], ['Meridian, ID', 43.6121, -116.3915], ['Nampa, ID', 43.5407, -116.5635],
    ['Caldwell, ID', 43.6629, -116.6874], ['Eagle, ID', 43.6955, -116.354], ['Twin Falls, ID', 42.5558, -114.4701],
  ]),
  metro('las', 'Las Vegas and Reno', 'America/Los_Angeles', [
    ['Las Vegas, NV', 36.1699, -115.1398], ['Henderson, NV', 36.0395, -114.9817], ['North Las Vegas, NV', 36.1989, -115.1175],
    ['Spring Valley, NV', 36.108, -115.245], ['Summerlin South, NV', 36.1383, -115.3256], ['Reno, NV', 39.5296, -119.8138],
  ]),
  metro('dfw', 'Dallas-Fort Worth', 'America/Chicago', [
    ['Fort Worth, TX', 32.7555, -97.3308], ['Arlington, TX', 32.7357, -97.1081], ['Plano, TX', 33.0198, -96.6989],
    ['Garland, TX', 32.9126, -96.6389], ['McKinney, TX', 33.1972, -96.6398], ['Denton, TX', 33.2148, -97.1331],
  ]),
  metro('hou', 'Houston', 'America/Chicago', [
    ['Pasadena, TX', 29.6911, -95.2091], ['Sugar Land, TX', 29.6197, -95.6349], ['Katy, TX', 29.7858, -95.8245],
    ['The Woodlands, TX', 30.1658, -95.4613], ['Pearland, TX', 29.5636, -95.286], ['Humble, TX', 29.9988, -95.2622],
  ]),
  metro('aus', 'Austin', 'America/Chicago', [
    ['Austin, TX', 30.2672, -97.7431], ['Round Rock, TX', 30.5083, -97.6789], ['Cedar Park, TX', 30.5052, -97.8203],
    ['Georgetown, TX', 30.6333, -97.678], ['Pflugerville, TX', 30.4394, -97.62], ['San Marcos, TX', 29.8833, -97.9414],
  ]),
  metro('sat', 'San Antonio', 'America/Chicago', [
    ['San Antonio, TX', 29.4241, -98.4936], ['New Braunfels, TX', 29.703, -98.1245], ['Schertz, TX', 29.5522, -98.2697],
    ['Boerne, TX', 29.7947, -98.732], ['Seguin, TX', 29.5688, -97.9647], ['Converse, TX', 29.518, -98.3161],
  ]),
  metro('okc', 'Oklahoma City and Tulsa', 'America/Chicago', [
    ['Oklahoma City, OK', 35.4676, -97.5164], ['Edmond, OK', 35.6528, -97.4781], ['Norman, OK', 35.2226, -97.4395],
    ['Moore, OK', 35.3395, -97.4867], ['Midwest City, OK', 35.4495, -97.3967], ['Tulsa, OK', 36.154, -95.9928],
  ]),
  metro('mci', 'Kansas City', 'America/Chicago', [
    ['Kansas City, MO', 39.0997, -94.5786], ['Overland Park, KS', 38.9822, -94.6708], ['Olathe, KS', 38.8814, -94.8191],
    ['Independence, MO', 39.0911, -94.4155], ["Lee's Summit, MO", 38.9108, -94.3822], ['Kansas City, KS', 39.1142, -94.6275],
  ]),
  metro('bna', 'Nashville', 'America/Chicago', [
    ['Nashville, TN', 36.1627, -86.7816], ['Franklin, TN', 35.9251, -86.8689], ['Murfreesboro, TN', 35.8456, -86.3903],
    ['Hendersonville, TN', 36.3048, -86.62], ['Clarksville, TN', 36.5298, -87.3595], ['Lebanon, TN', 36.2081, -86.2911],
  ]),
  metro('atl', 'Atlanta', 'America/New_York', [
    ['Marietta, GA', 33.9526, -84.5499], ['Alpharetta, GA', 34.0754, -84.2941], ['Lawrenceville, GA', 33.9562, -83.988],
    ['Kennesaw, GA', 34.0234, -84.6155], ['Peachtree City, GA', 33.3968, -84.5958], ['Decatur, GA', 33.7748, -84.2963],
  ]),
  metro('clt', 'Charlotte', 'America/New_York', [
    ['Charlotte, NC', 35.2271, -80.8431], ['Concord, NC', 35.4088, -80.5795], ['Gastonia, NC', 35.2621, -81.1873],
    ['Huntersville, NC', 35.4107, -80.8429], ['Rock Hill, SC', 34.9249, -81.0251], ['Monroe, NC', 34.9854, -80.5495],
  ]),
  metro('rdu', 'Raleigh-Durham', 'America/New_York', [
    ['Raleigh, NC', 35.7796, -78.6382], ['Durham, NC', 35.994, -78.8986], ['Cary, NC', 35.7915, -78.7811],
    ['Chapel Hill, NC', 35.9132, -79.0558], ['Wake Forest, NC', 35.9799, -78.5097], ['Greensboro, NC', 36.0726, -79.792],
  ]),
  metro('tpa', 'Tampa Bay', 'America/New_York', [
    ['Tampa, FL', 27.9506, -82.4572], ['St. Petersburg, FL', 27.7676, -82.6403], ['Clearwater, FL', 27.9659, -82.8001],
    ['Brandon, FL', 27.9378, -82.2859], ['Lakeland, FL', 28.0395, -81.9498], ['Sarasota, FL', 27.3364, -82.5307],
  ]),
  metro('mco', 'Orlando', 'America/New_York', [
    ['Orlando, FL', 28.5383, -81.3792], ['Kissimmee, FL', 28.292, -81.4076], ['Sanford, FL', 28.8003, -81.2732],
    ['Winter Garden, FL', 28.5653, -81.5862], ['Daytona Beach, FL', 29.2108, -81.0228], ['Melbourne, FL', 28.0836, -80.6081],
  ]),
  metro('jax', 'Jacksonville', 'America/New_York', [
    ['Jacksonville, FL', 30.3322, -81.6557], ['Orange Park, FL', 30.1661, -81.7065], ['St. Augustine, FL', 29.9012, -81.3124],
    ['Fernandina Beach, FL', 30.6697, -81.4626], ['Ponte Vedra Beach, FL', 30.2397, -81.3856], ['Gainesville, FL', 29.6516, -82.3248],
  ]),
  metro('cmh', 'Columbus', 'America/New_York', [
    ['Columbus, OH', 39.9612, -82.9988], ['Dublin, OH', 40.0992, -83.1141], ['Westerville, OH', 40.1262, -82.9291],
    ['Grove City, OH', 39.8815, -83.093], ['Newark, OH', 40.0581, -82.4013], ['Delaware, OH', 40.2987, -83.068],
  ]),
  metro('ind', 'Indianapolis', 'America/Indiana/Indianapolis', [
    ['Indianapolis, IN', 39.7684, -86.1581], ['Carmel, IN', 39.9784, -86.118], ['Fishers, IN', 39.9568, -86.0139],
    ['Greenwood, IN', 39.6137, -86.1067], ['Noblesville, IN', 40.0456, -86.0086], ['Avon, IN', 39.7628, -86.3997],
  ]),
  metro('smf', 'Sacramento', 'America/Los_Angeles', [
    ['Sacramento, CA', 38.5816, -121.4944], ['Elk Grove, CA', 38.4088, -121.3716], ['Roseville, CA', 38.7521, -121.288],
    ['Folsom, CA', 38.678, -121.1761], ['Citrus Heights, CA', 38.7071, -121.2811], ['Stockton, CA', 37.9577, -121.2908],
  ]),
  metro('pdx', 'Portland', 'America/Los_Angeles', [
    ['Portland, OR', 45.5152, -122.6784], ['Beaverton, OR', 45.4871, -122.8037], ['Gresham, OR', 45.5001, -122.4302],
    ['Hillsboro, OR', 45.5229, -122.9898], ['Vancouver, WA', 45.6387, -122.6615], ['Salem, OR', 44.9429, -123.0351],
  ]),
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
