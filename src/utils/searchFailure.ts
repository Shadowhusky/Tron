/**
 * How an empty web_search result is explained to the agent.
 *
 * The distinction matters more than it looks. When every search backend is
 * rate-limited (verified live: Brave 429, DuckDuckGo 202 "anomaly", Mojeek
 * captcha, Startpage consent wall), the old code reported the same
 * "no results — reformulate your keywords" message it uses for a genuinely
 * empty result set. The agent dutifully reworded the query and re-searched
 * against a dead service, twice, before improvising a direct fetch —
 * 4 wasted turns of the 19 in log 39172cb246.
 */

export type SearchFailure = "blocked" | "empty";

export function describeSearchFailure(query: string, reason: SearchFailure): string {
  if (reason === "blocked") {
    return (
      "Web search is UNAVAILABLE — every search backend is rate-limited or blocked right now. " +
      "This is NOT a problem with your query: reformulating will not help, and you must NOT call web_search again this turn. " +
      `Instead, web_fetch a site that answers "${query}" directly — e.g. https://wttr.in/<city>?format=j1 for weather, ` +
      "the project's official docs URL, or an API endpoint — or answer from what you already know."
    );
  }
  return (
    `Web search for "${query}" returned no results.\n\n` +
    "⚠ Reformulate: use specific keywords (not a full question), try fewer/different terms, " +
    "drop quotes, or add a site: filter. Don't re-run the same query."
  );
}
