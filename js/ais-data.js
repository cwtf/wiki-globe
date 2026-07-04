// AIS reference data: MMSI MID -> flag state, ship type codes -> labels,
// and a port gazetteer for resolving free-text AIS destinations. Ports are
// loaded from generated UN/LOCODE data, with the legacy list as a fallback.

const MIDS_URL = "data/maritime-mids.latest.json";
const SHIP_TYPES_URL = "data/ais-ship-types.latest.json";
const PORTS_URL = "data/ports.latest.json";

const MID_FLAGS = {
  201: "Albania", 202: "Andorra", 203: "Austria", 204: "Azores", 205: "Belgium",
  206: "Belarus", 207: "Bulgaria", 208: "Vatican", 209: "Cyprus", 210: "Cyprus",
  211: "Germany", 212: "Cyprus", 213: "Georgia", 214: "Moldova", 215: "Malta",
  216: "Armenia", 218: "Germany", 219: "Denmark", 220: "Denmark", 224: "Spain",
  225: "Spain", 226: "France", 227: "France", 228: "France", 229: "Malta",
  230: "Finland", 231: "Faroe Islands", 232: "United Kingdom", 233: "United Kingdom",
  234: "United Kingdom", 235: "United Kingdom", 236: "Gibraltar", 237: "Greece",
  238: "Croatia", 239: "Greece", 240: "Greece", 241: "Greece", 242: "Morocco",
  243: "Hungary", 244: "Netherlands", 245: "Netherlands", 246: "Netherlands",
  247: "Italy", 248: "Malta", 249: "Malta", 250: "Ireland", 251: "Iceland",
  252: "Liechtenstein", 253: "Luxembourg", 254: "Monaco", 255: "Madeira",
  256: "Malta", 257: "Norway", 258: "Norway", 259: "Norway", 261: "Poland",
  262: "Montenegro", 263: "Portugal", 264: "Romania", 265: "Sweden", 266: "Sweden",
  267: "Slovakia", 268: "San Marino", 269: "Switzerland", 270: "Czechia",
  271: "Türkiye", 272: "Ukraine", 273: "Russia", 274: "North Macedonia",
  275: "Latvia", 276: "Estonia", 277: "Lithuania", 278: "Slovenia", 279: "Serbia",
  301: "Anguilla", 303: "USA (Alaska)", 304: "Antigua & Barbuda", 305: "Antigua & Barbuda",
  306: "Curaçao", 307: "Aruba", 308: "Bahamas", 309: "Bahamas", 310: "Bermuda",
  311: "Bahamas", 312: "Belize", 314: "Barbados", 316: "Canada", 319: "Cayman Islands",
  321: "Costa Rica", 323: "Cuba", 325: "Dominica", 327: "Dominican Republic",
  329: "Guadeloupe", 330: "Grenada", 331: "Greenland", 332: "Guatemala",
  334: "Honduras", 336: "Haiti", 338: "USA", 339: "Jamaica", 341: "St Kitts & Nevis",
  343: "St Lucia", 345: "Mexico", 347: "Martinique", 348: "Montserrat",
  350: "Nicaragua", 351: "Panama", 352: "Panama", 353: "Panama", 354: "Panama",
  355: "Panama", 356: "Panama", 357: "Panama", 358: "Puerto Rico", 359: "El Salvador",
  361: "St Pierre & Miquelon", 362: "Trinidad & Tobago", 364: "Turks & Caicos",
  366: "USA", 367: "USA", 368: "USA", 369: "USA", 370: "Panama", 371: "Panama",
  372: "Panama", 373: "Panama", 374: "Panama", 375: "St Vincent", 376: "St Vincent",
  377: "St Vincent", 378: "British Virgin Is.", 379: "US Virgin Is.",
  401: "Afghanistan", 403: "Saudi Arabia", 405: "Bangladesh", 408: "Bahrain",
  410: "Bhutan", 412: "China", 413: "China", 414: "China", 416: "Taiwan",
  417: "Sri Lanka", 419: "India", 422: "Iran", 423: "Azerbaijan", 425: "Iraq",
  428: "Israel", 431: "Japan", 432: "Japan", 434: "Turkmenistan", 436: "Kazakhstan",
  437: "Uzbekistan", 438: "Jordan", 440: "South Korea", 441: "South Korea",
  443: "Palestine", 445: "North Korea", 447: "Kuwait", 450: "Lebanon",
  451: "Kyrgyzstan", 453: "Macao", 455: "Maldives", 457: "Mongolia", 459: "Nepal",
  461: "Oman", 463: "Pakistan", 466: "Qatar", 468: "Syria", 470: "UAE", 471: "UAE",
  472: "Tajikistan", 473: "Yemen", 475: "Yemen", 477: "Hong Kong", 478: "Bosnia & Herzegovina",
  501: "Adélie Land", 503: "Australia", 506: "Myanmar", 508: "Brunei",
  510: "Micronesia", 511: "Palau", 512: "New Zealand", 514: "Cambodia",
  515: "Cambodia", 516: "Christmas Island", 518: "Cook Islands", 520: "Fiji",
  525: "Indonesia", 529: "Kiribati", 531: "Laos", 533: "Malaysia",
  536: "N. Mariana Is.", 538: "Marshall Islands", 540: "New Caledonia",
  542: "Niue", 544: "Nauru", 546: "French Polynesia", 548: "Philippines",
  553: "Papua New Guinea", 555: "Pitcairn", 557: "Solomon Islands",
  559: "American Samoa", 561: "Samoa", 563: "Singapore", 564: "Singapore",
  565: "Singapore", 566: "Singapore", 567: "Thailand", 570: "Tonga",
  572: "Tuvalu", 574: "Vietnam", 576: "Vanuatu", 577: "Vanuatu", 578: "Wallis & Futuna",
  601: "South Africa", 603: "Angola", 605: "Algeria", 607: "St Paul & Amsterdam",
  608: "Ascension", 609: "Burundi", 610: "Benin", 611: "Botswana",
  612: "Central African Rep.", 613: "Cameroon", 615: "Congo", 616: "Comoros",
  617: "Cape Verde", 618: "Crozet", 619: "Côte d'Ivoire", 620: "Comoros",
  621: "Djibouti", 622: "Egypt", 624: "Ethiopia", 625: "Eritrea", 626: "Gabon",
  627: "Ghana", 629: "Gambia", 630: "Guinea-Bissau", 631: "Equatorial Guinea",
  632: "Guinea", 633: "Burkina Faso", 634: "Kenya", 635: "Kerguelen",
  636: "Liberia", 637: "Liberia", 638: "South Sudan", 642: "Libya",
  644: "Lesotho", 645: "Mauritius", 647: "Madagascar", 649: "Mali",
  650: "Mozambique", 654: "Mauritania", 655: "Malawi", 656: "Niger",
  657: "Nigeria", 659: "Namibia", 660: "Réunion", 661: "Rwanda", 662: "Sudan",
  663: "Senegal", 664: "Seychelles", 665: "St Helena", 666: "Somalia",
  667: "Sierra Leone", 668: "São Tomé", 669: "Eswatini", 670: "Chad",
  671: "Togo", 672: "Tunisia", 674: "Tanzania", 675: "Uganda", 676: "DR Congo",
  677: "Tanzania", 678: "Zambia", 679: "Zimbabwe",
  701: "Argentina", 710: "Brazil", 720: "Bolivia", 725: "Chile", 730: "Colombia",
  735: "Ecuador", 740: "Falkland Is.", 745: "French Guiana", 750: "Guyana",
  755: "Paraguay", 760: "Peru", 765: "Suriname", 770: "Uruguay", 775: "Venezuela",
};

