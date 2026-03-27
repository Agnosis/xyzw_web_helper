'use strict';

/**
 * Parse a game token from the stored token data object.
 *
 * tokenData is one item from the tokens_json array stored in the DB.
 * It has a `token` field which may be:
 *   - A plain JSON string (wxQrcode/bin tokens): {"roleToken":"...","roleId":...}
 *   - A base64-encoded string containing the actual token
 *
 * For JSON tokens, refreshes sessId/connId with new random values
 * to avoid stale session conflicts (matching frontend behavior).
 */
function parseGameToken(tokenData) {
  const tokenField = tokenData.token;
  if (!tokenField) return tokenField;

  // If the token looks like JSON (starts with '{'), it's not base64 encoded
  // Parse it directly without base64 decoding
  if (tokenField.trim().startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(tokenField);
    } catch {
      return tokenField; // Return as-is if not valid JSON
    }

    // For JSON tokens with sessId/connId, refresh those fields (like frontend does)
    if (parsed && typeof parsed === 'object' && (parsed.sessId !== undefined || parsed.connId !== undefined)) {
      const now = Date.now();
      parsed.sessId = now * 100 + Math.floor(Math.random() * 100);
      parsed.connId = now + Math.floor(Math.random() * 10);
      return JSON.stringify(parsed);
    }

    // Has roleToken/gameToken field - return the actual token value
    if (parsed && typeof parsed === 'object' && (parsed.roleToken || parsed.gameToken || parsed.token)) {
      return parsed.roleToken || parsed.gameToken || parsed.token;
    }

    return tokenField;
  }

  // Otherwise try base64 decode only if it looks like base64
  // Base64 strings only contain A-Za-z0-9+/=, if we see other characters, it's not base64
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  if (!base64Regex.test(tokenField)) {
    // Not valid base64 - return as-is (plain string token like wxQrcode)
    return tokenField;
  }

  let decoded;
  try {
    decoded = Buffer.from(tokenField, 'base64').toString('utf-8');
  } catch {
    return tokenField;
  }

  // Try JSON parse of decoded
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    // Decode produced garbage or not JSON - return original token
    return tokenField;
  }

  // For JSON tokens with sessId/connId, refresh those fields
  if (parsed && typeof parsed === 'object' && (parsed.sessId !== undefined || parsed.connId !== undefined)) {
    const now = Date.now();
    parsed.sessId = now * 100 + Math.floor(Math.random() * 100);
    parsed.connId = now + Math.floor(Math.random() * 10);
    return JSON.stringify(parsed);
  }

  // For plain string tokens: get the actual token string
  if (parsed && typeof parsed === 'object') {
    const actualToken = parsed.token || parsed.gameToken || decoded;
    return actualToken;
  }

  // Not valid JSON - return the decoded string
  return decoded;
}

module.exports = { parseGameToken };