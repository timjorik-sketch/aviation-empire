// Central definition of all client-side polling intervals (milliseconds).
// Backend loop intervals live in backend/src/config/intervals.js — the two
// runtimes can't share a module, so keep the two files in sync by hand.

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const POLL = {
  // Live flight map. This interval is effectively the map's frame rate: the map
  // redraws only on fetch and does NOT interpolate between polls, so pushing it
  // higher makes planes visibly jump. 45s is the agreed ceiling.
  liveMap: 45 * SECOND,

  // OCC active-flights table — a status list, not an animation.
  occFlights: 60 * SECOND,

  // Airport departure/arrival/airline boards (one merged /board request).
  airportBoards: 90 * SECOND,

  // Aircraft detail page — static info + schedule list, no animation.
  aircraftDetail: 5 * MINUTE,

  // Client feedback list — not time critical.
  clientFeedback: 5 * MINUTE,

  // XP / level poll — lateness only delays the level-up popup.
  xp: 5 * MINUTE,
};