const LEGACY_SHIP_TYPE_RULES = [
  { from: 20, to: 29, label: "Wing-in-ground craft" },
  { from: 30, to: 30, label: "Fishing vessel" },
  { from: 31, to: 32, label: "Towing vessel" },
  { from: 33, to: 33, label: "Dredger" },
  { from: 34, to: 34, label: "Diving ops vessel" },
  { from: 35, to: 35, label: "Military vessel" },
  { from: 36, to: 36, label: "Sailing vessel" },
  { from: 37, to: 37, label: "Pleasure craft" },
  { from: 40, to: 49, label: "High-speed craft" },
  { from: 50, to: 50, label: "Pilot vessel" },
  { from: 51, to: 51, label: "Search & rescue vessel" },
  { from: 52, to: 52, label: "Tug" },
  { from: 53, to: 53, label: "Port tender" },
  { from: 54, to: 54, label: "Anti-pollution vessel" },
  { from: 55, to: 55, label: "Law enforcement vessel" },
  { from: 58, to: 58, label: "Medical transport" },
  { from: 60, to: 69, label: "Passenger ship" },
  { from: 70, to: 79, label: "Cargo ship" },
  { from: 80, to: 89, label: "Tanker" },
];

let midFlags = buildMidMap(Object.entries(MID_FLAGS).map(([mid, flag]) => ({ mid: Number(mid), flag })));
let shipTypeRules = LEGACY_SHIP_TYPE_RULES;
let midDataLoaded = false;
let shipTypeDataLoaded = false;

