// Deployment settings. The publishable key is public by design: the database only exposes RPC
// functions that enforce every rule themselves (see docs/DESIGN.md, decision 2). Never put a
// secret or service-role key here — this file is served to every visitor.
export const SUPABASE_URL = "https://jwktveuzkmihostzpzod.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_ICAqaDZhBUqiK1iX5194UA_DCfNFl03";

// Display only (decision 11). ISO 8601 with offset: Aachen is UTC+2 until 25 Oct 2026, UTC+1 after.
// Set to "REPLACE_ME" to hide the deadline.
export const SUBMISSION_DEADLINE = "2026-10-16T20:00:00+02:00";

// Question text lives here, not in the database, which only knows ids 1–6. `flavour` names the
// topic's colour (css/styles.css, [data-topic]). Each Lindt challenge
// has an analytical stream and an operational enabler; ids are the professor's numbering, so
// they are not sequential within a topic.
export const TOPICS = [
  {
    id: "A",
    flavour: "Caramel",
    title: "TCO and market analysis for e-trucks in logistics",
    questions: [
      { id: 1, stream: "Analytical stream", title: "E-truck TCO & market" },
      { id: 6, stream: "Operational enabler", title: "Circular packaging & reverse logistics" },
    ],
  },
  {
    id: "B",
    flavour: "Raspberry",
    title: "Using data and figures to optimise intercompany product portfolio management and internal product flows",
    questions: [
      { id: 2, stream: "Analytical stream", title: "Portfolio & flow dashboard" },
      { id: 4, stream: "Operational enabler", title: "Cold chain quality & energy" },
    ],
  },
  {
    id: "C",
    flavour: "Pistachio",
    title: "Optimising internal planning of product availability across locations and batch sizing using data and AI",
    questions: [
      { id: 3, stream: "Analytical stream", title: "AI-enabled availability & batch sizing" },
      { id: 5, stream: "Operational enabler", title: "Digital twin of intralogistics" },
    ],
  },
];
