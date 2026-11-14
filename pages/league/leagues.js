// ════════════════════════════════════════════════════════════════════════════
// FF Historian — THE league list.
//
// Every standard league page (/{slug}/) loads /league/league.js, which reads its
// own slug from the URL and renders that league from the entry here. The landing
// page builds its cards from this list too, in this order.
//
// Adding a league: add an entry, drop the logo in /assets/, and copy any league's
// /{slug}/index.html into the new folder (every copy is identical).
//
// Fields
//   slug          URL folder — /{slug}/
//   name          full league name;  title  short name for the browser tab
//   cardName      landing-page card text;  h1  banner heading [main, gold part]
//   logo, emoji   banner/card image, and the emoji shown if it fails to load
//   platform      "sleeper" | "espn"  (ESPN seasons come Sleeper-shaped from the worker:
//                 ids are "espn_{espnId}_{season}"; espnKey = worker ESPN_LEAGUES key)
//   format        "dynasty" → FantasyCalc trade market, rookie-draft picks
//                 "redraft" → in-league PPG on trades
//   ownerName     "team" | "user" — what names an owner. Default: team name for
//                 dynasty, Sleeper username for redraft (team names churn yearly)
//   seasons       { year: leagueId }      draftIds  { year: draftId }  (traded picks)
//   hasDivisions  show the Div column / division titles
//   ownershipMerges  [{ legacyUserId, canonicalUserId, seasonTeamNames? }] — one
//                 owner under two ids (took over a roster, or a new account)
//   teamNameAliases  { "Old Name": "New Name" }
// ════════════════════════════════════════════════════════════════════════════