export async function loadMaritimeReferenceData() {
  const [midsOk, typesOk, portsOk] = await Promise.all([
    loadMidData(),
    loadShipTypeData(),
    loadPortData(),
  ]);
  return midsOk && typesOk && portsOk;
}

export function flagFromMmsi(mmsi) {
  return midFlags.get(Number(String(mmsi).slice(0, 3))) ?? null;
}

export function shipTypeName(code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n === 0) return "Vessel";
  const rule = shipTypeRules.find((r) => n >= r.from && n <= r.to);
  return rule?.label ?? "Vessel";
}

async function loadMidData() {
  if (midDataLoaded) return true;
  try {
    const resp = await fetch(MIDS_URL);
    if (!resp.ok) throw new Error(`maritime mids ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data?.mids)) throw new Error("maritime mids payload missing mids array");
    const nextMidFlags = buildMidMap(data.mids);
    if (nextMidFlags.size < 100) throw new Error("maritime mids payload is unexpectedly small");
    midFlags = nextMidFlags;
    midDataLoaded = true;
    return true;
  } catch (e) {
    console.warn("[ais] generated MID data unavailable, using bundled fallback:", e.message);
    return false;
  }
}

async function loadShipTypeData() {
  if (shipTypeDataLoaded) return true;
  try {
    const resp = await fetch(SHIP_TYPES_URL);
    if (!resp.ok) throw new Error(`ship types ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data?.shipTypes)) throw new Error("ship types payload missing shipTypes array");
    const nextShipTypeRules = normalizeShipTypeRules(data.shipTypes);
    if (nextShipTypeRules.length < 10) throw new Error("ship types payload is unexpectedly small");
    shipTypeRules = nextShipTypeRules;
    shipTypeDataLoaded = true;
    return true;
  } catch (e) {
    console.warn("[ais] generated ship type data unavailable, using bundled fallback:", e.message);
    return false;
  }
}

