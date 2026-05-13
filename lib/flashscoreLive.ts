/**
 * Flashscore Live WebSocket - Real-time match updates via WebSocket
 * Connects to Flashscore public WebSocket for push-based live scores
 */

import { EventEmitter } from 'events';

interface FlashscoreMatch {
  id: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  status: 'SCHEDULED' | 'IN_PLAY' | 'PAUSED' | 'FINISHED';
  minute: number | null;
  timestamp: number;
  league: string;
}

let wsInstance: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000;

const liveMatches = new Map<string, FlashscoreMatch>();
const eventEmitter = new EventEmitter();

/**
 * Parse Flashscore WebSocket message for match updates
 * Flashscore uses a specific protocol: message format varies by event type
 */
function parseFlashscoreMessage(msg: string): FlashscoreMatch | null {
  try {
    // Flashscore sends data in format like: "42["UPDATE",{...}]"
    // Extract JSON if present
    const jsonMatch = msg.match(/\{.*\}/);
    if (!jsonMatch) return null;

    const data = JSON.parse(jsonMatch[0]);
    
    // Extract match info from various Flashscore message formats
    const id = data.id || data.eventId || data.matchId;
    if (!id) return null;

    const homeScore = data.homeScore ?? data.home?.score ?? null;
    const awayScore = data.awayScore ?? data.away?.score ?? null;
    const minute = data.minute ?? data.currentMinute ?? null;
    
    // Determine status from minute or explicit status field
    let status: FlashscoreMatch['status'] = 'SCHEDULED';
    if (data.status === 'finished' || data.statusCode === 2) status = 'FINISHED';
    else if (data.status === 'live' || data.statusCode === 1 || (minute !== null && minute > 0)) status = 'IN_PLAY';
    else if (data.status === 'paused' || minute === 45 || minute === 90) status = 'PAUSED';

    // Check if it's a CL or tier-1 league match
    const league = data.league?.name || data.leagueName || '';
    const isCL = league.includes('Champions') || league.includes('UEFA') || data.leagueId === 679;
    if (!isCL && !league.includes('Premier') && !league.includes('Ligue') && !league.includes('Bundesliga')) {
      return null; // Skip non-tier-1 leagues
    }

    return {
      id: String(id),
      homeTeam: data.homeTeam?.name || data.home?.name || 'Home',
      awayTeam: data.awayTeam?.name || data.away?.name || 'Away',
      homeScore,
      awayScore,
      status,
      minute: minute ? Number(minute) : null,
      timestamp: Date.now(),
      league,
    };
  } catch (e) {
    // Ignore parse errors
    return null;
  }
}

/**
 * Connect to Flashscore WebSocket
 * Note: This uses the public WebSocket endpoint; may have limitations
 */
async function connectFlashscoreWebSocket() {
  return new Promise<WebSocket>((resolve, reject) => {
    try {
      // Flashscore uses socket.io protocol on wss://live.flashscore.com/
      const ws = new WebSocket('wss://live.flashscore.com/socket.io/?transport=websocket');

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        console.log('[Flashscore] WebSocket connected');
        reconnectAttempts = 0;

        // Send handshake message
        ws.send('2probe');

        // Subscribe to CL events
        ws.send('42["subscribe","football/championsleague"]');
        ws.send('42["subscribe","football/live"]');

        resolve(ws);
      };

      ws.onerror = (e) => {
        clearTimeout(timeout);
        console.warn('[Flashscore] WebSocket error:', (e as any)?.message?.slice(0, 50));
        reject(e);
      };

      ws.onclose = () => {
        console.log('[Flashscore] WebSocket closed, attempting reconnect');
        wsInstance = null;
        attemptReconnect();
      };

      ws.onmessage = (event: MessageEvent) => {
        const msg = event.data as string;

        // Handle Flashscore protocol messages
        if (msg === '2') {
          ws.send('3'); // Pong response
          return;
        }

        // Try to parse as match update
        const match = parseFlashscoreMessage(msg);
        if (match) {
          liveMatches.set(match.id, match);
          eventEmitter.emit('matchUpdate', match);
        }
      };
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Attempt to reconnect to WebSocket with exponential backoff
 */
function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn('[Flashscore] Max reconnect attempts reached');
    return;
  }

  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempts - 1);

  console.log(`[Flashscore] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay)}ms`);

  setTimeout(() => {
    startFlashscoreLive().catch((e) => {
      console.warn('[Flashscore] Reconnect failed:', (e as any)?.message?.slice(0, 50));
    });
  }, delay);
}

let started = false;

/**
 * Start Flashscore WebSocket connection
 * Runs once per server lifetime
 */
export async function startFlashscoreLive() {
  if (started) return;
  if (wsInstance) return;

  started = true;

  try {
    wsInstance = await connectFlashscoreWebSocket();
  } catch (e) {
    console.warn('[Flashscore] Connection failed, will retry:', (e as any)?.message?.slice(0, 50));
    attemptReconnect();
  }
}

/**
 * Get current live matches from Flashscore
 */
export function getFlashscoreLiveMatches() {
  return Array.from(liveMatches.values());
}

/**
 * Get specific match by ID
 */
export function getFlashscoreMatch(id: string) {
  return liveMatches.get(id);
}

/**
 * Subscribe to match updates (for real-time push)
 */
export function onFlashscoreMatchUpdate(callback: (match: FlashscoreMatch) => void) {
  eventEmitter.on('matchUpdate', callback);
  return () => eventEmitter.off('matchUpdate', callback);
}

/**
 * Convert Flashscore match to standard match object
 */
export function mapFlashscoreMatch(m: FlashscoreMatch, competition = 'CL') {
  return {
    id: `flashscore:${m.id}`,
    status: m.status,
    utcDate: new Date(m.timestamp).toISOString(),
    homeTeam: {
      name: m.homeTeam,
    },
    awayTeam: {
      name: m.awayTeam,
    },
    competition: {
      code: competition,
      name: 'Champions League',
    },
    score: {
      fullTime: {
        home: m.homeScore,
        away: m.awayScore,
      },
    },
    liveDetails:
      m.status === 'IN_PLAY' || m.status === 'PAUSED'
        ? {
            minute: m.minute,
            source: 'flashscore',
            score: {
              home: m.homeScore,
              away: m.awayScore,
            },
          }
        : null,
    liveSource: m.status === 'IN_PLAY' || m.status === 'PAUSED' ? 'flashscore' : undefined,
    source: 'flashscore',
  };
}

export default {};