const LEAGUES = [
{
  slug: "2wayinsanity1",
  name: "2 Way Insanity",
  title: "2 Way Insanity",
  cardName: "2 Way Insanity",
  h1: ["2 Way Insanity", "League"],
  logo: "/assets/2wayinsanity1_logo.png", emoji: "🏈",
  platform: "sleeper", format: "dynasty",
  seasons: {
    2024: "1101730133993574400",
    2025: "1180350741063589888",
    2026: "1312024382368940032",
  },
  draftIds: {
    2025: "1180350741063589889",
    2026: "1312024382385692672",
  },
},
{
  slug: "2wayinsanity2",
  name: "2 Way Insanity Part 2",
  title: "2 Way Insanity Part 2",
  cardName: "2 Way Insanity — Part 2",
  h1: ["2 Way Insanity", "Part 2"],
  logo: "/assets/2wayinsanity2_logo.png", emoji: "🏈",
  platform: "sleeper", format: "dynasty",
  seasons: {
    2024: "1110318010365112320",
    2025: "1180911450402676736",
    2026: "1312025056368418816",
  },
  draftIds: {
    2025: "1180911450402676737",
    2026: "1312025056376811520",
  },
},
{
  slug: "bblucky14",
  name: "BB Lucky Number 14",
  title: "BB Lucky Number 14",
  cardName: "BB — Lucky Number 14",
  h1: ["BB Lucky Number 14", "League"],
  logo: "/assets/bblucky14_logo.png", emoji: "🏈",
  platform: "sleeper", format: "dynasty",
  seasons: {
    2024: "1075584351376674816",
    2025: "1180354011195002880",
    2026: "1312026096186691584",
  },
  draftIds: {
    2025: "1180354011195002881",
    2026: "1312026096195096576",
  },
},
{
  slug: "dynasty1point0",
  name: "Dynasty 1.0",
  title: "Dynasty 1.0",
  cardName: "Dynasty 1.0",
  h1: ["Dynasty 1.0", "League"],
  logo: "/assets/dynasty1point0_logo.png", emoji: "👑",
  platform: "sleeper", format: "dynasty",
  seasons: {
    2021: "705560517007220736",
    2022: "784456068611837952",
    2023: "916840226184806400",
    2024: "1048275390650843136",
    2025: "1180201099229753344",
    2026: "1312027006463934464",
  },
  draftIds: {
    2022: "784456068611837953",
    2023: "916840226184806401",
    2024: "1048275390650843137",
    2025: "1180201099229753345",
    2026: "1312027006480699392",
  },
  hasDivisions: true,
},
{
  slug: "fugazi",
  name: "Fugayzi Fugazi It's a Whazy It's a Woozy",
  title: "Fugazi",
  cardName: "Fugayzi Fugazi It's a Whazy It's a Woozy",
  h1: ["Fugayzi Fugazi", "League"],
  logo: "/assets/fugazi_logo.png", emoji: "🎭",
  platform: "sleeper", format: "dynasty",
  seasons: {
    2023: "978332947109507072",
    2024: "1048273428588969984",
    2025: "1180907428861726720",
    2026: "1312027632581234688",
  },
  draftIds: {
    2024: "1048273428588969985",
    2025: "1180907428861726721",
    2026: "1312027632585433088",
  },
},
{
  slug: "lateroundmusic",
  name: "Late Round Music League",
  title: "Late Round Music League",
  cardName: "Late Round Music League",
  h1: ["Late Round Music", "League"],
  logo: "/assets/lateroundmusic_logo.png", emoji: "🎵",
  platform: "sleeper", format: "dynasty",
  seasons: {
    2024: "1046576691310821376",
    2025: "1180356292537638912",
    2026: "1312028256882413568",
  },
  draftIds: {
    2025: "1180356292537638913",
    2026: "1312028256894980096",
  },
},
{
  slug: "ncfl",
  name: "No Cap Football League",
  title: "NCFL",
  cardName: "No Cap Football League",
  h1: ["No Cap Football", "League"],
  logo: "/assets/ncfl_logo.png", emoji: "🏆",
  platform: "sleeper", format: "dynasty",
  seasons: {
    2022: "834179031011287040",
    2023: "917118347102236672",
    2024: "1050188337924902912",
    2025: "1180232430068178944",
    2026: "1312218053051678720",
  },
  draftIds: {
    2023: "917118347102236673",
    2024: "1050188337924902913",
    2025: "1180232430068178945",
    2026: "1312218053064269824",
  },
  hasDivisions: true,
  ownershipMerges: [
    {
      // tantan1 (Arlington XL Boys) → Bsmitty (Henrico Havoc Hogs) — Bsmitty took over the roster in 2024
      legacyUserId:    "834619940182032384",    // tantan1
      canonicalUserId: "1007997964816330752",   // Bsmitty
      seasonTeamNames: {   // display name per season — the team name at the time
        "2022": "Arlington XL Boys", "2023": "Arlington XL Boys",
        "2024": "Henrico Havoc Hogs", "2025": "Henrico Havoc Hogs",
      },
    },
  ],
},
{
  slug: "emmys",
  name: "Better Than The Emmys",
  title: "Better Than The Emmys",
  cardName: "Better Than The Emmys",
  h1: ["Better Than The Emmys", "League"],
  logo: "/assets/emmys_logo.png", emoji: "🏅",
  platform: "sleeper", format: "dynasty",
  seasons: {
    2024: "1048294746617200640",
    2025: "1180352899643494400",
    2026: "1312022658338025472",
  },
  draftIds: {
    2025: "1180352899643494401",
    2026: "1312022658342199296",
  },
},
{
  slug: "souschefs",
  name: "Abandoned Sous-Chefs",
  title: "Abandoned Sous-Chefs",
  cardName: "Abandoned Sous-Chefs",
  h1: ["Abandoned Sous-Chefs", "League"],
  logo: "/assets/chef_logo.png", emoji: "🏅",
  platform: "sleeper", format: "dynasty",
  seasons: {
    2023: "993640003773214720",
    2024: "1054961533534519296",
    2025: "1183080485127286784",
    2026: "1312266744202526721",
  },
  draftIds: {
    2024: "1054961533534519297",
    2025: "1183080485127286785",
    2026: "1312266744206729216",
  },
},
{
  slug: "eastbound",
  name: "Eastbound FFL",
  title: "Eastbound FFL",
  cardName: "Eastbound FFL",
  h1: ["Eastbound", "FFL"],
  logo: "/assets/eastbound_logo.svg", emoji: "🧭",
  platform: "sleeper", format: "redraft",
  seasons: {
    2024: "1115108446031994880",
    2025: "1257452259906695168",
    2026: "1387115849936035840",
  },
  draftIds: {
    2024: "1115108446912880640",
    2025: "1257452259906695169",
    2026: "1387115849948606464",
  },
},
{
  slug: "sickos",
  name: "Carolina Sickos",
  title: "Carolina Sickos",
  cardName: "Carolina Sickos",
  h1: ["Carolina Sickos", "League"],
  logo: "/assets/sickos_logo.png", emoji: "🤢",
  platform: "sleeper", format: "dynasty",
  seasons: {
    2026: "1350954271008358400",
  },
  draftIds: {},
},
{
  slug: "wolfpack",
  name: "Wolfpack of 10",
  title: "Wolfpack of 10",
  cardName: "Wolfpack of 10",
  h1: ["Wolfpack", "of 10"],
  logo: "/assets/wolfpack_logo.svg", emoji: "🐺",
  platform: "espn", format: "redraft", espnKey: "wolfpack",
  seasons: {
    2018: "espn_1656310_2018",
    2019: "espn_1656310_2019",
    2020: "espn_1656310_2020",
    2021: "espn_1656310_2021",
    2022: "espn_1656310_2022",
    2023: "espn_1656310_2023",
    2024: "espn_1656310_2024",
    2025: "espn_1656310_2025",
    2026: "espn_1656310_2026",
  },
  draftIds: {},
  hasDivisions: true,
},
{
  slug: "standrews",
  name: "St. Andrew's Partments",
  title: "St. Andrew's Partments",
  cardName: "St. Andrew's Partments",
  h1: ["St. Andrew's", "Partments"],
  logo: "/assets/standrews_logo.svg", emoji: "🏛️",
  platform: "espn", format: "redraft", espnKey: "standrews",
  seasons: {
    2018: "espn_845744_2018",
    2019: "espn_845744_2019",
    2020: "espn_845744_2020",
    2021: "espn_845744_2021",
    2022: "espn_845744_2022",
    2023: "espn_845744_2023",
    2024: "espn_845744_2024",
    2025: "espn_845744_2025",
    2026: "espn_845744_2026",
  },
  draftIds: {},
  hasDivisions: true,
  ownershipMerges: [
    // Michael Payton moved to a new ESPN account in 2024
    { legacyUserId: "{C15B5E7F-865C-433A-9B5E-7F865C333A1E}", canonicalUserId: "{D309413C-91FA-402F-B820-9FF0CBDC3CF9}" },
  ],
},
];

if (typeof module !== "undefined") module.exports = { LEAGUES };