// [UN/LOCODE, display name, lat, lon] — majors worldwide, dense in the Baltic
// (the keyless Digitraffic live feed covers Baltic waters).
const PORTS = [
  ["FIHEL", "Helsinki", 60.15, 24.96], ["FIKTK", "Kotka", 60.43, 26.95],
  ["FIHMN", "Hamina", 60.56, 27.18], ["FITKU", "Turku", 60.44, 22.22],
  ["FIRAU", "Rauma", 61.13, 21.48], ["FIPOR", "Pori", 61.59, 21.48],
  ["FIOUL", "Oulu", 65.01, 25.43], ["FIKEM", "Kemi", 65.73, 24.52],
  ["FIVAA", "Vaasa", 63.09, 21.57], ["FIHKO", "Hanko", 59.82, 22.97],
  ["FIMHQ", "Mariehamn", 60.09, 19.93], ["FIKOK", "Kokkola", 63.84, 23.12],
  ["FIUKI", "Uusikaupunki", 60.80, 21.41], ["FILOV", "Loviisa", 60.45, 26.24],
  ["FISKV", "Sköldvik", 60.30, 25.55], ["FINLI", "Naantali", 60.45, 22.00],
  ["EETLL", "Tallinn", 59.44, 24.77], ["EEMUG", "Muuga", 59.50, 24.95],
  ["EEPLA", "Paldiski", 59.35, 24.05], ["EESLM", "Sillamäe", 59.42, 27.74],
  ["RULED", "St Petersburg", 59.88, 30.20], ["RUULU", "Ust-Luga", 59.67, 28.41],
  ["RUPRI", "Primorsk", 60.34, 28.71], ["RUKGD", "Kaliningrad", 54.70, 20.40],
  ["RUVYG", "Vyborg", 60.71, 28.73], ["RUVVO", "Vladivostok", 43.10, 131.89],
  ["RUNVS", "Novorossiysk", 44.72, 37.78], ["RUMMK", "Murmansk", 68.97, 33.05],
  ["LVRIX", "Riga", 57.03, 24.08], ["LVVNT", "Ventspils", 57.40, 21.56],
  ["LVLPX", "Liepāja", 56.52, 21.01], ["LTKLJ", "Klaipėda", 55.71, 21.13],
  ["PLGDN", "Gdańsk", 54.40, 18.66], ["PLGDY", "Gdynia", 54.53, 18.55],
  ["PLSZZ", "Szczecin", 53.43, 14.55], ["PLSWI", "Świnoujście", 53.91, 14.25],
  ["DKCPH", "Copenhagen", 55.70, 12.60], ["DKAAR", "Aarhus", 56.15, 10.23],
  ["DKFRC", "Fredericia", 55.56, 9.76], ["DKEBJ", "Esbjerg", 55.47, 8.44],
  ["DKKAL", "Kalundborg", 55.68, 11.09],
  ["SESTO", "Stockholm", 59.32, 18.10], ["SEGOT", "Gothenburg", 57.70, 11.85],
  ["SEMMA", "Malmö", 55.61, 13.03], ["SEHEL", "Helsingborg", 56.04, 12.69],
  ["SENRK", "Norrköping", 58.60, 16.20], ["SEGVX", "Gävle", 60.68, 17.17],
  ["SELLA", "Luleå", 65.55, 22.10], ["SESDL", "Sundsvall", 62.39, 17.35],
  ["SEOXE", "Oxelösund", 58.66, 17.10],
  ["DEHAM", "Hamburg", 53.54, 9.97], ["DEBRV", "Bremerhaven", 53.55, 8.58],
  ["DEWVN", "Wilhelmshaven", 53.60, 8.10], ["DEKEL", "Kiel", 54.32, 10.14],
  ["DELBC", "Lübeck", 53.87, 10.69], ["DETRV", "Travemünde", 53.96, 10.87],
  ["DERSK", "Rostock", 54.15, 12.10],
  ["NLRTM", "Rotterdam", 51.95, 4.05], ["NLAMS", "Amsterdam", 52.41, 4.80],
  ["NLVLI", "Vlissingen", 51.45, 3.60], ["NLEEM", "Eemshaven", 53.45, 6.83],
  ["NLIJM", "IJmuiden", 52.46, 4.59],
  ["BEANR", "Antwerp", 51.28, 4.30], ["BEZEE", "Zeebrugge", 51.34, 3.20],
  ["BEGNE", "Ghent", 51.10, 3.74],
  ["NOOSL", "Oslo", 59.90, 10.74], ["NOBGO", "Bergen", 60.39, 5.31],
  ["NOSVG", "Stavanger", 58.97, 5.73], ["NOTRD", "Trondheim", 63.44, 10.40],
  ["NONVK", "Narvik", 68.43, 17.38],
  ["GBFXT", "Felixstowe", 51.95, 1.31], ["GBSOU", "Southampton", 50.90, -1.43],
  ["GBLGP", "London Gateway", 51.50, 0.49], ["GBLIV", "Liverpool", 53.43, -3.01],
  ["GBIMM", "Immingham", 53.63, -0.19], ["GBTEE", "Teesport", 54.61, -1.16],
  ["GBHUL", "Hull", 53.74, -0.28], ["GBABD", "Aberdeen", 57.14, -2.08],
  ["FRLEH", "Le Havre", 49.48, 0.12], ["FRMRS", "Marseille", 43.31, 5.35],
  ["FRDKK", "Dunkirk", 51.03, 2.20],
  ["ESVLC", "Valencia", 39.44, -0.32], ["ESALG", "Algeciras", 36.13, -5.43],
  ["ESBCN", "Barcelona", 41.35, 2.16], ["ESBIO", "Bilbao", 43.35, -3.03],
  ["ESLPA", "Las Palmas", 28.13, -15.41],
  ["PTLIS", "Lisbon", 38.70, -9.15], ["PTSIE", "Sines", 37.95, -8.87],
  ["ITGOA", "Genoa", 44.40, 8.92], ["ITGIT", "Gioia Tauro", 38.45, 15.90],
  ["ITTRS", "Trieste", 45.62, 13.77], ["ITLIV", "Livorno", 43.55, 10.30],
  ["ITNAP", "Naples", 40.84, 14.26],
  ["GRPIR", "Piraeus", 37.94, 23.62], ["GRSKG", "Thessaloniki", 40.63, 22.93],
  ["TRIST", "Istanbul", 41.00, 28.95], ["TRMER", "Mersin", 36.78, 34.64],
  ["TRIZM", "Izmir", 38.44, 27.15],
  ["MTMLA", "Marsaxlokk", 35.83, 14.54], ["CYLMS", "Limassol", 34.65, 33.01],
  ["EGPSD", "Port Said", 31.26, 32.31], ["EGSUZ", "Suez", 29.94, 32.55],
  ["EGALY", "Alexandria", 31.18, 29.88], ["EGDAM", "Damietta", 31.47, 31.76],
  ["ILHFA", "Haifa", 32.83, 35.00], ["ILASD", "Ashdod", 31.83, 34.64],
  ["MAPTM", "Tanger Med", 35.88, -5.51], ["MACAS", "Casablanca", 33.61, -7.62],
  ["AEJEA", "Jebel Ali", 25.01, 55.06], ["AEAUH", "Abu Dhabi", 24.51, 54.38],
  ["AEKLF", "Khor Fakkan", 25.35, 56.37], ["AEFJR", "Fujairah", 25.17, 56.36],
  ["SAJED", "Jeddah", 21.48, 39.17], ["SADMM", "Dammam", 26.50, 50.20],
  ["QAHMD", "Hamad", 25.01, 51.61], ["KWKWI", "Kuwait", 29.35, 47.93],
  ["OMSLL", "Salalah", 16.95, 54.00], ["OMSOH", "Sohar", 24.50, 56.63],
  ["IQUQR", "Umm Qasr", 30.03, 47.94], ["IRBND", "Bandar Abbas", 27.14, 56.21],
  ["INNSA", "Nhava Sheva", 18.95, 72.95], ["INMUN", "Mundra", 22.74, 69.70],
  ["INMAA", "Chennai", 13.10, 80.30], ["INCCU", "Kolkata", 22.55, 88.31],
  ["INCOK", "Kochi", 9.97, 76.27], ["INVTZ", "Visakhapatnam", 17.69, 83.29],
  ["LKCMB", "Colombo", 6.95, 79.85],
  ["PKKHI", "Karachi", 24.80, 66.97], ["PKBQM", "Port Qasim", 24.77, 67.34],
  ["BDCGP", "Chattogram", 22.31, 91.80], ["MMRGN", "Yangon", 16.78, 96.17],
  ["THLCH", "Laem Chabang", 13.08, 100.89], ["THBKK", "Bangkok", 13.70, 100.57],
  ["VNSGN", "Ho Chi Minh City", 10.77, 106.71], ["VNHPH", "Haiphong", 20.86, 106.68],
  ["VNCMT", "Cai Mep", 10.53, 107.02], ["KHKOS", "Sihanoukville", 10.64, 103.51],
  ["MYPKG", "Port Klang", 3.00, 101.40], ["MYTPP", "Tanjung Pelepas", 1.36, 103.55],
  ["MYPEN", "Penang", 5.42, 100.35], ["MYBTU", "Bintulu", 3.26, 113.97],
  ["SGSIN", "Singapore", 1.26, 103.84],
  ["IDJKT", "Tanjung Priok", -6.10, 106.88], ["IDSUB", "Surabaya", -7.20, 112.73],
  ["IDBPN", "Balikpapan", -1.27, 116.81],
  ["PHMNL", "Manila", 14.60, 120.95], ["PHCEB", "Cebu", 10.30, 123.91],
  ["CNSHA", "Shanghai", 31.34, 121.65], ["CNNGB", "Ningbo", 29.94, 121.84],
  ["CNYTN", "Yantian", 22.58, 114.27], ["CNSHK", "Shekou", 22.48, 113.92],
  ["CNTAO", "Qingdao", 36.07, 120.32], ["CNTXG", "Tianjin", 38.99, 117.79],
  ["CNDLC", "Dalian", 38.93, 121.65], ["CNXMN", "Xiamen", 24.45, 118.07],
  ["CNCAN", "Nansha", 22.76, 113.60], ["CNLYG", "Lianyungang", 34.74, 119.45],
  ["HKHKG", "Hong Kong", 22.30, 114.16],
  ["TWKHH", "Kaohsiung", 22.61, 120.28], ["TWKEL", "Keelung", 25.13, 121.74],
  ["KRPUS", "Busan", 35.10, 129.04], ["KRINC", "Incheon", 37.46, 126.62],
  ["KRUSN", "Ulsan", 35.50, 129.39], ["KRKWY", "Gwangyang", 34.90, 127.70],
  ["JPTYO", "Tokyo", 35.62, 139.79], ["JPYOK", "Yokohama", 35.45, 139.66],
  ["JPNGO", "Nagoya", 35.05, 136.85], ["JPUKB", "Kobe", 34.68, 135.27],
  ["JPOSA", "Osaka", 34.65, 135.43], ["JPCHB", "Chiba", 35.57, 140.07],
  ["AUSYD", "Sydney", -33.97, 151.22], ["AUMEL", "Melbourne", -37.83, 144.93],
  ["AUBNE", "Brisbane", -27.38, 153.17], ["AUFRE", "Fremantle", -32.05, 115.74],
  ["AUPHE", "Port Hedland", -20.31, 118.58], ["AUNTL", "Newcastle", -32.92, 151.78],
  ["AUGLT", "Gladstone", -23.84, 151.25], ["AUADL", "Adelaide", -34.85, 138.50],
  ["NZAKL", "Auckland", -36.84, 174.78], ["NZTRG", "Tauranga", -37.64, 176.18],
  ["NZLYT", "Lyttelton", -43.61, 172.72],
  ["USNYC", "New York", 40.67, -74.05], ["USLAX", "Los Angeles", 33.74, -118.27],
  ["USLGB", "Long Beach", 33.75, -118.21], ["USOAK", "Oakland", 37.80, -122.32],
  ["USSEA", "Seattle", 47.58, -122.35], ["USTIW", "Tacoma", 47.27, -122.41],
  ["USHOU", "Houston", 29.74, -95.10], ["USSAV", "Savannah", 32.13, -81.14],
  ["USCHS", "Charleston", 32.78, -79.92], ["USMIA", "Miami", 25.77, -80.17],
  ["USJAX", "Jacksonville", 30.40, -81.57], ["USORF", "Norfolk", 36.86, -76.33],
  ["USBAL", "Baltimore", 39.26, -76.58], ["USMSY", "New Orleans", 29.94, -90.06],
  ["USPDX", "Portland", 45.59, -122.75], ["USANC", "Anchorage", 61.24, -149.89],
  ["USHNL", "Honolulu", 21.31, -157.87], ["USBOS", "Boston", 42.35, -71.04],
  ["USPHL", "Philadelphia", 39.91, -75.14],
  ["CAVAN", "Vancouver", 49.29, -123.10], ["CAMTR", "Montreal", 45.55, -73.53],
  ["CAHAL", "Halifax", 44.65, -63.57], ["CAPRR", "Prince Rupert", 54.30, -130.32],
  ["MXZLO", "Manzanillo", 19.06, -104.31], ["MXVER", "Veracruz", 19.21, -96.13],
  ["MXATM", "Altamira", 22.48, -97.92], ["MXLZC", "Lázaro Cárdenas", 17.94, -102.18],
  ["PACTB", "Cristóbal", 9.35, -79.90], ["PABLB", "Balboa", 8.96, -79.57],
  ["COCTG", "Cartagena", 10.40, -75.53], ["CLVAP", "Valparaíso", -33.03, -71.62],
  ["CLSAI", "San Antonio", -33.59, -71.61], ["PECLL", "Callao", -12.05, -77.14],
  ["ECGYE", "Guayaquil", -2.28, -79.91],
  ["BRSSZ", "Santos", -23.98, -46.30], ["BRRIO", "Rio de Janeiro", -22.89, -43.18],
  ["BRPNG", "Paranaguá", -25.50, -48.51], ["BRRIG", "Rio Grande", -32.06, -52.09],
  ["BRITJ", "Itajaí", -26.90, -48.66],
  ["ARBUE", "Buenos Aires", -34.58, -58.37], ["UYMVD", "Montevideo", -34.90, -56.21],
  ["ZADUR", "Durban", -29.87, 31.02], ["ZACPT", "Cape Town", -33.91, 18.43],
  ["ZAPLZ", "Gqeberha", -33.96, 25.63], ["ZARCB", "Richards Bay", -28.80, 32.08],
  ["NGAPP", "Apapa", 6.44, 3.36], ["GHTEM", "Tema", 5.63, 0.00],
  ["CIABJ", "Abidjan", 5.30, -4.01], ["SNDKR", "Dakar", 14.68, -17.43],
  ["AOLAD", "Luanda", -8.78, 13.23], ["CMDLA", "Douala", 4.05, 9.68],
  ["KEMBA", "Mombasa", -4.06, 39.65], ["TZDAR", "Dar es Salaam", -6.82, 39.30],
  ["MZMPM", "Maputo", -25.97, 32.57], ["DJJIB", "Djibouti", 11.60, 43.14],
  ["SDPZU", "Port Sudan", 19.61, 37.22], ["MUPLU", "Port Louis", -20.15, 57.49],
  ["MGTOA", "Toamasina", -18.15, 49.42],
  ["UAODS", "Odesa", 46.50, 30.74], ["ROCND", "Constanța", 44.16, 28.65],
  ["BGVAR", "Varna", 43.19, 27.92], ["GEPTI", "Poti", 42.15, 41.67],
  ["ISREY", "Reykjavík", 64.15, -21.93], ["GLGOH", "Nuuk", 64.17, -51.73],
];

let portIndex = buildPortIndex(PORTS.map(legacyPort));
let portDataLoaded = false;

function buildMidMap(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    const mid = Number(row.mid);
    const flag = String(row.flag ?? "").trim();
    if (Number.isInteger(mid) && flag) map.set(mid, flag);
  }
  return map;
}

function normalizeShipTypeRules(rows) {
  return (rows ?? [])
    .map((row) => ({
      from: Number(row.from),
      to: Number(row.to),
      label: String(row.label ?? "").trim(),
    }))
    .filter((row) => Number.isInteger(row.from) && Number.isInteger(row.to) && row.from <= row.to && row.label)
    .sort((a, b) => a.from - b.from || a.to - b.to);
}

export async function loadPortData() {
  if (portDataLoaded) return true;
  try {
    const resp = await fetch(PORTS_URL);
    if (!resp.ok) throw new Error(`ports ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data?.ports)) throw new Error("ports payload missing ports array");
    portIndex = buildPortIndex(data.ports);
    portDataLoaded = true;
    return true;
  } catch (e) {
    console.warn("[ais] generated port data unavailable, using bundled fallback:", e.message);
    return false;
  }
}

// AIS destination fields are free text: "NL RTM", "SGSIN", "ROTTERDAM",
// "RU ULU > NL RTM"… Best-effort resolution against the gazetteer.
export function resolveDestination(dest) {
  if (!dest) return null;
  let d = String(dest).toUpperCase().trim();
  if (!d || d === "UNKNOWN" || d.length < 3) return null;
  if (d.includes(">")) d = d.split(">").pop().trim(); // "FROM > TO" convention

  const compact = normalizeCompact(d);
  const byCode = portIndex.byCode.get(compact);
  if (byCode) return portObj(byCode);

  const dn = normalizeWords(d);
  if (dn.length >= 4) {
    for (const a of portIndex.aliases) {
      if (dn.includes(a.words) || (dn.length >= 5 && a.words.includes(dn))) return portObj(a.port);
    }
  }
  return null;
}

function portObj(p) {
  return { locode: p.locode, name: p.name, lat: p.lat, lon: p.lon };
}

function legacyPort(p) {
  return { locode: p[0], name: p[1], lat: p[2], lon: p[3], aliases: [p[0], p[1]] };
}

function buildPortIndex(ports) {
  const byCode = new Map();
  const aliases = [];
  for (const raw of ports) {
    const port = normalizePort(raw);
    if (!port) continue;
    byCode.set(port.locode, port);
    const aliasSet = new Set([port.locode, port.name, port.nameWoDiacritics, ...(port.aliases ?? [])]);
    for (const alias of aliasSet) {
      const words = normalizeWords(alias);
      if (words.length < 4) continue;
      aliases.push({ words, port });
    }
  }
  aliases.sort((a, b) => b.words.length - a.words.length);
  return { byCode, aliases };
}

function normalizePort(p) {
  const locode = normalizeCompact(p.locode);
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!/^[A-Z]{2}[A-Z0-9]{3}$/.test(locode) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return {
    locode,
    name: String(p.name ?? locode).trim(),
    nameWoDiacritics: p.nameWoDiacritics ? String(p.nameWoDiacritics).trim() : null,
    lat,
    lon,
    aliases: Array.isArray(p.aliases) ? p.aliases : [],
  };
}

function normalizeCompact(s) {
  return stripDiacritics(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeWords(s) {
  return stripDiacritics(s).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function stripDiacritics(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
